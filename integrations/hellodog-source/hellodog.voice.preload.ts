// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { loadAttachmentData } from '../util/migrations.preload.ts';
import { AttachmentDownloadManager } from '../jobs/AttachmentDownloadManager.preload.ts';
import { AttachmentDownloadUrgency } from '../types/AttachmentDownload.std.ts';
import { AttachmentDownloadSource } from '../sql/Interface.std.ts';
import { getSelectedConversationId } from '../state/selectors/nav.std.ts';
import { voiceAudioWav } from './hellodog.voice-audio.std.ts';
import { createSignalVoiceUi, type SignalVoiceItem } from './hellodog.voice.dom.ts';

// Signal fills in digest/plaintextHash and the local path while downloading.
// Keep the UI action attached to its initial message slot, but retain every
// cryptographic value once observed so a real replacement cancels that action.
const attachmentAnchors = new WeakMap<object, Map<number, {
  id: string; digest?: string; plaintextHash?: string; clientUuid?: string;
  contentType: string; size: number; generation: number;
}>>();

/** Read only metadata owned by Signal's current MessageCache. Never accept a
 * path, key, URL or message body from page events or the host process. */
function attachments(id: string) {
  const message = window.MessageCache?.getById(id);
  if (!message || message.get('isErased') || message.get('deletedForEveryone') || message.get('isViewOnce')) return [];
  const start = message.get('expirationStartTimestamp'), seconds = message.get('expireTimer');
  const expiresAt = start && seconds ? start + seconds * 1000 : undefined;
  if ((expiresAt ?? Infinity) <= Date.now()) return [];
  return (message.get('attachments') || []).flatMap((attachment, index) => {
    if (!String(attachment.contentType).startsWith('audio/')) return [];
    // Downloading adds a local path and plaintext hash. Neither may change the
    // identity of an encrypted attachment while its explicit action is pending.
    const mediaIdentity = attachment.digest ? ['digest', attachment.digest]
      : attachment.clientUuid ? ['uuid', attachment.clientUuid, attachment.cdnKey]
      : attachment.cdnKey ? ['cdn', attachment.cdnNumber, attachment.cdnKey]
      : ['local', attachment.plaintextHash, attachment.path];
    const anchors = attachmentAnchors.get(message) || new Map();
    attachmentAnchors.set(message, anchors);
    let anchor = anchors.get(index);
    const replaced = anchor && (anchor.contentType !== attachment.contentType || anchor.size !== attachment.size
      || anchor.digest && anchor.digest !== attachment.digest
      || anchor.plaintextHash && anchor.plaintextHash !== attachment.plaintextHash
      || anchor.clientUuid && anchor.clientUuid !== attachment.clientUuid);
    if (!anchor || replaced) {
      const generation = anchor ? anchor.generation + 1 : 0;
      anchor = { id: createHash('sha256').update(JSON.stringify([index, mediaIdentity, attachment.contentType, attachment.size, generation])).digest('hex'),
        digest: attachment.digest, plaintextHash: attachment.plaintextHash, clientUuid: attachment.clientUuid,
        contentType: attachment.contentType, size: attachment.size, generation };
      anchors.set(index, anchor);
    } else {
      anchor.digest ||= attachment.digest;
      anchor.plaintextHash ||= attachment.plaintextHash;
      anchor.clientUuid ||= attachment.clientUuid;
    }
    const attachmentId = anchor.id;
    const item: SignalVoiceItem = { id, conversationId: message.get('conversationId'), attachmentId, expiresAt,
      ready: Boolean((attachment.path || attachment.data) && !attachment.pending && !attachment.error && !attachment.isCorrupted) };
    return [{ item, attachment, message, index }];
  });
}

/** Use Signal's own per-attachment download queue. This does not open a file
 * picker, play the message, or hand attachment locations to the parent app. */
