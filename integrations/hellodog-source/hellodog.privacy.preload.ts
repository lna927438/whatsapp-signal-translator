// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';

type Message = { id?: string; conversationId?: string; expireTimer?: number; expirationStartTimestamp?: number | null; isErased?: boolean; deletedForEveryone?: boolean };
const tracked = new Map<string, number>();
export async function recordHelloDogContent(messages: ReadonlyArray<Message>, removed = false): Promise<void> {
  if (process.env.HELLODOG_EMBEDDED !== '1' || process.env.HELLODOG_BRIDGE_ACTIVE !== '1') return;
  const updates = messages.flatMap(message => {
    const expiresAt = removed || message.isErased || message.deletedForEveryone ? 0
      : message.expireTimer && message.expirationStartTimestamp ? message.expirationStartTimestamp + message.expireTimer * 1000 : undefined;
    if (!message.id || !message.conversationId || expiresAt === undefined || (tracked.get(message.id) ?? Infinity) <= expiresAt) return [];
    return [{ id: message.id, conversationId: message.conversationId, expiresAt }];
  });
  for (let offset = 0; offset < updates.length; offset += 100) {
    const batch = updates.slice(offset, offset + 100);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ipcRenderer.invoke('hellodog:content-lifecycle', batch), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('本机消息清理记录保存超时，请重试。')), 15000); })]);
      for (const update of batch) tracked.set(update.id, Math.min(tracked.get(update.id) ?? Infinity, update.expiresAt));
      while (tracked.size > 20000) tracked.delete(tracked.keys().next().value!);
    } finally { clearTimeout(timer); }
  }
}
