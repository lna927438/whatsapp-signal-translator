import { randomUUID } from 'node:crypto'

export type TokenSource = string | ((force?: boolean, rejectedToken?: string) => string | Promise<string>)
export class SessionUnavailableError extends Error {}
type Identity = { userId: string; accessToken?: string } | null

/** JWT expiry is only a refresh hint. The API still verifies every credential. */
export function tokenExpiresSoon(token: string, now = Date.now()): boolean {
  try { const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); return Number.isFinite(value.exp) && value.exp * 1000 <= now + 60000 }
  catch { return false }
}

export class SessionRefresh {
  private pending?: { id: string; owner: string; work: Promise<void>; finish: (ok: boolean) => void }
  constructor(private current: () => Identity, private notify: (request: { id: string; userId: string }) => void, private timeout = 12000) {}
  changed() { if (this.pending && this.current()?.userId !== this.pending.owner) this.pending.finish(false) }
  complete(id: string, ok: boolean) { if (id === this.pending?.id) this.pending.finish(ok) }
  async token(owner: string, force = false, rejectedToken?: string): Promise<string> {
    const identity = this.current()
    if (!owner || identity?.userId !== owner || !identity.accessToken) throw new SessionUnavailableError('登录状态已变化，请重新登录。草稿已保留。')
    if (rejectedToken && rejectedToken !== identity.accessToken) force = false
    if (!force && !tokenExpiresSoon(identity.accessToken)) return identity.accessToken
    if (this.pending?.owner !== owner) this.pending?.finish(false)
    if (!this.pending) {
      const id = randomUUID()
      let finish!: (ok: boolean) => void
      const work = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(false), this.timeout)
        finish = ok => { clearTimeout(timer); if (this.pending?.id === id) this.pending = undefined; ok ? resolve() : reject(new SessionUnavailableError('暂时无法恢复在线登录，请检查网络或重新登录。草稿已保留。')) }
      })
      this.pending = { id, owner, work, finish }
      try { this.notify({ id, userId: owner }) } catch { finish(false) }
      await work
    } else await this.pending.work
    const refreshed = this.current()
    if (refreshed?.userId !== owner || !refreshed.accessToken || tokenExpiresSoon(refreshed.accessToken)
      || force && refreshed.accessToken === identity.accessToken) throw new SessionUnavailableError('在线登录尚未恢复，请重新登录。草稿已保留。')
    return refreshed.accessToken
  }
}

/** Retry authentication once, keeping the original request body and idempotency key. */
export async function authenticatedFetch(source: TokenSource, url: string, init: RequestInit, timeout: number): Promise<Response> {
  const deadline = Date.now() + Math.max(1, timeout)
  const readToken = async (force: boolean, rejected?: string) => {
    try { return (typeof source === 'function' ? await source(force, rejected) : source).trim() }
    catch (error) { throw error instanceof SessionUnavailableError ? error : new SessionUnavailableError(error instanceof Error ? error.message : '登录状态尚未恢复，草稿已保留。') }
  }
  let token = await readToken(false)
  if (!token) throw new SessionUnavailableError('在线登录令牌缺失，请重新登录。')
  const send = () => {
    if (Date.now() >= deadline) throw new Error('服务请求超时，原请求和草稿已保留。')
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
  }
  const response = await send()
  if (response.status !== 401 || typeof source !== 'function') return response
  const refreshed = await readToken(true, token)
  if (!refreshed || refreshed === token) return response
  await response.body?.cancel().catch(() => {})
  token = refreshed
  return send()
}
