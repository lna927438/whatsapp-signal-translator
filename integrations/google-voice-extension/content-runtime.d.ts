export type GoogleVoiceRuntimeMessage = {
  v: 1
  type: string
  payload?: unknown
}
export function installGoogleVoiceRuntime(options: {
  sendRequest: (message: GoogleVoiceRuntimeMessage) => Promise<unknown>
  subscribe?: (listener: (message: unknown, reply?: (value: unknown) => void) => void) => () => void
}): { dispose: () => void; invalidate: () => void } | null
