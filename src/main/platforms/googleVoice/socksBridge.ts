import { createServer } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AccountProxy } from '../../network/accountProxy'
import type { GoogleVoiceProbeCode } from '../../../shared/googleVoiceNetwork'

export interface GoogleVoiceNetworkRoute {
  proxy?: AccountProxy
  password: string
  close(): Promise<void>
  isClosed?(): boolean
  failureFor?(host: string, since: number): GoogleVoiceProbeCode | undefined
}

function readBytes(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('readable', read); socket.off('error', fail); socket.off('end', fail); socket.off('close', fail) }
    const fail = () => { cleanup(); reject(new Error('SOCKS5 连接未完成。')) }
    const read = () => {
      const value = socket.read(length)
      if (value !== null) { cleanup(); resolve(value) }
      else if (socket.destroyed || socket.readableEnded) fail()
    }
    socket.on('readable', read); socket.once('error', fail); socket.once('end', fail); socket.once('close', fail); read()
  })
}

function destination(authority: string | undefined): { host: string; port: number } {
  if (typeof authority !== 'string' || authority.length > 300 || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d{1,5}$/i.test(authority)) throw new Error('无效目标。')
  const url = new URL('http://' + authority), host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(authority.slice(authority.lastIndexOf(':') + 1))
  if (port < 1 || port > 65535 || host.length > 253 || !isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('无效目标。')
  return { host, port }
}

function address(host: string): Buffer {
  if (isIP(host) === 4) return Buffer.from([1, ...host.split('.').map(Number)])
  if (isIP(host) === 6) {
    const mapped = host.replace(/(?:\d{1,3}\.){3}\d{1,3}$/, value => {
      const n = value.split('.').map(Number); return ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16)
    })
    const halves = mapped.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : []
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
    const bytes = Buffer.alloc(17); bytes[0] = 4; parts.forEach((part, index) => bytes.writeUInt16BE(parseInt(part, 16), 1 + index * 2)); return bytes
  }
  // Send the domain to SOCKS; never resolve the destination on this computer.
  const bytes = Buffer.from(host, 'ascii'); return Buffer.concat([Buffer.from([3, bytes.length]), bytes])
}

/** Loopback CONNECT -> RFC 1928/1929. Each window owns its server and capability. */
export async function createGoogleVoiceSocksBridge(proxy: AccountProxy, password: string): Promise<GoogleVoiceNetworkRoute> {
  const username = Buffer.from(proxy.username || '', 'utf8'), secret = Buffer.from(password, 'utf8')
  const proxyHost = proxy.host, proxyPort = proxy.port
  password = ''
  const authenticated = username.length > 0 || secret.length > 0
  if (authenticated && (!username.length || !secret.length || username.length > 255 || secret.length > 255)) throw new Error('SOCKS5 账号和密码需要同时填写，且各不超过 255 个 UTF-8 字节。')
  let closed = false, closing: Promise<void> | undefined
  const failures = new Map<string, { code: GoogleVoiceProbeCode; at: number }>()
  const failed = (host: string, code: GoogleVoiceProbeCode) => {
    failures.delete(host); failures.set(host, { code, at: Date.now() })
    if (failures.size > 32) failures.delete(failures.keys().next().value!)
  }
  const sockets = new Set<Socket>()
  const localUser = randomBytes(24).toString('hex'), localPassword = randomBytes(32).toString('base64url')
  const capability = Buffer.from('Basic ' + Buffer.from(localUser + ':' + localPassword).toString('base64'))
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, (_request, response) => {
    response.writeHead(405, { connection: 'close', 'content-length': '0' }); response.end()
  })
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}) }
  server.on('connection', socket => {
    if (closed || sockets.size >= 256 || socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return }
    track(socket); socket.setTimeout(15_000, () => socket.destroy())
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (request, stream, head) => {
    const client = stream as Socket
    const supplied = Buffer.from(typeof request.headers['proxy-authorization'] === 'string' ? request.headers['proxy-authorization'] : '')
    if (closed || supplied.length !== capability.length || !timingSafeEqual(supplied, capability)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="HelloDog window"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    let target: { host: string; port: number }
    try { target = destination(request.url); if (head.length > 65536) throw new Error() }
    catch { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    if (client.destroyed || sockets.size >= 256) { client.destroy(); return }
    const upstream = connect({ host: proxyHost, port: proxyPort }); track(upstream)
    client.once('close', () => upstream.destroy())
    let failure: GoogleVoiceProbeCode = 'proxy-connect'
    const timer = setTimeout(() => { failure = 'timeout'; upstream.destroy(new Error('SOCKS5 握手超时。')) }, 10_000)
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { upstream.off('connect', connected); upstream.off('error', failed); upstream.off('close', failed) }
          const connected = () => { cleanup(); resolve() }, failed = () => { cleanup(); reject(new Error('SOCKS5 连接失败。')) }
          upstream.once('connect', connected); upstream.once('error', failed); upstream.once('close', failed)
        })
        if (closed || client.destroyed) throw new Error()
        upstream.write(Buffer.from([5, 1, authenticated ? 2 : 0]))
        const method = await readBytes(upstream, 2)
        if (method[0] !== 5 || method[1] !== (authenticated ? 2 : 0)) { if (authenticated) failure = 'proxy-auth'; throw new Error() }
        if (authenticated) {
          const packet = Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([secret.length]), secret])
          try { upstream.write(packet); const auth = await readBytes(upstream, 2); if (auth[0] !== 1 || auth[1] !== 0) { failure = 'proxy-auth'; throw new Error() } }
          finally { packet.fill(0) }
        }
        const port = Buffer.alloc(2); port.writeUInt16BE(target.port)
        upstream.write(Buffer.concat([Buffer.from([5, 1, 0]), address(target.host), port]))
        const reply = await readBytes(upstream, 4)
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error()
        const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(upstream, 1))[0] : -1
        if (length < 1) throw new Error()
        await readBytes(upstream, length + 2)
        if (closed || client.destroyed) throw new Error()
        clearTimeout(timer); client.setTimeout(0); upstream.setTimeout(0)
        failures.delete(target.host)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        // Any bytes coalesced after the SOCKS reply stay in the readable buffer
        // and pipe through without losing the start of the TLS response.
        upstream.once('error', () => client.destroy())
        upstream.once('close', () => { if (!client.destroyed && !client.writableEnded) client.end() })
        client.pipe(upstream); upstream.pipe(client)
      } catch {
        if (!closed && !client.destroyed) failed(target.host, failure)
        upstream.destroy()
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } finally { clearTimeout(timer) }
    })()
  })
  const route: GoogleVoiceNetworkRoute = {
    proxy: undefined, password: localPassword,
    isClosed: () => closed,
    failureFor: (host, since) => { const value = failures.get(host); return value && value.at >= since ? value.code : undefined },
    close() {
      if (closing) return closing
      closed = true; route.password = ''; username.fill(0); secret.fill(0); capability.fill(0); failures.clear()
      for (const socket of sockets) socket.destroy()
      closing = new Promise<void>(resolve => server.close(() => resolve()))
      return closing
    }
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    server.on('error', () => { void route.close() })
    const endpoint = server.address()
    if (!endpoint || typeof endpoint === 'string') throw new Error()
    route.proxy = { enabled: true, protocol: 'http', host: '127.0.0.1', port: endpoint.port, username: localUser, hasPassword: true }
    return route
  } catch { await route.close(); throw new Error('SOCKS5 本机连接未能启动，请重试。') }
}
