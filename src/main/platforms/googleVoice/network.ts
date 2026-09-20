import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { net, session, type Session, type WebContents } from 'electron'
import { configureProxySession, normalizeProxy, proxyAuthMatches, type AccountProxy } from '../../network/accountProxy'
import { createGoogleVoiceSocksBridge, type GoogleVoiceNetworkRoute } from './socksBridge'
export type { GoogleVoiceNetworkRoute } from './socksBridge'

export type GoogleVoiceNetworkCheck = { ip: string; latencyMs: number; checkedAt: number }
const CHECK_URL = 'https://api.ipify.org?format=json'
const CHECK_TIMEOUT_MS = 12_000
const CHECK_MAX_BYTES = 4096
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Bound and validate IPC input before it reaches Chromium or secure storage. */
export function normalizeGoogleVoiceProxy(input: any): AccountProxy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代理设置无效。')
  for (const key of ['enabled', 'hasPassword', 'clearPassword']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('代理设置无效。')
  }
  for (const [key, limit] of [['host', 253], ['username', 256], ['password', 1024], ['protocol', 6]] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > limit || /[\x00-\x1f\x7f]/.test(input[key]))) throw new Error('代理地址、账号或密码格式无效或过长。')
  }
  if (input.port !== undefined && (typeof input.port !== 'number' && typeof input.port !== 'string' || typeof input.port === 'string' && !/^\d{1,5}$/.test(input.port))) throw new Error('代理端口应为 1 至 65535。')
  const enabled = input.enabled === true
  const rawHost = String(input.host || '').trim()
  if ((rawHost.includes('[') || rawHost.includes(']')) && (!/^\[[^\[\]]+\]$/.test(rawHost) || isIP(rawHost.slice(1, -1)) !== 6)) throw new Error('请输入有效的 IPv6 地址，端口需单独填写。')
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const numericPort = Number(input.port || 0)
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) throw new Error('代理端口应为 1 至 65535。')
  // A creation form can keep its default port while system routing is selected.
  // Validate a populated endpoint even when disabled, but don't require a host
  // for an unused default port.
  const hasEndpoint = Boolean(host)
  // Electron's native SOCKS implementation has no username/password support.
  // Voice uses its private CONNECT bridge for SOCKS, while sharing endpoint
  // validation with the existing account network layer.
  const socks = input.protocol === 'socks5'
  const proxy = normalizeProxy({ ...input, host, enabled: enabled || hasEndpoint, ...(socks ? { protocol: 'http', username: '', password: '', hasPassword: false } : {}) })
  if (host && !isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('请输入有效的代理主机地址，不包含协议或路径。')
  if (host && isIP(host) !== 6) {
    // Chromium interprets legacy numeric hosts as IPv4. Never route or send
    // credentials to an endpoint different from the address shown to the user.
    try { if (new URL('http://' + host).hostname !== host) throw new Error() }
    catch { throw new Error('请输入完整且有效的代理主机地址，不使用缩写或特殊数字格式。') }
  }
  if (!socks && proxy.username?.includes(':')) throw new Error('HTTP 和 HTTPS 代理账号不能包含冒号。请核对代理服务提供的账号。')
  if (socks) {
    const username = input.username || '', hasPassword = Boolean(!input.clearPassword && (input.password || input.hasPassword))
    if (Buffer.byteLength(username, 'utf8') > 255 || input.password && Buffer.byteLength(input.password, 'utf8') > 255 || Boolean(username) !== hasPassword) throw new Error('SOCKS5 账号和密码需要同时填写，且各不超过 255 个 UTF-8 字节。')
    return { ...proxy, enabled, protocol: 'socks5', username, hasPassword }
  }
  return { ...proxy, enabled }
}

/** Main-process-only route; never expose the loopback capability to renderers. */
export async function prepareGoogleVoiceNetwork(proxy?: AccountProxy, password = ''): Promise<GoogleVoiceNetworkRoute> {
  const normalized = proxy ? normalizeGoogleVoiceProxy({ ...proxy, password }) : undefined
  if (normalized?.enabled && normalized.protocol === 'socks5') return createGoogleVoiceSocksBridge(normalized, password)
  const route: GoogleVoiceNetworkRoute = { proxy: normalized, password, async close() { route.password = '' } }
  return route
}

