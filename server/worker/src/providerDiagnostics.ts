import { providerConfig, type ProviderEnv } from './providerConfig'
export type ProviderCode = 'provider_auth' | 'provider_quota' | 'provider_model' | 'provider_permission' | 'provider_request' | 'provider_rate_limit' | 'provider_timeout' | 'provider_unavailable' | 'provider_empty'

export class ProviderFailure extends Error {
  constructor(readonly code: ProviderCode, readonly upstreamStatus?: number) { super(code) }
}

/** Never forward provider messages, which can contain credential fragments. */
export function classifyProviderFailure(status: number, payload: any): ProviderFailure {
  const code = String(payload?.error?.code || payload?.error?.type || '')
  if (status === 401 || code === 'invalid_api_key') return new ProviderFailure('provider_auth', status)
  if (status === 402) return new ProviderFailure('provider_quota', status)
  if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(code)) return new ProviderFailure('provider_quota', status)
  if (status === 404 || code === 'model_not_found') return new ProviderFailure('provider_model', status)
  if (status === 403) return new ProviderFailure('provider_permission', status)
  if (status === 429) return new ProviderFailure('provider_rate_limit', status)
  if (status === 400 || status === 422) return new ProviderFailure('provider_request', status)
  return new ProviderFailure('provider_unavailable', status)
}

export const providerMessages: Record<ProviderCode, string> = {
  provider_auth: '翻译服务端凭据无效或已失效，请管理员更新服务端配置。本次未扣减字符。',
  provider_quota: '翻译服务的 API 额度不足或已达到用量上限，请管理员检查 API 账单。本次未扣减字符。',
  provider_model: '翻译服务当前项目无法访问配置的模型，请管理员核对模型权限。本次未扣减字符。',
  provider_permission: '翻译服务凭据缺少调用权限，请管理员检查项目和密钥权限。本次未扣减字符。',
  provider_request: '翻译服务的请求参数不被当前模型接受，请管理员修复调用配置。本次未扣减字符。',
  provider_rate_limit: '翻译服务暂时限流，请稍后重新测试。本次未扣减字符。',
  provider_timeout: '翻译服务响应超时，原请求不会自动重复调用。本次未扣减字符。',
  provider_unavailable: '翻译服务暂时不可用，请稍后重新测试。本次未扣减字符。',
  provider_empty: '翻译服务没有返回有效译文，请稍后重新测试。本次未扣减字符。'
}

export interface ProviderReadiness { status: 'available' | 'attention' | 'unverified'; code?: ProviderCode; model: string; provider: string; checkedAt: string; latencyMs: number; inferenceTested: false }
const readiness = new WeakMap<ProviderEnv, { expires: number; pending: Promise<ProviderReadiness> }>()

/** Advisory, non-billable model-metadata check. Does not claim inference/quota success. */
export function checkProviderReadiness(env: ProviderEnv): Promise<ProviderReadiness> {
  const existing = readiness.get(env)
  if (existing && existing.expires > Date.now()) return existing.pending
  const pending = (async (): Promise<ProviderReadiness> => {
    const started = Date.now()
    const { model, key, provider, baseUrl } = providerConfig(env)
    const result = (status: ProviderReadiness['status'], code?: ProviderCode): ProviderReadiness => ({ status, code, model, provider,
      checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, inferenceTested: false })
    if (!key) return result('attention', 'provider_auth')
    try {
      const response = await fetch(`${baseUrl}/models${provider === 'deepseek' ? '' : '/' + encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000)
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = classifyProviderFailure(response.status, payload)
        // A key restricted to Responses may not grant Models Read. Only a real
        // authenticated translation test can establish its inference permission.
        return result(error.code === 'provider_permission' ? 'unverified' : 'attention', error.code)
      }
      const found = provider === 'deepseek' ? Array.isArray(payload?.data) && payload.data.some((item: any) => item?.id === model) : payload?.id === model
      return found ? result('available') : result('unverified', 'provider_model')
    } catch (error: any) {
      return result('unverified', error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'provider_timeout' : 'provider_unavailable')
    }
  })()
  readiness.set(env, { expires: Date.now() + 60000, pending })
  return pending
}
