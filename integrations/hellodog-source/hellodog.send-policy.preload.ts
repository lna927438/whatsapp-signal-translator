// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';
import type { MessageModel } from '../models/messages.preload.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';

const enabled = process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1';
let revision = 0;
const failure = (message = '中文发送设置或消息已变化，原消息已保留，请重新发送。') => {
  const error = new Error(message);
  error.name = 'HelloDogSendPreparationError';
  return error;
};

if (enabled) ipcRenderer.on('hellodog:send-policy-invalidate', (_event, id: unknown) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
  // The host may persist the new setting only after this synchronous epoch
  // change. Jobs waiting on translation, uploads or native queues now fail.
  revision++;
  ipcRenderer.send('hellodog:send-policy-invalidated', id);
});

export function captureHelloDogSendPolicy(): number { return revision; }

/** Freeze the translated message before native attachment preparation. Final
 * authorization is read-only; it cannot rewrite text or start paid work. */
export function createHelloDogDispatchGuard(message: MessageModel, conversation: ConversationModel, editTimestamp: number | undefined, capturedRevision: number): () => Promise<() => void> {
  if (!enabled) return async () => () => undefined;
  const id = message.id, conversationId = conversation.id;
  const body = () => editTimestamp ? message.get('editHistory')?.find(item => item.timestamp === editTimestamp)?.body : message.get('body');
  const original = body() || '';
  const current = () => {
    const start = message.get('expirationStartTimestamp'), seconds = message.get('expireTimer');
    if (revision !== capturedRevision || message.id !== id || conversation.id !== conversationId
      || message.get('conversationId') !== conversationId || (body() || '') !== original
      || editTimestamp && !message.get('editHistory')?.some(item => item.timestamp === editTimestamp)
      || message.get('isErased') || message.get('deletedForEveryone')
      || start && seconds && start + seconds * 1000 <= Date.now()) throw failure();
  };
  current();
  return async () => {
    current();
    const start = message.get('expirationStartTimestamp'), seconds = message.get('expireTimer');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        ipcRenderer.invoke('hellodog:translate', { id, conversationId, editTimestamp, direction: 'outgoing', text: original,
          dispatchPolicyOnly: true, expiresAt: start && seconds ? start + seconds * 1000 : undefined }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(failure('发送设置核对超时，原消息已保留，请稍后重试。')), 15000); }),
      ]);
      current();
      if (response?.authorized !== true || response.text !== original) throw failure('发送设置尚未确认，原消息已保留。');
      // Call this again synchronously immediately before native transport.
      // No await is permitted between this check and the transport invocation.
      return current;
    } catch (error) {
      throw error instanceof Error && error.name === 'HelloDogSendPreparationError' ? error : failure('发送设置尚未确认，原消息已保留，请稍后重试。');
    } finally { clearTimeout(timer); }
  };
}
