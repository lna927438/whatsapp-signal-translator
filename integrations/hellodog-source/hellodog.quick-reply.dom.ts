// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
export type QuickReplyDetail = { conversationId: string; text: string; accepted?: boolean };
type Editor = { conversationId: string | null; editable: boolean; empty: boolean; insert: (text: string) => void };

/** The native controlled editor remains the owner of text, emoji and draft updates. */
export function installHelloDogQuickReply(target: EventTarget, read: () => Editor): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<QuickReplyDetail>).detail;
    const editor = read();
    if (!detail || detail.accepted || typeof detail.text !== 'string' || !detail.text.trim() || detail.text.length > 2000
      || detail.conversationId !== editor.conversationId || !editor.editable || !editor.empty) return;
    editor.insert(detail.text);
    detail.accepted = true;
  };
  target.addEventListener('hellodog-insert-draft', handler);
  return () => target.removeEventListener('hellodog-insert-draft', handler);
}
