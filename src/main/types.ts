export type Platform = 'whatsapp' | 'signal'

export interface AccountRecord {
  id: string
  platform: Platform
  label: string
  signalAccount?: string
  createdAt: number
}

export type TranslationProviderName = 'openai' | 'deepl' | 'google'

export interface RuntimeSettings {
  localLanguage: string
  targetLanguage: string
  provider: TranslationProviderName
  receiveAutoTranslate: boolean
  sendAutoTranslate: boolean
}

export interface ProviderSettings {
  openaiApiKey?: string
  openaiModel?: string
  deeplApiKey?: string
  googleApiKey?: string
}

export interface AppSettings extends RuntimeSettings, ProviderSettings {}

export interface TranslationRequest {
  text: string
  targetLanguage: string
  sourceLanguage?: string
}
