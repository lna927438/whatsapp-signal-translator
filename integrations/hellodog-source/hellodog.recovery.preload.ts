// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Only used before the native transport is entered. An unavailable translation
 * must not enter Signal's day-long network retry loop or hold later messages. */
export async function prepareHelloDogSend(
  translate: () => Promise<void>,
  fail: (error: Error) => Promise<void>,
  erased: () => boolean
): Promise<boolean> {
  try { await translate(); return !erased(); }
  catch (error) {
    if (!erased()) await fail(error instanceof Error ? error : new Error('翻译未完成，消息未发送。'));
    return false;
  }
}

export async function refreshHelloDogPage(handlers: {
  busy: () => boolean;
  flushDrafts: () => Promise<void>;
  refreshTranslations: () => void;
  checkConnection: () => void;
}): Promise<'reload' | 'synchronized'> {
  await handlers.flushDrafts();
  handlers.refreshTranslations();
  // Native sends, draft media, recordings and calls keep their current runtime.
  // Reconnecting checks the original queue; it never creates a replacement job.
  if (handlers.busy()) { handlers.checkConnection(); return 'synchronized'; }
  return 'reload';
}
