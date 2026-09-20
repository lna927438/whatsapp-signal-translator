import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

const proxy = { enabled: true, protocol: 'http', host: 'proxy.example.test', port: 8181, username: 'fixture-user' }
function harness(run?: (request: any) => void, setupFailure: boolean | 'stall' = false) {
  const requests: any[] = [], sessions: any[] = [], options: any[] = []
  class Request extends EventEmitter {
    aborted = 0
    abort() { this.aborted++; this.emit('abort') }
    end() { queueMicrotask(() => run?.(this)); return this }
  }
  const h = mainHarness({
    net: { request(input: any) { options.push(input); const r = new Request(); requests.push(r); return r } },
    session: { fromPartition(partition: string, config: any) {
      const calls: any[] = []
      const ses = { partition, config, calls,
        async setProxy(value: any) { calls.push(value); if (setupFailure === 'stall') return new Promise<void>(() => {}); if (setupFailure) throw new Error('private endpoint must not escape') },
        async closeAllConnections() { calls.push('close') },
        async clearAuthCache() { calls.push('auth') },
        async clearStorageData() { calls.push('storage') }
      }
      sessions.push(ses); return ses
    } }
  })
  return { module: h.load('src/main/platforms/googleVoice/network.ts') as typeof import('../src/main/platforms/googleVoice/network.ts'), requests, sessions, options }
}
function reply(request: any, body = '{"ip":"203.0.113.25"}', statusCode = 200) {
  const response = Object.assign(new EventEmitter(), { statusCode })
  request.emit('response', response)
  response.emit('data', Buffer.from(body)); response.emit('end'); request.emit('close')
}

test('Google Voice proxy normalization rejects malformed and oversized input including disabled settings', () => {
  const { normalizeGoogleVoiceProxy: normalize } = harness().module
  for (const input of [null, [], 'proxy', { ...proxy, enabled: 'true' }, { ...proxy, host: 'a'.repeat(254) },
    { ...proxy, host: '-bad.example' }, { ...proxy, host: 'bad..example' }, { ...proxy, host: 'host/path' }, { ...proxy, host: '[host]' },
    { ...proxy, host: 'host;direct://' }, { ...proxy, port: {} }, { ...proxy, port: '1e3' },
    { ...proxy, port: 65536 }, { ...proxy, username: 'a'.repeat(257) }, { ...proxy, password: 'x'.repeat(1025) },
    { ...proxy, password: 'bad\nheader' }, { ...proxy, enabled: false, host: 'http://host' },
    { ...proxy, protocol: 'socks5' }]) assert.throws(() => normalize(input))
  assert.equal(normalize({ ...proxy, host: 'PROXY.EXAMPLE.TEST.' }).host, proxy.host)
  assert.equal(normalize({ ...proxy, host: '[2001:db8::1]' }).host, '2001:db8::1')
  assert.equal(normalize({ enabled: false }).enabled, false)
  assert.equal(normalize({ enabled: false, protocol: 'http', host: '', port: 8080 }).enabled, false)
  assert.equal(normalize({ ...proxy, protocol: 'socks5', username: '', password: '' }).protocol, 'socks5')
  assert.equal(normalize({ ...proxy, protocol: 'socks5', password: 'fixture-secret' }).hasPassword, true)
  for (const input of [{ ...proxy, protocol: 'socks5', password: '汉'.repeat(86) }, { ...proxy, protocol: 'socks5', username: '', password: 'secret' }, { ...proxy, protocol: 'socks5', username: '汉'.repeat(86), password: 'secret' }]) assert.throws(() => normalize(input), /255|同时填写/)
})

test('manual proxy settings reject reinterpreted numeric hosts and invalid HTTP usernames without changing valid credentials', () => {
  const { normalizeGoogleVoiceProxy: normalize } = harness().module
  for (const host of ['0x7f000001', '0x7f.0.0.1', '127.1', '2130706433', '0177.0.0.1', '127.0.0.01', '999.0.0.1']) {
    assert.throws(() => normalize({ ...proxy, host }), /完整且有效/)
    assert.throws(() => normalize({ ...proxy, host, enabled: false }), /完整且有效/)
  }
  for (const protocol of ['http', 'https']) {
    assert.throws(() => normalize({ ...proxy, protocol, username: 'fixture:name' }), /账号不能包含冒号/)
    const normalized = normalize({ ...proxy, protocol, host: '127.0.0.1', password: 'fixture:secret', hasPassword: true })
    assert.equal(normalized.host, '127.0.0.1'); assert.equal(normalized.username, proxy.username); assert.equal(normalized.hasPassword, true)
  }
  for (const host of ['proxy.example.test', 'localhost', '2001:0db8:0:0:0:0:0:1', '[::1]']) {
    const normalized = normalize({ ...proxy, host, protocol: 'socks5', username: 'fixture:name', password: 'fixture:secret' })
    assert.equal(normalized.host, host.replace(/^\[|\]$/g, '')); assert.equal(normalized.username, 'fixture:name'); assert.equal(normalized.hasPassword, true)
  }
})

