/** Bounded status only: never send chat text, recipients, page URLs or errors. */
export interface GoogleVoiceRuntimeHealth {
  phase: 'waiting' | 'ready' | 'error'
  code: 'waiting' | 'ready' | 'editor-unrecognized' | 'message-unrecognized' | 'scan-failed' | 'status-unavailable' |
    'translation-disabled' | 'translations-hidden' | 'manual-mode' | 'preload-failed' | 'runtime-unavailable'
  messageCount: number
}

const codes: readonly GoogleVoiceRuntimeHealth['code'][] = ['waiting', 'ready', 'editor-unrecognized', 'message-unrecognized',
  'scan-failed', 'status-unavailable', 'translation-disabled', 'translations-hidden', 'manual-mode', 'preload-failed', 'runtime-unavailable']

export function parseGoogleVoiceRuntimeHealth(input: unknown): GoogleVoiceRuntimeHealth | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 3 || !Object.keys(value).every(key => ['phase', 'code', 'messageCount'].includes(key)) ||
    !['waiting', 'ready', 'error'].includes(value.phase as string) || !codes.includes(value.code as GoogleVoiceRuntimeHealth['code']) ||
    typeof value.messageCount !== 'number' || !Number.isSafeInteger(value.messageCount) || value.messageCount < 0 || value.messageCount > 10000) return
  return { phase: value.phase as GoogleVoiceRuntimeHealth['phase'], code: value.code as GoogleVoiceRuntimeHealth['code'], messageCount: value.messageCount }
}
