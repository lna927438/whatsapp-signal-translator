import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('an initial token refresh that exceeds the absolute deadline cannot dispatch a late POST', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let calls = 0, release!: (value: string) => void
  const token = new Promise<string>(resolve => { release = resolve })
  const h = mainHarness(undefined, async () => { calls++; return Response.json({}) })
  try {
    const { authenticatedFetch } = h.load('src/main/network/sessionRefresh.ts')
    const work = authenticatedFetch(() => token, 'https://fixture.invalid/api/translate', { method: 'POST' }, 30000, 1500)
    const rejection = assert.rejects(work, /超过翻译等待时间/)
    await tick(); t.mock.timers.tick(501); await rejection
    release('fresh-fixture-token'); await tick()
    assert.equal(calls, 0)
  } finally { t.mock.timers.reset(); rmSync(h.directory, { recursive: true, force: true }) }
})

test('401 refresh cannot restart the network budget or send a second POST beyond the absolute deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let calls = 0, release!: (value: string) => void
  const token = new Promise<string>(resolve => { release = resolve })
  const h = mainHarness(undefined, async () => { calls++; return Response.json({}, { status: 401 }) })
  try {
    const { authenticatedFetch } = h.load('src/main/network/sessionRefresh.ts')
    const work = authenticatedFetch((force: boolean) => force ? token : 'fixture-old', 'https://fixture.invalid/api/translate', { method: 'POST' }, 30000, 1500)
    const rejection = assert.rejects(work, /超过翻译等待时间/)
    await tick(); assert.equal(calls, 1)
    t.mock.timers.tick(501); await rejection
    release('fixture-new'); await tick(); assert.equal(calls, 1)
  } finally { t.mock.timers.reset(); rmSync(h.directory, { recursive: true, force: true }) }
})

test('the absolute deadline signal also aborts an interrupted response body after headers arrived', async () => {
  const h = mainHarness(undefined, async (_input, init) => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'))
      init!.signal!.addEventListener('abort', () => controller.error(new Error('fixture body aborted')), { once: true })
    } })
    return new Response(body, { headers: { 'Content-Type': 'application/json' } })
  })
  try {
    const { authenticatedFetch } = h.load('src/main/network/sessionRefresh.ts')
    const start = Date.now()
    const response = await authenticatedFetch('fixture-token', 'https://fixture.invalid/api/translate', {}, 30000, start + 50)
    // Keep one ordinary timer alive: AbortSignal.timeout deliberately unrefs.
    const alive = setTimeout(() => {}, 500)
    try { await assert.rejects(response.json(), /fixture body aborted/) } finally { clearTimeout(alive) }
    assert.ok(Date.now() - start < 500)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('a late successful channel check cannot start translation after the operation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let calls = 0, release!: () => void
  const channel = new Promise<void>(resolve => { release = resolve })
  const h = mainHarness(undefined, async () => { calls++; return Response.json({}) })
  try {
    const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
    const provider = new CloudflareProvider('fixture', 'https://fixture.invalid')
    provider.verifySelectedChannel = () => channel
    const work = provider.translate({ requestId: 'send-expired', text: '你好呀', targetLanguage: 'en-US' })
    const rejected = assert.rejects(work, /暂时无法核对/)
    await tick(); t.mock.timers.tick(42001); await rejected
    release(); await tick(); assert.equal(calls, 0)
  } finally { t.mock.timers.reset(); rmSync(h.directory, { recursive: true, force: true }) }
})
