export type Platform = 'whatsapp' | 'signal'

export type TranslationProviderName = 'openai' | 'deepl' | 'google'

export interface ContactLanguagePreference {
  language: string
  name?: string
  updatedAt: number
  source?: 'manual' | 'auto'
}

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
  contactLanguages?: Record<string, ContactLanguagePreference>
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
  conversationId?: string
  conversationName?: string
  contactLanguageSource?: 'manual' | 'auto' | 'default'
}

export interface ProviderSettings {
  openaiApiKey?: string
  openaiModel?: string
  deeplApiKey?: string
  googleApiKey?: string
}

export interface AppSettings extends Omit<RuntimeSettings, 'groupTranslate' | 'fontSize' | 'translationColor' | 'conversationId' | 'conversationName' | 'contactLanguageSource'>, ProviderSettings {
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
}

export interface TranslationContextItem {
  role: 'incoming' | 'outgoing'
  text: string
}

export interface TranslationRequest {
  text: string
  targetLanguage: string
  sourceLanguage?: string
  accountId?: string
  conversationId?: string
  messageId?: string
  context?: TranslationContextItem[]
}

export interface TranslationMetrics {
  totalRequests: number
  providerCalls: number
  cacheHits: number
  dedupHits: number
  translatedCharacters: number
  activeRequests: number
  queueDepth: number
  lastLatencyMs: number
  averageLatencyMs: number
  lastProvider?: TranslationProviderName
  lastError?: string
  lastUpdatedAt: number
}
