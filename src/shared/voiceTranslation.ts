export interface VoiceTranslationResult {
  /** Recognized original language; never inserted into the chat composer. */
  text: string
  translation: string
  /** English text is always present, including for Chinese/other-language audio. */
  englishTranslation: string
  audioId: string
  targetLanguage: 'zh-CN'
}

export interface VoiceMessageAudio {
  bytes: Uint8Array
  conversationId: string
  messageId: string
}
