export type Platform = 'whatsapp' | 'signal'

export type TranslationProviderName = 'openai' | 'deepl' | 'google'

export interface AccountRecord {
  id: string
  platform: Platform
  label: string
  signalAccount?: string
  localLanguage?: string
  targetLanguage?: string
  receiveAutoTranslate?: boolean
  sendAutoTranslate?: boolean
  blockChineseSend?: boolean
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
  createdAt: number
}

export interface RuntimeSettings {
  localLanguage: string
  targetLanguage: string
  provider: TranslationProviderName
  receiveAutoTranslate: boolean
  sendAutoTranslate: boolean
  blockChineseSend: boolean
  groupTranslate: boolean
  fontSize: number
  translationColor: string
}

export interface ProviderSettings {
  openaiApiKey?: string
  openaiModel?: string
  deeplApiKey?: string
  googleApiKey?: string
}

export interface AppSettings extends Omit<RuntimeSettings, 'groupTranslate' | 'fontSize' | 'translationColor'>, ProviderSettings {
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
}

export interface TranslationRequest {
  text: string
  targetLanguage: string
  sourceLanguage?: string
}