test('IP check uses the supplied window session with cookies off and redirects disabled', async () => {
  const h = harness(reply), existing = {} as Electron.Session
  const result = await h.module.checkGoogleVoiceSession(existing)
  assert.equal(h.options[0].session, existing)
  assert.equal(h.options[0].redirect, 'error'); assert.equal(h.options[0].useSessionCookies, false)
  assert.equal(h.options[0].cache, 'no-store'); assert.equal(h.options[0].referrerPolicy, 'no-referrer')
  assert.equal(result.ip, '203.0.113.25'); assert.ok(result.latencyMs >= 0); assert.ok(result.checkedAt > 0)
  assert.equal(h.sessions.length, 0, 'a current window check must not create or replace its session')
})

test('Electron writable close before the network response does not abort a working IP check', async () => {
  const h = harness(request => { request.emit('close'); reply(request) })
  assert.equal((await h.module.checkGoogleVoiceSession({} as Electron.Session)).ip, '203.0.113.25')
  assert.equal(h.requests[0].aborted, 0)
})

test('proxy tests use unique nonpersistent sessions and fixed routes without direct fallback', async () => {
  const h = harness(reply)
  await Promise.all([h.module.testGoogleVoiceProxy(proxy, 'secret-one'), h.module.testGoogleVoiceProxy({ ...proxy, host: 'other.example.test' }, 'secret-two')])
  assert.equal(h.sessions.length, 2); assert.notEqual(h.sessions[0].partition, h.sessions[1].partition)
  for (const ses of h.sessions) {
    assert.match(ses.partition, /^google-voice-proxy-test:/); assert.ok(!ses.partition.startsWith('persist:'))
    assert.equal(ses.config.cache, false)
    assert.equal(ses.calls[0].mode, 'fixed_servers'); assert.ok(!ses.calls[0].proxyRules.includes('direct'))
    assert.equal(ses.calls[0].proxyBypassRules, '<-loopback>')
    assert.deepEqual(ses.calls.slice(1), ['close', 'auth', 'close', 'auth', 'storage'])
  }
})

test('configuration failure does not issue any IP request or reset to a direct route', async () => {
  const h = harness(reply, true)
  await assert.rejects(h.module.testGoogleVoiceProxy(proxy, 'fixture-secret'), /代理设置未成功/)
  assert.equal(h.requests.length, 0)
  assert.equal(h.sessions[0].calls.filter((value: any) => typeof value === 'object').length, 1)
  assert.deepEqual(h.sessions[0].calls.slice(1), ['close', 'auth', 'storage'])
})

test('stalled proxy setup times out without starting the check or retrying direct', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(reply, 'stall'), pending = h.module.testGoogleVoiceProxy(proxy, 'fixture-secret')
  const rejected = assert.rejects(pending, /代理设置未成功/)
  await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(12_000)
  await rejected
  assert.equal(h.requests.length, 0)
  assert.equal(h.sessions[0].calls.filter((value: any) => typeof value === 'object').length, 1)
})

test('IP check supplies credentials only to one matching proxy challenge', async () => {
  const replies: any[] = []
  const h = harness(request => {
    const info = { isProxy: true, host: proxy.host, port: proxy.port }
    request.emit('login', info, (...args: any[]) => replies.push(args))
    request.emit('login', info, (...args: any[]) => replies.push(args))
    reply(request)
  })
  await assert.rejects(h.module.checkGoogleVoiceSession({} as Electron.Session, proxy as any, 'fixture-secret'), /代理认证失败/)
  assert.deepEqual(replies, [['fixture-user', 'fixture-secret'], []])
  assert.equal(h.requests[0].aborted, 1)
})

