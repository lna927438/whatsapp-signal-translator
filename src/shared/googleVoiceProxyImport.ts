export type GoogleVoiceProxyProtocol = 'http' | 'https' | 'socks5'
export interface GoogleVoiceProxyImport {
  protocol: GoogleVoiceProxyProtocol
  host: string
  port: number
  username: string
  password: string
  enabled: true
  hasPassword: false
  clearPassword: boolean
}

const messages = {
  format: '代理格式无效。请使用 地址:端口:账号:密码、账号:密码@地址:端口，或完整代理链接。',
  protocol: '请选择 HTTP、HTTPS 或 SOCKS5 代理协议。',
  host: '代理地址无效。IPv6 地址必须放在方括号中。',
  port: '代理端口必须是 1 至 65535 的整数。',
  characters: '请只粘贴一条代理配置，不要包含控制字符、路径、查询参数或链接片段。',
  length: '代理配置、地址、账号或密码过长，请检查后重新输入。',
  encoding: '代理链接的账号或密码编码无效。请使用正确的百分号编码。',
  whitespace: '代理地址、账号或密码两端不能带空白，请检查后重新输入。',
  username: 'HTTP 和 HTTPS 代理账号不能包含冒号。请核对代理服务提供的账号。',
  ambiguous: '代理格式有歧义。请改用完整代理链接，并将账号或密码中的 @ 编码为 %40。',
  socks: 'SOCKS5 账号和密码需要同时填写，且各不超过 255 个 UTF-8 字节。'
}
function fail(key: keyof typeof messages): never { throw new Error(messages[key]) }
const controls = /[\p{Cc}\u2028\u2029]/u
const supported = (value: unknown): value is GoogleVoiceProxyProtocol => value === 'http' || value === 'https' || value === 'socks5'
const defaults: Record<GoogleVoiceProxyProtocol, number> = { http: 80, https: 443, socks5: 1080 }

function hostValue(value: string): string {
  if (!value || value.length > 253) fail(value.length > 253 ? 'length' : 'host')
  if (value.trim() !== value) fail('whitespace')
  if (value.startsWith('[')) {
    if (!/^\[[0-9a-f:.]+\]$/i.test(value) || !value.includes(':')) fail('host')
    try {
      const host = new URL('http://' + value).hostname
      if (!host.startsWith('[') || !host.endsWith(']')) fail('host')
      return host.slice(1, -1)
    } catch { return fail('host') }
  }
  const host = value.toLowerCase().replace(/\.$/, '')
  if (!host || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('host')
  // Do not let URL parsers reinterpret abbreviated, octal or out-of-range IPs.
  if (/^[0-9.]+$/.test(host)) {
    const pieces = host.split('.')
    if (pieces.length !== 4 || pieces.some(piece => !/^(?:0|[1-9]\d{0,2})$/.test(piece) || Number(piece) > 255)) fail('host')
  }
  try { if (new URL('http://' + host).hostname !== host) fail('host') } catch { return fail('host') }
  return host
}

function portValue(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) fail('port')
  return Number(value)
}

function endpoint(value: string, defaultPort?: number): { host: string; port: number } {
  const match = /^(\[[^\[\]]+\]|[^:\[\]]+)(?::([^:]*))?$/.exec(value)
  if (!match) fail('host')
  return { host: hostValue(match[1]), port: match[2] === undefined && defaultPort !== undefined ? defaultPort : portValue(match[2] || '') }
}

function result(protocol: GoogleVoiceProxyProtocol, address: { host: string; port: number }, username = '', password = ''): GoogleVoiceProxyImport {
  if (username.length > 256 || password.length > 1024) fail('length')
  if (controls.test(username) || controls.test(password)) fail('characters')
  // Main-process HTTP authentication also trims usernames. Reject rather than
  // silently change imported credentials or guess whether whitespace was copied.
  if (username.trim() !== username || password.trim() !== password) fail('whitespace')
  if (protocol !== 'socks5' && username.includes(':')) fail('username')
  if (protocol === 'socks5' && (Boolean(username) !== Boolean(password) || new TextEncoder().encode(username).length > 255 || new TextEncoder().encode(password).length > 255)) fail('socks')
  return { protocol, ...address, username, password, enabled: true, hasPassword: false, clearPassword: !password }
}

function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { return fail('encoding') }
}

/** Pure import only: never mutates form state, stores credentials or checks a
 * network. Only explicit URLs percent-decode credentials. Delimited passwords
 * retain their literal ':' and '@' when their format has exactly one meaning.
 */
export function parseGoogleVoiceProxyImport(input: string, fallbackProtocol: GoogleVoiceProxyProtocol): GoogleVoiceProxyImport {
  if (!supported(fallbackProtocol)) fail('protocol')
  if (typeof input !== 'string' || !input) fail('format')
  if (input.length > 16384) fail('length')
  if (controls.test(input)) fail('characters')
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input)
  if (scheme) {
    const protocol = scheme[1].toLowerCase()
    if (!supported(protocol)) fail('protocol')
    // A URL's sole root slash is optional; it is not a proxy path.
    const authority = input.slice(scheme[0].length).replace(/\/$/, '')
    if (/[\/\\?#]/.test(authority)) fail('characters')
    if (authority.trim() !== authority) fail('whitespace')
    const at = authority.indexOf('@')
    if (at !== authority.lastIndexOf('@')) fail('ambiguous')
    if (at < 0) return result(protocol, endpoint(authority, defaults[protocol]))
    const userInfo = authority.slice(0, at), colon = userInfo.indexOf(':')
    const username = colon < 0 ? userInfo : userInfo.slice(0, colon)
    const password = colon < 0 ? '' : userInfo.slice(colon + 1)
    return result(protocol, endpoint(authority.slice(at + 1), defaults[protocol]), decode(username), decode(password))
  }
  const candidates: GoogleVoiceProxyImport[] = [], errors: Error[] = []
  const attempt = (parse: () => GoogleVoiceProxyImport) => {
    try { candidates.push(parse()) } catch (error) { errors.push(error as Error) }
  }
  // host:port[:username:password]. Everything after the username separator is
  // the password; do not truncate it at a later colon or percent-decode it.
  const hostFirst = /^(\[[^\[\]]+\]|[^:\[\]]+):([^:]*)(?::([\s\S]*))?$/.exec(input)
  if (hostFirst) attempt(() => {
    const address = { host: hostValue(hostFirst[1]), port: portValue(hostFirst[2]) }
    if (hostFirst[3] === undefined) return result(fallbackProtocol, address)
    const colon = hostFirst[3].indexOf(':')
    if (colon < 0) fail('format')
    return result(fallbackProtocol, address, hostFirst[3].slice(0, colon), hostFirst[3].slice(colon + 1))
  })
  const at = input.indexOf('@')
  if (at >= 0 && at === input.lastIndexOf('@')) attempt(() => {
    const userInfo = input.slice(0, at), colon = userInfo.indexOf(':')
    if (colon < 0) fail('format')
    return result(fallbackProtocol, endpoint(input.slice(at + 1)), userInfo.slice(0, colon), userInfo.slice(colon + 1))
  })
  if (candidates.length > 1) fail('ambiguous')
  if (candidates.length === 1) return candidates[0]
  if (errors.length === 1) throw errors[0]
  return fail('format')
}
