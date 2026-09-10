import type { KeyStorage } from './authStorage'

export interface DraftScope { userId: string; recordId: string; account: string; peer: string }
const key = (scope: DraftScope) => 'translator-signal-draft:' + JSON.stringify([scope.userId, scope.recordId, scope.account, scope.peer.trim()])
export function readDraft(storage: KeyStorage, scope: DraftScope): string { return storage.getItem(key(scope)) || '' }
export function saveDraft(storage: KeyStorage, scope: DraftScope, text: string): void {
  if (text) storage.setItem(key(scope), text)
  else storage.removeItem(key(scope))
}
export function clearSentDraft(storage: KeyStorage, scope: DraftScope, submitted: string): boolean {
  if (readDraft(storage, scope).trim() !== submitted.trim()) return false
  storage.removeItem(key(scope))
  return true
}

interface Message { taskId?: string; account: string; peer: string; timestamp: number; fromMe: boolean; original: string; translated?: string }
export function upsertMessage<T extends Message>(messages: T[], incoming: T): T[] {
  const index = messages.findIndex(message => (message.taskId && incoming.taskId && message.taskId === incoming.taskId)
    || (message.account === incoming.account && message.peer === incoming.peer && message.timestamp === incoming.timestamp && message.fromMe === incoming.fromMe))
  if (index < 0) return [...messages, incoming].slice(-500)
  const next = [...messages]
  // Keep the original text from the task receipt when Signal also emits a sent-message sync.
  next[index] = messages[index].taskId && !incoming.taskId ? messages[index] : { ...messages[index], ...incoming }
  return next
}
