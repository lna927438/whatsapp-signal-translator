export type GoogleVoiceRuntimeMessage = {
  v: 1
  type: string
  payload?: unknown
}
export function installGoogleVoiceRuntime(options: {
  sendRequest: (message: GoogleVoiceRuntimeMessage) => Promise<unknown>
  onHealth?: (value: { phase: 'waiting' | 'ready' | 'error'; code: 'waiting' | 'ready' | 'editor-unrecognized' | 'message-unrecognized' | 'scan-failed' | 'status-unavailable' | 'translations-hidden' | 'translation-disabled' | 'manual-mode'; messageCount: number }) => void
  subscribe?: (listener: (message: unknown, reply?: (value: unknown) => void) => void) => () => void
}): { dispose: () => void; invalidate: () => void } | null
