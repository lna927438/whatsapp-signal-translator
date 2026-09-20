import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { mainHarness } from './main-harness.ts'
const require = createRequire(import.meta.url)
const { makeSocksFixture } = require('./google-voice-socks-fixture.cjs')
const { prepareGoogleVoiceNetwork } = mainHarness().load('src/main/platforms/googleVoice/network.ts') as typeof import('../src/main/platforms/googleVoice/network.ts')
type Route = Awaited<ReturnType<typeof prepareGoogleVoiceNetwork>>

async function backend() {
  const sockets = new Set<any>(), server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.write('synthetic tunnel'); socket.on('data', chunk => socket.write(chunk)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as any).port, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
function tunnel(route: Route, authorization?: string, target = 'voice.google.com:443'): Promise<{ status: number; socket: any; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const local = route.proxy!, auth = authorization ?? 'Basic ' + Buffer.from(local.username + ':' + route.password).toString('base64')
    const req = request({ host: local.host, port: local.port, method: 'CONNECT', path: target, headers: { 'Proxy-Authorization': auth } })
    req.once('error', reject); req.once('connect', (response, socket, head) => resolve({ status: response.statusCode!, socket, head })); req.end()
  })
}

test('authenticated SOCKS bridge is loopback-only, independently authorized and preserves the target domain for remote DNS', async () => {
  const end = await backend(), upstream = await makeSocksFixture(end.port, 'fixture-user', 'fixture-secret', { fragmented: true })
  const settings = { enabled: true, protocol: 'socks5' as const, host: '127.0.0.1', port: upstream.port, username: 'fixture-user', hasPassword: true }
  const a = await prepareGoogleVoiceNetwork(settings, 'fixture-secret'), b = await prepareGoogleVoiceNetwork(settings, 'fixture-secret')
  try {
    assert.equal(a.proxy?.host, '127.0.0.1'); assert.notEqual(a.proxy?.port, b.proxy?.port); assert.notEqual(a.password, b.password)
    const denied = await tunnel(b, 'Basic ' + Buffer.from(a.proxy?.username + ':' + a.password).toString('base64'))
    assert.equal(denied.status, 407); denied.socket.destroy(); assert.equal(upstream.stats.connections, 0)
    const accepted = await tunnel(a)
    assert.equal(accepted.status, 200); accepted.socket.destroy()
    assert.equal(upstream.stats.authAttempts, 1); assert.equal(upstream.stats.authenticated, 1)
    assert.deepEqual(upstream.stats.targets, [{ type: 3, host: 'voice.google.com', port: 443 }])
  } finally { await Promise.all([a.close(), b.close()]); await upstream.close(); await end.close() }
})

test('wrong SOCKS password and authentication downgrade fail without reaching the destination', async () => {
  const end = await backend()
  for (const downgrade of [false, true]) {
    const upstream = await makeSocksFixture(end.port, 'fixture-user', 'fixture-secret', { downgrade })
    const route = await prepareGoogleVoiceNetwork({ enabled: true, protocol: 'socks5', host: '127.0.0.1', port: upstream.port, username: 'fixture-user' }, 'wrong-password')
    try { const failed = await tunnel(route); assert.equal(failed.status, 502); failed.socket.destroy(); assert.equal(upstream.stats.targets.length, 0); assert.equal(upstream.stats.authAttempts, downgrade ? 0 : 1) }
    finally { await route.close(); await upstream.close() }
  }
  await end.close()
})

test('stopped SOCKS service never causes a direct destination connection and closing the bridge removes its listener', async () => {
  const end = await backend(), upstream = await makeSocksFixture(end.port, 'fixture-user', 'fixture-secret')
  const route = await prepareGoogleVoiceNetwork({ enabled: true, protocol: 'socks5', host: '127.0.0.1', port: upstream.port, username: 'fixture-user' }, 'fixture-secret')
  let directConnections = 0
  const direct = createServer(socket => { directConnections++; socket.destroy() }); await new Promise<void>(resolve => direct.listen(0, '127.0.0.1', resolve))
  const localPort = route.proxy!.port
  try {
    await upstream.close()
    const failed = await tunnel(route, undefined, '127.0.0.1:' + (direct.address() as any).port)
    assert.equal(failed.status, 502); failed.socket.destroy(); assert.equal(directConnections, 0)
    await route.close(); await route.close(); assert.equal(route.password, '')
    await assert.rejects(new Promise((resolve, reject) => { const socket = connect(localPort, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(undefined) }); socket.once('error', reject) }))
  } finally { await route.close(); await end.close(); await new Promise<void>(resolve => direct.close(() => resolve())) }
})

test('unauthenticated SOCKS and IPv6 targets use the same isolated bridge without invented credentials', async () => {
  const end = await backend(), upstream = await makeSocksFixture(end.port, '', '')
  const route = await prepareGoogleVoiceNetwork({ enabled: true, protocol: 'socks5', host: '127.0.0.1', port: upstream.port }, '')
  try {
    const accepted = await tunnel(route, undefined, '[2001:db8::1]:443'); assert.equal(accepted.status, 200); accepted.socket.destroy()
    assert.equal(upstream.stats.authAttempts, 0)
    assert.deepEqual(upstream.stats.targets, [{ type: 4, host: '20010db8000000000000000000000001', port: 443 }])
  } finally { await route.close(); await upstream.close(); await end.close() }
})
