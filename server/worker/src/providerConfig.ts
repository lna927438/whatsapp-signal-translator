export interface ProviderEnv {
  TRANSLATION_PROVIDER?: string
  TRANSLATION_FALLBACK_PROVIDER?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL?: string
}

/** Fixed origins prevent accidentally sending credentials to an arbitrary host. */
export function providerConfig(env: ProviderEnv, selectedProvider?: string) {
  const provider = String(selectedProvider || env.TRANSLATION_PROVIDER || 'openai').trim()
  if (provider === 'deepseek') return {
    provider, baseUrl: 'https://api.deepseek.com',
    model: String(env.DEEPSEEK_MODEL || 'deepseek-v4-pro').trim(),
    key: String(env.DEEPSEEK_API_KEY || '').trim()
  }
  if (provider !== 'openai') throw new Error('invalid_translation_provider')
  return { provider, baseUrl: 'https://api.openai.com/v1',
    model: String(env.OPENAI_MODEL || 'gpt-5.6-luna').trim(),
    key: String(env.OPENAI_API_KEY || '').trim() }
}

export type ProviderConfig = ReturnType<typeof providerConfig>

/** Only configured, fixed-origin providers may receive chat text or credentials. */
export function providerPlan(env: ProviderEnv): ProviderConfig[] {
  const primary = providerConfig(env)
  const backup = String(env.TRANSLATION_FALLBACK_PROVIDER || '').trim()
  if (!backup || backup === primary.provider) return [primary]
  return [primary, providerConfig(env, backup)]
}
