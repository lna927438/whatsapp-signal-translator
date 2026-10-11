import type { AccountProxy } from './network/accountProxy'
import type { TranslationQuality } from '../shared/translationPolicy'
import type { TranslationChannel } from '../shared/translationChannels'
export type Platform = 'whatsapp' | 'signal' | 'telegram'

// Historical receipt identifiers remain readable; new work always uses the cloud transport.
export type TranslationProviderName = 'openai' | 'deepl' | 'google'

export interface ContactLanguagePreference {
  language?: string
  translationQuality?: TranslationQuality
  name?: string
  updatedAt: number
  source?: 'manual' | 'auto'
}

export interface AccountRecord {
  id: string
  platform: Platform
  label: string
  translationProvider?: TranslationChannel
  signalAccount?: string
  signalEngine?: 'cli' | 'desktop'
  proxy?: AccountProxy
  toolbarCollapsed?: boolean
  translationQuality?: TranslationQuality
  runtimeMode?: 'receiving' | 'paused'
  pinned?: boolean
  tabOrder?: number
  group?: string
  localLanguage?: string
  targetLanguage?: string
  receiveAutoTranslate?: boolean
  sendAutoTranslate?: boolean
  blockChineseSend?: boolean
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
  translationsVisible?: boolean
  historyMode?: 'new' | 'manual' | 'visible'
  zoomFactor?: number
  contactLanguages?: Record<string, ContactLanguagePreference>
  createdAt: number
}

export interface RuntimeSettings {
  translationProvider?: TranslationChannel
  /** Undefined retains the pre-selection protocol for existing servers. */
  providerPreference?: TranslationChannel
  uiLanguage?: 'system' | 'en' | 'zh-CN'
  translationQuality?: TranslationQuality
  localLanguage: string
  targetLanguage: string
  provider: TranslationProviderName
  receiveAutoTranslate: boolean
  sendAutoTranslate: boolean
  blockChineseSend: boolean
  groupTranslate: boolean
  fontSize: number
  translationColor: string
  translationsVisible?: boolean
  historyMode?: 'new' | 'manual' | 'visible'
  previewSend?: boolean
  backTranslation?: boolean
  conversationId?: string
  conversationName?: string
  contactLanguageSource?: 'manual' | 'auto' | 'default'
}

export interface AppSettings extends Omit<RuntimeSettings, 'groupTranslate' | 'fontSize' | 'translationColor' | 'conversationId' | 'conversationName' | 'contactLanguageSource'> {
  workspaceTheme?: 'charcoal' | 'soft'
  accountNavigationPosition?: 'top' | 'side'
  uiLanguage?: 'system' | 'en' | 'zh-CN'
  hideNotificationNames?: boolean
  quickReplies?: string[]
  updateChannel?: 'stable' | 'beta'
  notifications?: 'off' | 'background' | 'always'
  notificationSound?: boolean
  autoStart?: boolean
  startMinimized?: boolean
  closeBehaviorVersion?: number
  closeToTray?: boolean
  cloudRoute?: 'auto' | 'primary' | 'backup'
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
}

export interface TranslationContextItem {
  role: 'incoming' | 'outgoing'
  text: string
}

export interface TranslationRequest {
  /** Immutable selection captured when this logical request is created. */
  providerPreference?: TranslationChannel
  quality?: TranslationQuality
  /** Keep this ID when retrying one logical translation. */
  requestId?: string
  /** Local cache namespace, never sent as an authorization claim. */
  cacheUserId?: string
  /** Local history recovery budget. Never supplied to the provider as usage. */
  historyRetryCount?: number
  historyRetryWindowAt?: number
  historyRetryWindowCount?: number
  text: string
  targetLanguage: string
  sourceLanguage?: string
  accountId?: string
  conversationId?: string
  messageId?: string
  /** Local Signal revision binding; omitted for the original message. */
  signalEditTimestamp?: number
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

export type CharacterLedgerType = 'translation' | 'recharge' | 'adjustment'

export interface CharacterLedgerEntry {
  id: string
  type: CharacterLedgerType
  characters: number
  createdAt: number
  note?: string
  provider?: TranslationProviderName
  accountId?: string
  conversationId?: string
}

export interface UserProfile {
  username: string
  email: string
  planName: string
  totalCharacters: number
  usedCharacters: number
  remainingCharacters: number
  registeredAt: number
  updatedAt: number
  ledger: CharacterLedgerEntry[]
}
