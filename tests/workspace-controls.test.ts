import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { clampViewBounds } = require('../src/main/platforms/whatsapp/viewBounds.ts') as typeof import('../src/main/platforms/whatsapp/viewBounds')
const { legacyUserDataPath } = require('../src/main/storage/userDataPath.ts') as typeof import('../src/main/storage/userDataPath')
const { cloudRead, setCloudRoute, measureCloudRoutes } = require('../src/main/network/cloudConnection.ts') as typeof import('../src/main/network/cloudConnection')
const { CloudflareProvider } = require('../src/main/translation/providers/cloudflare.ts') as typeof import('../src/main/translation/providers/cloudflare')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; setCloudRoute('auto') })

test('collapsed sidebar enlarges native chat bounds and smaller windows cannot overlap controls', () => {
  const expanded = clampViewBounds({ x: 248, y: 210, width: 1032, height: 610 }, 1280, 820)!
  const collapsed = clampViewBounds({ x: 76, y: 210, width: 1204, height: 610 }, 1280, 820)!
  assert.equal(collapsed.width - expanded.width, 172)
  assert.equal(collapsed.x + collapsed.width, 1280)
  assert.deepEqual(clampViewBounds(collapsed, 960, 620), { x: 76, y: 210, width: 884, height: 410 })
  assert.equal(clampViewBounds({ ...collapsed, x: NaN }, 960, 620), null)
  assert.deepEqual(clampViewBounds({ x: 76, y: 210, width: 724, height: 310 }, 960, 620, 1.2), { x: 91, y: 252, width: 869, height: 368 })
})

test('HelloDog rename preserves installed legacy user data and uses one stable path for new installs', () => {
  assert.equal(legacyUserDataPath('/appdata', '/appdata/HelloDog', path => path === '/appdata/WhatsApp Signal Translator/accounts.json'), '/appdata/WhatsApp Signal Translator')
  assert.equal(legacyUserDataPath('/appdata', '/appdata/HelloDog', path => path === '/appdata/whatsapp-signal-translator/outgoing-tasks-v1.json'), '/appdata/whatsapp-signal-translator')
  assert.equal(legacyUserDataPath('/appdata', '/appdata/HelloDog', () => false), '/appdata/whatsapp-signal-translator')
})

test('translation route failover retains the same request and never repeats a provider-auth failure', async () => {
  const calls: Array<{ url: string; body: unknown; id: string | null }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body, id: new Headers(init?.headers).get('x-request-id') })
    if (calls.length === 1) throw new TypeError('offline')
    return Response.json({ translation: '你好' })
  }
  assert.equal(await new CloudflareProvider('test').translate({ text: 'Hello', targetLanguage: 'zh-CN', requestId: 'same-request' }), '你好')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /^https:\/\/api.hellodog.net\//)
  assert.match(calls[1].url, /^https:\/\/realtime-translator-api.lna927438.workers.dev\//)
  assert.equal(calls[0].body, calls[1].body); assert.equal(calls[0].id, calls[1].id)
  let failures = 0
  globalThis.fetch = async () => { failures++; return Response.json({ error: 'provider_auth', message: '服务端凭据无效' }, { status: 502 }) }
  await assert.rejects(new CloudflareProvider('test').translate({ text: 'Hello', targetLanguage: 'zh-CN' }), /凭据无效/)
  assert.equal(failures, 1)
})

test('selected route is respected and account suspension cannot be bypassed by another route', async () => {
  const urls: string[] = []
  setCloudRoute('backup')
  globalThis.fetch = async url => { urls.push(String(url)); return Response.json({ ok: true }) }
  await cloudRead('/api/me', 'test')
  assert.match(urls[0], /workers.dev/)
  setCloudRoute('auto')
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'account_disabled' }, { status: 403 }) }
  await assert.rejects(cloudRead('/api/me', 'test'), /账号已停用/)
  assert.equal(calls, 1)
})

test('route measurements reject non-health responses and never infer provider readiness', async () => {
  globalThis.fetch = async url => String(url).includes('workers.dev') ? Response.json({ ok: true }) : new Response('<html>offline</html>', { status: 502 })
  const results = await measureCloudRoutes()
  assert.equal(results[0].available, false); assert.equal(results[0].latencyMs, null)
  assert.equal(results[1].available, true); assert.ok(Number.isFinite(results[1].latencyMs))
  assert.ok(results.every(item => !('provider' in item)))
})
