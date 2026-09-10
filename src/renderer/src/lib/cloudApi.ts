import { requireSupabase } from './supabase'

const API_BASE = 'https://realtime-translator-api.lna927438.workers.dev'

async function token(): Promise<string> {
  const { data, error } = await requireSupabase().auth.getSession()
  if (error) throw error
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('在线登录状态已失效，请重新登录。')
  return accessToken
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await token()
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  })
  const payload: any = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) throw new Error('登录状态需要重新确认，请检查网络或重新登录。')
    if (response.status === 403 && payload?.error === 'account_disabled') throw new Error('账号已停用。')
    throw new Error(String(payload?.message || `云端 API 请求失败 (${response.status})`))
  }
  return payload as T
}

export const cloudApi = {
  me: () => request<any>('/api/me'),
  wallet: () => request<any>('/api/wallet'),
  usage: () => request<any>('/api/usage')
}
