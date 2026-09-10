export type CloudRoute = 'auto' | 'primary' | 'backup'
export const CLOUD_ROUTES = [
  { id: 'primary', label: '主线路', base: 'https://api.hellodog.net' },
  { id: 'backup', label: '备用线路', base: 'https://realtime-translator-api.lna927438.workers.dev' }
] as const
let route: CloudRoute = 'auto'
export function setCloudRoute(value: unknown): CloudRoute {
  route = value === 'primary' || value === 'backup' ? value : 'auto'
  return route
}
export function cloudBases(): string[] {
  return CLOUD_ROUTES.filter(item => route === 'auto' || item.id === route).map(item => item.base)
}

/** Read-only requests may fail over. Application errors must never change routes. */
export async function cloudRead(path: string, token?: string): Promise<any> {
  const bases = cloudBases()
  for (let i = 0; i < bases.length; i++) {
    let response: Response, payload: any
    try {
      response = await fetch(`${bases[i]}${path}`, {
        signal: AbortSignal.timeout(10000),
        headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' }
      })
      payload = await response.json()
    } catch {
      if (i + 1 < bases.length) continue
      throw new Error('暂时无法连接服务。请检查网络，或切换线路后重试。')
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('登录已失效，请重新登录。')
      if (response.status === 403) throw new Error(payload?.error === 'account_disabled' ? '账号已停用，请联系管理员。' : '当前账号没有访问权限。')
      if (response.status >= 500 && !payload?.error && i + 1 < bases.length) continue
      throw new Error(String(payload?.message || `服务暂时不可用 (${response.status})`))
    }
    return payload
  }
}

export async function measureCloudRoutes() {
  return Promise.all(CLOUD_ROUTES.map(async item => {
    const start = performance.now()
    try {
      const response = await fetch(`${item.base}/health`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
      const payload: any = await response.json()
      if (!response.ok || payload?.ok !== true) throw new Error('unavailable')
      return { id: item.id, label: item.label, available: true, latencyMs: Math.round(performance.now() - start), checkedAt: Date.now() }
    } catch { return { id: item.id, label: item.label, available: false, latencyMs: null, checkedAt: Date.now() } }
  }))
}
