import { isIP } from 'node:net'

export interface AccountProxy {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  hasPassword?: boolean
}

export function normalizeProxy(input: any): AccountProxy {
  const enabled = input?.enabled === true
  const protocol = input?.protocol || 'http'
  const host = String(input?.host || '').trim()
  const port = Number(input?.port || 0)
  const username = String(input?.username || '').trim()
  const hasPassword = Boolean(input?.password || (input?.hasPassword && !input?.clearPassword))
  if (!['http', 'https', 'socks5'].includes(protocol)) throw new Error('请选择 HTTP、HTTPS 或 SOCKS5。')
  if (enabled && (!host || /[\s/@?#;,\\]/.test(host) || !/^[a-zA-Z0-9.:[\]-]+$/.test(host))) throw new Error('请输入有效的代理主机地址，不包含协议或路径。')
  if (enabled && host.includes(':') && isIP(host.replace(/^\[|\]$/g, '')) !== 6) throw new Error('请输入有效的 IPv6 地址，端口需单独填写。')
  if (enabled && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('代理端口应为 1 至 65535。')
  if (enabled && protocol === 'socks5' && (username || hasPassword)) throw new Error('SOCKS5 仅支持免认证代理；需要账号密码时请选择 HTTP 或 HTTPS。')
  return { enabled, protocol, host, port, username, hasPassword }
}

export function proxyRules(proxy: AccountProxy) {
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${host}:${proxy.port}`
}

export function proxyAuthMatches(proxy: AccountProxy, info: { isProxy?: boolean; host: string; port: number }) {
  return proxy.enabled && info.isProxy === true && info.host.replace(/^\[|\]$/g, '').toLowerCase() === proxy.host.replace(/^\[|\]$/g, '').toLowerCase() && info.port === proxy.port
}

export async function configureProxySession(ses: { setProxy: (config: any) => Promise<void>; closeAllConnections: () => Promise<void>; clearAuthCache: () => Promise<void> }, proxy?: AccountProxy) {
  await ses.setProxy(proxy?.enabled
    ? { mode: 'fixed_servers', proxyRules: proxyRules(proxy), proxyBypassRules: '<-loopback>' }
    : { mode: 'system' })
  await ses.closeAllConnections()
  await ses.clearAuthCache()
}