async function readyAttachment(item: SignalVoiceItem, current: () => boolean) {
  const find = () => attachments(item.id).find(value => value.item.attachmentId === item.attachmentId);
  let owned = find();
  if (!current() || !owned || !Number.isFinite(owned.attachment.size) || owned.attachment.size <= 0
    || owned.attachment.size > 20 * 1024 * 1024 || owned.attachment.isCorrupted) throw new Error('unavailable attachment');
  if (owned.item.ready) return owned;
  // Signal's native queue locates attachments by their cryptographic signature.
  // Refuse an unidentifiable item rather than loading an unrelated attachment.
  if (!owned.attachment.digest && !owned.attachment.plaintextHash) throw new Error('unavailable attachment');
  const deadline = Date.now() + 45000;
  let queued = false, queueError = false;
  if (owned.attachment.pending) queued = true;
  else void AttachmentDownloadManager.addJob({
    attachment: owned.attachment, attachmentType: 'attachment', isManualDownload: true,
    messageId: item.id, receivedAt: owned.message.get('received_at'), sentAt: owned.message.get('sent_at'),
    source: AttachmentDownloadSource.STANDARD, urgency: AttachmentDownloadUrgency.IMMEDIATE,
  }).then(() => { queued = true; }, () => { queueError = true; });
  for (;;) {
    if (!current()) throw new Error('message changed');
    owned = find();
    if (!owned || owned.attachment.isCorrupted || queueError) throw new Error('unavailable attachment');
    if (queued && owned.item.ready) return owned;
    if (Date.now() >= deadline) throw new Error('voice loading timeout');
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  }
}
export function startHelloDogVoiceMessages(): void {
  if (process.env.HELLODOG_EMBEDDED !== '1' || process.env.HELLODOG_BRIDGE_ACTIVE !== '1') return;
  const ui = createSignalVoiceUi({ document, items: id => attachments(id).map(value => value.item),
    selectedConversation: () => { const state = window.reduxStore?.getState(); return state ? getSelectedConversationId(state) : undefined; },
    translate: async (item, current) => {
      const owned = await readyAttachment(item, current);
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const loaded = await (async () => {
        try { return await Promise.race([loadAttachmentData(owned.attachment), new Promise<never>((_, reject) => {
          readTimer = setTimeout(() => reject(new Error('voice reading timeout')), 45000);
        })]); } finally { clearTimeout(readTimer); }
      })();
      if (!current() || loaded.data.byteLength > 20 * 1024 * 1024) throw new Error('unavailable attachment');
      // Keep the .22 receipt identity, using completed metadata rather than the
      // temporary UI anchor. A newly downloaded legacy attachment then has the
      // same identity after restart, while existing ready attachments can reuse
      // their receipts. As before, relocating a local attachment changes its ID.
      const requestAttachmentId = createHash('sha256').update(JSON.stringify([
        owned.index, owned.attachment.clientUuid, owned.attachment.plaintextHash,
        owned.attachment.digest, owned.attachment.path, owned.attachment.size,
      ])).digest('hex');
      const blob = new Blob([new Uint8Array(loaded.data)], { type: owned.attachment.contentType });
      const url = URL.createObjectURL(blob);
      try {
        const bytes = await voiceAudioWav(url);
        if (!current()) throw new Error('message changed');
        const { ready: _ready, ...request } = item;
        return await ipcRenderer.invoke('hellodog:voice', { ...request, attachmentId: requestAttachmentId, audioBase64: Buffer.from(bytes).toString('base64') });
      } finally { URL.revokeObjectURL(url); }
    } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; ui.scan(); }, 200); };
  const observer = new MutationObserver(records => { if (records.some(record => !(record.target as Element).closest?.('[data-hellodog-ui]'))) schedule(); });
  const start = () => { observer.observe(document.body, { subtree: true, childList: true }); ui.scan(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  const interval = setInterval(() => { if (document.visibilityState !== 'hidden') ui.scan(); }, 1500);
  ipcRenderer.on('hellodog:refresh', () => ui.reset());
  window.addEventListener('unload', () => { observer.disconnect(); clearTimeout(timer); clearInterval(interval); ui.dispose(); }, { once: true });
}