test('IP check never sends proxy credentials to origin or foreign proxy challenges', async () => {
  for (const info of [{ isProxy: false, host: proxy.host, port: proxy.port }, { isProxy: true, host: 'evil.test', port: proxy.port }, { isProxy: true, host: proxy.host, port: 80 }]) {
    const replies: any[] = [], h = harness(request => request.emit('login', info, (...args: any[]) => replies.push(args)))
    await assert.rejects(h.module.checkGoogleVoiceSession({} as Electron.Session, proxy as any, 'fixture-secret'), /认证失败/)
    assert.deepEqual(replies, [[]])
  }
})

test('redirect, invalid response, oversized body and network errors are bounded and do not leak details', async () => {
  for (const run of [(request: any) => request.emit('redirect', 302, 'GET', 'https://private.example/?secret=fixture'),
    (request: any) => reply(request, '{"ip":"not-an-ip"}'), (request: any) => reply(request, 'x'.repeat(4097)),
    (request: any) => reply(request, '{}', 407), (request: any) => request.emit('error', new Error('private-credentials-here')),
    (request: any) => request.emit('abort')]) {
    const h = harness(run)
    await assert.rejects(h.module.checkGoogleVoiceSession({} as Electron.Session), (error: any) => !/private|fixture|credentials-here/.test(error.message))
    assert.equal(h.requests[0].aborted, 1)
  }
})

test('stalled IP check times out and aborts the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(), pending = h.module.checkGoogleVoiceSession({} as Electron.Session)
  const rejected = assert.rejects(pending, /超时/)
  t.mock.timers.tick(12_000)
  await rejected
  assert.equal(h.requests[0].aborted, 1)
})

test('per-window auth uses the current Electron signature and revokes itself on destruction', () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false }), replies: any[] = []
  const h = harness(), remove = h.module.attachGoogleVoiceProxyAuth(contents as any, proxy as any, 'fixture-secret')
  let prevented = 0
  const event = { preventDefault() { prevented++ } }, callback = (...args: any[]) => replies.push(args)
  const info = { isProxy: true, host: proxy.host, port: proxy.port }
  contents.emit('login', event, { firstAuthAttempt: true }, { ...info, isProxy: false }, callback)
  contents.emit('login', event, { firstAuthAttempt: true }, { ...info, host: 'other.example' }, callback)
  assert.equal(prevented, 0); assert.deepEqual(replies, [])
  contents.emit('login', event, { firstAuthAttempt: true }, info, callback)
  contents.emit('login', event, { firstAuthAttempt: false }, info, callback)
  contents.emit('login', event, { firstAuthAttempt: true }, info, callback)
  assert.equal(prevented, 3); assert.deepEqual(replies, [['fixture-user', 'fixture-secret'], [], []])
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  contents.emit('login', event, { firstAuthAttempt: true }, info, callback); assert.deepEqual(replies.at(-1), [])
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  contents.emit('login', event, { firstAuthAttempt: true }, info, callback); assert.deepEqual(replies.at(-1), [])
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  contents.emit('login', event, { firstAuthAttempt: true }, info, callback); assert.deepEqual(replies.at(-1), ['fixture-user', 'fixture-secret'])
  contents.emit('destroyed')
  assert.equal(contents.listenerCount('login'), 0); assert.equal(contents.listenerCount('destroyed'), 0); assert.equal(contents.listenerCount('did-start-navigation'), 0)
  remove(); assert.equal(contents.listenerCount('login'), 0)
})

test('window credentials cannot cross into another independently configured window', () => {
  const h = harness(), replies: any[] = []
  const a = Object.assign(new EventEmitter(), { isDestroyed: () => false }), b = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const offA = h.module.attachGoogleVoiceProxyAuth(a as any, proxy as any, 'one')
  const offB = h.module.attachGoogleVoiceProxyAuth(b as any, { ...proxy, host: 'second.test' } as any, 'two')
  const info = { isProxy: true, host: proxy.host, port: proxy.port }, event = { preventDefault() {} }, callback = (...args: any[]) => replies.push(args)
  b.emit('login', event, { firstAuthAttempt: true }, info, callback)
  a.emit('login', event, { firstAuthAttempt: true }, info, callback)
  assert.deepEqual(replies, [['fixture-user', 'one']])
  offA(); offB()
})
