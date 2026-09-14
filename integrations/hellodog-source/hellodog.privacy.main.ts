// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { app, ipcMain, type BrowserWindow } from 'electron';
import { readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';

type Notice = { id: string; conversationId: string; expiresAt: number };
const valid = (value: any): value is Notice => Boolean(value && /^[\w-]{1,100}$/.test(value.id)
  && /^[\w-]{1,100}$/.test(value.conversationId) && Number.isSafeInteger(value.expiresAt) && value.expiresAt >= 0);

// A durable, text-free outbox. The host acknowledges only after persisting its
// tombstone and cleaning local translation copies. Replays are idempotent.
export function attachHelloDogPrivacy(window: BrowserWindow): void {
  if (process.env.HELLODOG_EMBEDDED !== '1' || !process.send) return;
  const path = join(app.getPath('userData'), 'hellodog-content-outbox-v1.json');
  let notices: Record<string, Notice> = {};
  let closed = false;
  const loaded = (async () => {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(value) || !value.every(valid)) throw new Error('Invalid privacy outbox');
      notices = Object.fromEntries(value.map(item => [item.id, item]));
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('本机清理记录无法读取，请修复数据目录后重试。'); }
  })();
  void loaded.catch(() => undefined);
  let chain: Promise<unknown> = loaded;
  const save = async (data: Record<string, Notice>) => {
    const file = await open(path + '.tmp', 'w', 0o600);
    try { await file.writeFile(JSON.stringify(Object.values(data))); await file.sync(); } finally { await file.close(); }
    await rename(path + '.tmp', path);
    notices = data;
  };
  const mutate = (run: (data: Record<string, Notice>) => void) => {
    const work = chain.catch(() => undefined).then(async () => {
      await loaded; // A corrupt journal must not be silently replaced.
      const next = { ...notices }; run(next); await save(next);
    });
    chain = work;
    return work;
  };
  const send = () => {
    const updates = Object.values(notices).slice(0, 100);
    if (!closed && updates.length && process.connected) process.send?.({ channel: 'hellodog', type: 'privacy', updates });
  };
  ipcMain.handle('hellodog:content-lifecycle', async (event, updates: unknown) => {
    if (event.sender.id !== window.webContents.id || !Array.isArray(updates) || updates.length > 100 || !updates.every(valid)) throw new Error('Invalid content lifecycle');
    await mutate(next => {
      for (const update of updates) {
        const old = next[update.id];
        if (!old || update.expiresAt < old.expiresAt) next[update.id] = { id: update.id, conversationId: update.conversationId, expiresAt: update.expiresAt };
      }
    });
    send();
  });
  const receive = (raw: any) => {
    if (raw?.channel !== 'hellodog' || raw.type !== 'privacy-applied' || !Array.isArray(raw.updates) || raw.updates.length > 100 || !raw.updates.every(valid)) return;
    void mutate(next => {
      for (const update of raw.updates as Array<Notice>) if (next[update.id]?.expiresAt === update.expiresAt) delete next[update.id];
    }).then(send).catch(() => undefined);
  };
  process.on('message', receive);
  const timer = setInterval(() => { void loaded.then(send).catch(() => undefined); }, 5000);
  timer.unref();
  window.once('closed', () => { closed = true; clearInterval(timer); process.off('message', receive); ipcMain.removeHandler('hellodog:content-lifecycle'); });
  void loaded.then(send).catch(() => undefined);
}
