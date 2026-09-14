export interface SignalConversationPreference {
  archived?: boolean
  pinned?: boolean
  mutedUntil?: number
  color?: string
  lastReadAt?: number
  markedUnread?: boolean
}
export interface SignalFolder { id: string; name: string; peers: string[] }
export interface SignalPreferences {
  theme: 'dark' | 'light' | 'system'
  textSize: number
  enterSends: boolean
  notifications: 'inherit' | 'off' | 'always'
  sound: boolean
  hideNames: boolean
  readReceipts: boolean
  typingIndicators: boolean
  keepArchived: boolean
  folders: SignalFolder[]
  conversations: Record<string, SignalConversationPreference>
}
export const signalPreferenceDefaults: SignalPreferences = {
  theme: 'dark', textSize: 14, enterSends: true, notifications: 'inherit', sound: false, hideNames: false,
  readReceipts: false, typingIndicators: false, keepArchived: false, folders: [], conversations: {}
}
export function signalPreferencePatch(value: any): Partial<SignalPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效。')
  const out: any = {}
  for (const key of ['enterSends', 'sound', 'hideNames', 'readReceipts', 'typingIndicators', 'keepArchived']) {
    if (value[key] !== undefined) { if (typeof value[key] !== 'boolean') throw new Error('设置值无效。'); out[key] = value[key] }
  }
  for (const [key, choices] of Object.entries({ theme: ['dark','light','system'], notifications: ['inherit','off','always'] })) {
    if (value[key] !== undefined) { if (!choices.includes(value[key])) throw new Error('设置值无效。'); out[key] = value[key] }
  }
  if (value.textSize !== undefined) { if (![12,14,16,18,20].includes(value.textSize)) throw new Error('字号无效。'); out.textSize = value.textSize }
  return out
}
export function signalConversationPatch(value: any): SignalConversationPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话设置无效。')
  const out: SignalConversationPreference = {}
  for (const key of ['archived','pinned','markedUnread'] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw new Error('对话设置无效。'); out[key] = value[key]
  }
  for (const key of ['mutedUntil','lastReadAt'] as const) if (value[key] !== undefined) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('时间无效。'); out[key] = value[key]
  }
  if (value.color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error('颜色无效。'); out.color = value.color }
  return out
}
