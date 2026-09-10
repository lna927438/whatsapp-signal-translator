import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { configureProxySession, normalizeProxy, proxyAuthMatches, proxyRules } = require('../src/main/network/accountProxy.ts') as typeof import('../src/main/network/accountProxy')
const { AccountWrites } = require('../src/renderer/src/lib/accountWrites.ts') as typeof import('../src/renderer/src/lib/accountWrites')

const sample = { enabled: true, protocol: 'http', host: 'proxy.example.com', port: 8080 }

test('proxy validation rejects bypass syntax, invalid ports and authenticated SOCKS5', () => {
  for (const host of ['proxy.example.com;direct://', 'http://proxy.example.com', 'host/path', 'host:8080']) assert.throws(() => normalizeProxy({ ...sample, host }))
  for (const port of [0, -1, 65536, 1.5, 'oops']) assert.throws(() => normalizeProxy({ ...sample, port }))
  assert.throws(() => normalizeProxy({ ...sample, protocol: 'socks5', hasPassword: true }))
  assert.throws(() => normalizeProxy({ ...sample, protocol: 'socks5', username: 'name' }))
  assert.equal(normalizeProxy({ ...sample, protocol: 'socks5', hasPassword: true, clearPassword: true }).hasPassword, false)
  assert.equal(proxyRules(normalizeProxy({ ...sample, host: '2001:db8::1' })), 'http://[2001:db8::1]:8080')
})

test('proxy credentials are restricted to the configured proxy challenge, never an origin challenge', () => {
  const proxy = normalizeProxy(sample)
  assert.equal(proxyAuthMatches(proxy, { isProxy: true, host: 'PROXY.EXAMPLE.COM', port: 8080 }), true)
  assert.equal(proxyAuthMatches(proxy, { isProxy: false, host: proxy.host, port: proxy.port }), false)
  assert.equal(proxyAuthMatches(proxy, { isProxy: true, host: 'unrelated.example', port: proxy.port }), false)
  assert.equal(proxyAuthMatches(proxy, { isProxy: true, host: proxy.host, port: 443 }), false)
})

test('each proxy session uses a fixed route without direct fallback and clears old connections and auth', async () => {
  const calls: any[] = []
  const ses = { async setProxy(config: any) { calls.push(config) }, async closeAllConnections() { calls.push('close') }, async clearAuthCache() { calls.push('clear-auth') } }
  await configureProxySession(ses, normalizeProxy(sample))
  assert.deepEqual(calls, [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example.com:8080', proxyBypassRules: '<-loopback>' }, 'close', 'clear-auth'])
  calls.length = 0
  await configureProxySession(ses, { ...normalizeProxy(sample), enabled: false })
  assert.deepEqual(calls, [{ mode: 'system' }, 'close', 'clear-auth'])
  calls.length = 0
  await assert.rejects(configureProxySession({ ...ses, async setProxy() { throw new Error('unavailable') } }, normalizeProxy(sample)), /unavailable/)
  assert.deepEqual(calls, [])
})

test('rapid account edits retain the newest field value and keep other accounts independent', () => {
  const writes = new AccountWrites()
  const first = writes.begin('a', { sendAutoTranslate: true, fontSize: 13 })
  const second = writes.begin('a', { sendAutoTranslate: false })
  const other = writes.begin('b', { sendAutoTranslate: true })
  assert.deepEqual(first({ sendAutoTranslate: true, fontSize: 13 }), { fontSize: 13 })
  assert.deepEqual(second({ sendAutoTranslate: false }), { sendAutoTranslate: false })
  assert.deepEqual(other({ sendAutoTranslate: true }), { sendAutoTranslate: true })
})

test('account saves execute in click order and recover after an earlier save fails', async () => {
  const writes = new AccountWrites()
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = writes.enqueue(async () => { calls.push('first'); await gate; throw new Error('write failed') })
  const failure = assert.rejects(first, /write failed/)
  const second = writes.enqueue(async () => { calls.push('second'); return 'saved' })
  await Promise.resolve()
  assert.deepEqual(calls, ['first'])
  release()
  await failure
  assert.equal(await second, 'saved')
  assert.deepEqual(calls, ['first', 'second'])
})
