export interface VoiceTranslationResult {
  /** Recognized original language; never inserted into the chat composer. */
  text: string
  translation: string
  audioId: string
  targetLanguage: 'zh-CN'
}

export interface VoiceMessageAudio {
  bytes: Uint8Array
  conversationId: string
  messageId: string
}
