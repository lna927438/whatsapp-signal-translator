export type TranslationChannel = 'deepseek' | 'openai'
export const personalTranslationServiceMessage='旧版个人翻译服务已移除，请重新打开设置后重试。'
export function assertCloudChannelTransport(transport:unknown) {
  if(transport!=='openai')throw new Error(personalTranslationServiceMessage)
}
export function translationChannel(value: unknown): TranslationChannel {
  if (value !== 'deepseek' && value !== 'openai') throw new Error('翻译通道无效。')
  return value
}
export interface TranslationChannelStatus { available: boolean; reason?: string; model?: string; displayName?: string }
export function translationModelLabel(provider: TranslationChannel, status?: TranslationChannelStatus): string {
  const name = provider === 'openai' ? 'OpenAI' : 'DeepSeek'
  return status?.displayName ? `${name} · ${status.displayName}` : name
}
function safeModelName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]{0,119}$/.test(value) ? value : undefined
}
export interface TranslationChannels {
  deepseek: TranslationChannelStatus
  openai: TranslationChannelStatus
  defaultProvider: TranslationChannel
  selectionSupported: boolean
  checked: boolean
}
export function channelsFromHealth(value: any): TranslationChannels {
  const unavailable = '此通道尚未启用，请使用可用通道。'
  const result: TranslationChannels = { deepseek: {available:false,reason:unavailable},openai:{available:false,reason:unavailable},defaultProvider:'deepseek',selectionSupported:false,checked:false }
  if (value?.ok !== true) return result
  result.checked = true
  result.selectionSupported = value?.features?.providerSelection === true
  if (value.defaultTranslationProvider === 'openai' || value.defaultTranslationProvider === 'deepseek') result.defaultProvider = value.defaultTranslationProvider
  if (result.selectionSupported && Array.isArray(value.translationProviders)) {
    for (const name of ['deepseek','openai'] as const) if (value.translationProviders.includes(name)) result[name] = {available:true}
  } else if (Array.isArray(value.routing) && value.routing.length === 1 && value.routing[0]?.provider === 'deepseek') {
    // Existing servers only understand their default channel. Never enable a
    // choice that they would silently ignore, and retain the old wire payload.
    result.deepseek = {available:true}
  }
  for (const provider of ['deepseek','openai'] as const) {
    const detail = value.translationModels?.[provider]
    const model = safeModelName(detail?.model)
    const displayName = safeModelName(detail?.displayName) || model
    if (model) result[provider].model = model
    if (displayName) result[provider].displayName = displayName
  }
  return result
}
