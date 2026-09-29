import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { net, session, type Session, type WebContents } from 'electron'
import { configureProxySession, normalizeProxy, proxyAuthMatches, type AccountProxy } from '../../network/accountProxy'
import { createGoogleVoiceSocksBridge, type GoogleVoiceNetworkRoute } from './socksBridge'
import { isOfficialGoogleAccountsHost } from './googleAccountDomains'
import type { GoogleVoiceNetworkCheck, GoogleVoiceNetworkProbe, GoogleVoiceProbeCode, GoogleVoiceProbeName } from '../../../shared/googleVoiceNetwork'
export type { GoogleVoiceNetworkRoute } from './socksBridge'
export type { GoogleVoiceNetworkCheck } from '../../../shared/googleVoiceNetwork'

// Test the public account-service entry, not the authentication transaction.
// Cookie-free Electron requests to /ServiceLogin can return 401 even while a
// normal browser can open the sign-in page. A verified first-hop redirect from
// the service root proves network reachability without claiming a valid login.
const CHECK_URLS = { exitIp: 'https://api.ipify.org?format=json', voice: 'https://voice.google.com/u/0/', signIn: 'https://accounts.google.com/' } as const
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

interface CheckOptions { signal?: AbortSignal; route?: GoogleVoiceNetworkRoute }
function allowedDiagnosticRedirect(value: string): boolean {
  try {
    const url = new URL(value), authority = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(value)
    return !url.username && !url.password && !url.port && authority?.[1].toLowerCase() === url.hostname &&
      (['voice.google.com', 'support.google.com', 'workspace.google.com'].includes(url.hostname) || isOfficialGoogleAccountsHost(url.hostname))
  } catch { return false }
}

function checkEndpoint(ses: Session, name: GoogleVoiceProbeName, configured: AccountProxy | undefined, password: string, options: CheckOptions): Promise<{ probe: GoogleVoiceNetworkProbe; ip?: string }> {
  const started = Date.now(), host = new URL(CHECK_URLS[name]).hostname
  return new Promise(resolve => {
    let settled = false, authSupplied = false, bytes = 0, body = '', httpStatus: number | undefined
    let request: Electron.ClientRequest | undefined
    const finish = (code?: GoogleVoiceProbeCode, ip?: string, abort = true) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel)
      const checkedAt = Date.now()
      resolve({ probe: { status: code ? 'failed' : 'reachable', latencyMs: Math.max(0, checkedAt - started), checkedAt, ...(code ? { code } : {}), ...(httpStatus ? { httpStatus } : {}) }, ...(ip ? { ip } : {}) })
      if (abort) { try { request?.abort() } catch { /* already closed */ } }
    }
    const cancel = () => finish('cancelled')
    const fail = (error?: Error) => {
      const bridgeFailure = options.route?.failureFor?.(host, started)
      const code = bridgeFailure || (/ERR_(?:PROXY_AUTH|INVALID_AUTH)/.test(error?.message || '') ? 'proxy-auth' : configured?.enabled ? 'proxy-connect' : 'network-error')
      finish(code)
    }
    const timer = setTimeout(() => finish('timeout'), CHECK_TIMEOUT_MS)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) { cancel(); return }
    try {
      request = net.request({ url: CHECK_URLS[name], session: ses, method: 'GET', redirect: 'manual', cache: 'no-store',
        // Keep proxy authentication but omit Google cookies. No login page body,
        // personal URL, messages or uploaded media enter the diagnostic result.
        useSessionCookies: false, referrerPolicy: 'no-referrer' })
      request.on('login', (info, callback) => {
        if (!settled && !authSupplied && configured && proxyAuthMatches(configured, info)) {
          authSupplied = true; callback(configured.username || '', password)
        } else { callback(); finish('proxy-auth') }
      })
      request.on('redirect', (status, _method, url) => {
        if (Number.isInteger(status) && status >= 300 && status <= 399) httpStatus = status
        finish(httpStatus && name !== 'exitIp' && allowedDiagnosticRedirect(url) ? undefined : 'redirect-blocked')
      })
      request.on('error', fail); request.on('abort', () => fail())
      // Electron's writable close can precede its network response; the error,
      // response/aborted and deadline paths determine completion instead.
      request.on('response', response => {
        response.on('error', fail); response.on('aborted', () => fail())
        if (settled) return
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) { finish('invalid-response'); return }
        httpStatus = response.statusCode
        if (response.statusCode === 407) { finish('proxy-auth'); return }
        if (response.statusCode < 200 || response.statusCode >= 300) { finish('http-error'); return }
        // Headers from the fixed official endpoint prove reachability only. Stop
        // before collecting the body or following a login/consent redirect.
        if (name !== 'exitIp') { finish(); return }
        response.on('data', chunk => {
          if (settled) return
          bytes += Buffer.byteLength(chunk)
          if (bytes > CHECK_MAX_BYTES) { finish('invalid-response'); return }
          body += chunk.toString()
        })
        response.on('end', () => {
          if (settled) return
          try {
            const ip = JSON.parse(body).ip
            if (typeof ip !== 'string' || !isIP(ip)) throw new Error()
            finish(undefined, ip, false)
          } catch { finish('invalid-response') }
        })
      })
      request.end()
    } catch { fail() }
  })
}

/** Explicit, cookie-free reachability check over one route. Never tests SMS or uploads. */
export async function checkGoogleVoiceSession(ses: Session, proxy?: AccountProxy, password = '', options: CheckOptions = {}): Promise<GoogleVoiceNetworkCheck> {
  const configured = proxy ? normalizeGoogleVoiceProxy({ ...proxy, password }) : undefined
  const started = Date.now()
  const [exitIp, voice, signIn] = await Promise.all((['exitIp', 'voice', 'signIn'] as const).map(name => checkEndpoint(ses, name, configured, password, options)))
  const checkedAt = Date.now(), checks = { exitIp: exitIp.probe, voice: voice.probe, signIn: signIn.probe }
  return { reachable: Object.values(checks).every(check => check.status === 'reachable'), ...(exitIp.ip ? { ip: exitIp.ip } : {}), latencyMs: Math.max(0, checkedAt - started), checkedAt, checks }
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
    return await checkGoogleVoiceSession(ses, route.proxy, route.password, { route })
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
