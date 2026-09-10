export interface ProviderEnv {
  TRANSLATION_PROVIDER?: string
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL?: string
}

/** Fixed origins prevent accidentally sending credentials to an arbitrary host. */
export function providerConfig(env: ProviderEnv) {
  const provider = String(env.TRANSLATION_PROVIDER || 'openai').trim()
  if (provider === 'deepseek') return {
    provider, baseUrl: 'https://api.deepseek.com',
    model: String(env.DEEPSEEK_MODEL || 'deepseek-flash').trim(),
    key: String(env.DEEPSEEK_API_KEY || '').trim()
  }
  if (provider !== 'openai') throw new Error('invalid_translation_provider')
  return { provider, baseUrl: 'https://api.openai.com/v1',
    model: String(env.OPENAI_MODEL || 'gpt-5.6-luna').trim(),
    key: String(env.OPENAI_API_KEY || '').trim() }
}
