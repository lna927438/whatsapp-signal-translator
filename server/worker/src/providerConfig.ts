export interface ProviderEnv {
  TRANSLATION_PROVIDER?: string
  TRANSLATION_FALLBACK_PROVIDER?: string
  TRANSLATION_SELECTABLE_PROVIDERS?: string
  OPENAI_TRIAL_USER_IDS?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL?: string
}

/** Fixed origins prevent accidentally sending credentials to an arbitrary host. */
export function providerConfig(env: ProviderEnv, selectedProvider?: string) {
  const provider = String(selectedProvider || env.TRANSLATION_PROVIDER || 'openai').trim()
  if (provider === 'deepseek') return {
    provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com',
    model: String(env.DEEPSEEK_MODEL || 'deepseek-v4-pro').trim(),
    key: String(env.DEEPSEEK_API_KEY || '').trim()
  }
  if (provider !== 'openai') throw new Error('invalid_translation_provider')
  return { provider: 'openai' as const, baseUrl: 'https://api.openai.com/v1',
    model: String(env.OPENAI_MODEL || 'gpt-5.6-luna').trim(),
    key: String(env.OPENAI_API_KEY || '').trim() }
}

export type ProviderConfig = ReturnType<typeof providerConfig>
export type TranslationProvider = 'openai' | 'deepseek'

/** An explicit trial list is an authorization boundary, including when invalid.
 * Public metadata has no verified user and must never advertise a trial route. */
function providerAllowed(env: ProviderEnv, provider: TranslationProvider, userId?: string): boolean {
  if (provider !== 'openai' || env.OPENAI_TRIAL_USER_IDS === undefined) return true
  const value = env.OPENAI_TRIAL_USER_IDS
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000 || !userId) return false
  const ids = value.split(',').map(id => id.trim().toLowerCase())
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  return ids.length <= 100 && ids.every(id => uuid.test(id)) && ids.includes(userId.toLowerCase())
}

/** Publish configured API model IDs, never credentials or invented model labels. */
export function translationModelInfo(env: ProviderEnv, provider: TranslationProvider) {
  const { model } = providerConfig(env, provider)
  const safe = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)
    && !/^sk-/i.test(model) && model !== env.OPENAI_API_KEY?.trim() && model !== env.DEEPSEEK_API_KEY?.trim()
  return { model: safe ? model : '', displayName: safe ? model : '' }
}

/** An unused secret alone never enables a retired channel. */
export function selectableProviders(env: ProviderEnv, userId?: string): TranslationProvider[] {
  const configured = env.TRANSLATION_SELECTABLE_PROVIDERS === undefined
    ? providerPlan(env, userId).map(item => item.provider)
    : env.TRANSLATION_SELECTABLE_PROVIDERS.split(',').map(item => item.trim())
  return (['deepseek', 'openai'] as const).filter(name => providerAllowed(env, name, userId) && configured.includes(name) && Boolean(providerConfig(env, name).key) && Boolean(translationModelInfo(env, name).model))
}

export function providerCapabilities(env: ProviderEnv, userId?: string) {
  const translationProviders = selectableProviders(env, userId)
  const preferred = providerConfig(env).provider as TranslationProvider
  return { translationProviders, defaultTranslationProvider: translationProviders.includes(preferred) ? preferred : translationProviders[0] || null,
    translationModels: { deepseek: translationModelInfo(env, 'deepseek'), openai: translationModelInfo(env, 'openai') } }
}

/** A user choice is one route, never implicit permission to use another API. */
export function requestProviderPlan(env: ProviderEnv, preference?: TranslationProvider, userId?: string): ProviderConfig[] {
  if (!preference) {
    const plan = providerPlan(env, userId)
    if (!plan.length) throw new Error('provider_not_available')
    return plan
  }
  if (!selectableProviders(env, userId).includes(preference)) throw new Error('provider_not_available')
  return [providerConfig(env, preference)]
}

/** Only configured, fixed-origin providers may receive chat text or credentials. */
export function providerPlan(env: ProviderEnv, userId?: string): ProviderConfig[] {
  const primary = providerConfig(env)
  const backup = String(env.TRANSLATION_FALLBACK_PROVIDER || '').trim()
  const plan = !backup || backup === primary.provider ? [primary] : [primary, providerConfig(env, backup)]
  return plan.filter(config => providerAllowed(env, config.provider, userId))
}
