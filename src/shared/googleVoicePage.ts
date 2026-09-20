/** Page location only. This never claims that Google or cloud translation is available. */
export type GoogleVoicePage = 'unknown' | 'messages' | 'voice' | 'sign-in' | 'access-help' | 'help' | 'product'
export const googleVoicePages: readonly GoogleVoicePage[] = ['unknown', 'messages', 'voice', 'sign-in', 'access-help', 'help', 'product']
