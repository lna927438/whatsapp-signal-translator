// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { loadAttachmentData } from '../util/migrations.preload.ts';
import { getSelectedConversationId } from '../state/selectors/nav.std.ts';
import { voiceAudioWav } from './hellodog.voice-audio.std.ts';
import { createSignalVoiceUi, type SignalVoiceItem } from './hellodog.voice.dom.ts';

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
    const attachmentId = createHash('sha256').update(JSON.stringify([index, attachment.clientUuid, attachment.plaintextHash, attachment.digest, attachment.path, attachment.size])).digest('hex');
    const item: SignalVoiceItem = { id, conversationId: message.get('conversationId'), attachmentId, expiresAt,
      ready: Boolean((attachment.path || attachment.data) && !attachment.pending && !attachment.error && !attachment.isCorrupted) };
    return [{ item, attachment }];
  });
}
export function startHelloDogVoiceMessages(): void {
  if (process.env.HELLODOG_EMBEDDED !== '1' || process.env.HELLODOG_BRIDGE_ACTIVE !== '1') return;
  const ui = createSignalVoiceUi({ document, items: id => attachments(id).map(value => value.item),
    selectedConversation: () => { const state = window.reduxStore?.getState(); return state ? getSelectedConversationId(state) : undefined; },
    translate: async (item, current) => {
      const owned = attachments(item.id).find(value => value.item.attachmentId === item.attachmentId);
      if (!owned?.item.ready || !current() || owned.attachment.size > 20 * 1024 * 1024) throw new Error('unavailable attachment');
      const loaded = await loadAttachmentData(owned.attachment);
      if (!current() || loaded.data.byteLength > 20 * 1024 * 1024) throw new Error('unavailable attachment');
      const blob = new Blob([new Uint8Array(loaded.data)], { type: owned.attachment.contentType });
      const url = URL.createObjectURL(blob);
      try {
        const bytes = await voiceAudioWav(url);
        if (!current()) throw new Error('message changed');
        const { ready: _ready, ...request } = item;
        return await ipcRenderer.invoke('hellodog:voice', { ...request, audioBase64: Buffer.from(bytes).toString('base64') });
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