/** Auth belongs to this exact window and proxy; never a Google origin challenge. */
export function attachGoogleVoiceProxyAuth(contents: WebContents, proxy: AccountProxy | undefined, password: string): () => void {
  let secret = password, disposed = false, rejected = false
  const configured = proxy ? normalizeGoogleVoiceProxy({ ...proxy, password }) : undefined
  // Electron webContents differs from ClientRequest: the response details are
  // the SECOND parameter. firstAuthAttempt=false means these credentials failed.
  const login = (event: Electron.Event, details: Electron.AuthenticationResponseDetails, info: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (!configured?.enabled || !proxyAuthMatches(configured, info)) return
    event.preventDefault()
    if (disposed || contents.isDestroyed() || rejected || details.firstAuthAttempt !== true) {
      if (details.firstAuthAttempt === false) rejected = true
      callback(); return
    }
    callback(configured.username || '', secret)
  }
  const navigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!disposed && details.isMainFrame === true && details.isSameDocument === false) rejected = false
  }
  const dispose = () => {
    if (disposed) return
    disposed = true; secret = ''
    contents.removeListener('login', login)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('destroyed', dispose)
  }
  if (contents.isDestroyed()) { disposed = true; secret = ''; return dispose }
  contents.on('login', login)
  contents.on('did-start-navigation', navigation)
  contents.once('destroyed', dispose)
  return dispose
}

/** Check the existing window's route without changing it or clearing its cookies. */
export async function checkGoogleVoiceSession(ses: Session, proxy?: AccountProxy, password = ''): Promise<GoogleVoiceNetworkCheck> {
  const configured = proxy ? normalizeGoogleVoiceProxy({ ...proxy, password }) : undefined
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false, authSupplied = false, bytes = 0, body = ''
    let request: Electron.ClientRequest | undefined
    const finish = (error?: string, result?: GoogleVoiceNetworkCheck) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { reject(new Error(error)); request?.abort() }
      else resolve(result!)
    }
    const fail = () => finish('连接检测失败，请检查网络、代理地址和账号密码。')
    const timer = setTimeout(() => finish('连接检测超时，请检查网络、代理地址和账号密码。'), CHECK_TIMEOUT_MS)
    try {
      request = net.request({
        url: CHECK_URL, session: ses, method: 'GET', redirect: 'error', cache: 'no-store',
        // Omit cookies but retain proxy authentication. credentials:'omit' would
        // disable authentication; the session's Google cookies never go here.
        useSessionCookies: false, referrerPolicy: 'no-referrer'
      })
      request.on('login', (info, callback) => {
        if (!settled && !authSupplied && configured && proxyAuthMatches(configured, info)) {
          authSupplied = true; callback(configured.username || '', password)
        } else { callback(); finish('代理认证失败，请核对账号和密码后重新检测。') }
      })
      request.on('redirect', () => finish('出口 IP 检测服务发生跳转，已停止检测。'))
      request.on('error', fail)
      request.on('abort', fail)
      // Electron 44's writable side can emit close immediately after end(),
      // before Chromium delivers proxy auth or the response. The request/error,
      // response/aborted and deadline paths determine completion instead.
      request.on('response', response => {
        response.on('error', fail)
        response.on('aborted', fail)
        if (response.statusCode !== 200) { fail(); return }
        response.on('data', chunk => {
          if (settled) return
          bytes += Buffer.byteLength(chunk)
          if (bytes > CHECK_MAX_BYTES) { finish('出口 IP 检测响应无效，已停止检测。'); return }
          body += chunk.toString()
        })
        response.on('end', () => {
          if (settled) return
          try {
            const ip = JSON.parse(body).ip
            if (typeof ip !== 'string' || !isIP(ip)) throw new Error()
            const checkedAt = Date.now()
            finish(undefined, { ip, latencyMs: Math.max(0, checkedAt - started), checkedAt })
          } catch { finish('出口 IP 检测响应无效，请稍后重试。') }
        })
      })
      request.end()
    } catch { fail() }
  })
}

/** Test supplied settings in an isolated non-persistent session; no direct retry. */
export async function testGoogleVoiceProxy(input: any, password: string): Promise<GoogleVoiceNetworkCheck> {
  const proxy = normalizeGoogleVoiceProxy({ ...input, password })
  if (!proxy.enabled) throw new Error('请先启用并填写代理。')
  const ses = session.fromPartition(`google-voice-proxy-test:${randomUUID()}`, { cache: false })
  let route: GoogleVoiceNetworkRoute | undefined
  try {
    route = await prepareGoogleVoiceNetwork(proxy, password)
    try { await withTimeout(configureProxySession(ses, route.proxy), CHECK_TIMEOUT_MS, '代理设置超时。') }
    catch { throw new Error('代理设置未成功，已停止检测；请检查地址和端口。') }
    return await checkGoogleVoiceSession(ses, route.proxy, route.password)
  } finally {
    // Only the temporary test session is cleaned. Never touch a logged-in window.
    await withTimeout(Promise.allSettled([
      Promise.resolve().then(() => ses.closeAllConnections()),
      Promise.resolve().then(() => ses.clearAuthCache()),
      Promise.resolve().then(() => ses.clearStorageData()),
      Promise.resolve().then(() => route?.close())
    ]), 1500, '临时会话清理超时。').catch(() => undefined)
  }
}
