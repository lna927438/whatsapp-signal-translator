import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

test('slow in-flight translation survives a transient status outage and more than four polls without reposting or double settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 })
  let posts = 0, polls = 0, settlements = 0
  const ids: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      posts++; ids.push(JSON.parse(String(init.body)).requestId)
      return Response.json({ error: 'translation_processing' }, { status: 202 })
    }
    polls++; ids.push(url.searchParams.get('requestId')!)
    if (polls === 1) throw new TypeError('fixture: brief lost status response')
    if (polls < 6) return Response.json({ state: 'processing' })
    return Response.json({ state: 'completed', response: { requestId: 'send-slow', translation: 'Hello there.', sourceCharacters: 3, balanceAfter: 97 } })
  }
  const h = mainHarness(undefined, fetcher)
  try {
    const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
    const provider = new CloudflareProvider('fixture', 'https://fixture.invalid', async () => { settlements++ })
    let complete = false, output: string | undefined, failed: unknown
    const work = provider.translate({ requestId: 'send-slow', text: '你好呀', targetLanguage: 'en-US' })
      .then((value: string) => { output = value }, (error: unknown) => { failed = error }).finally(() => { complete = true })
    for (let tick = 0; tick < 60 && !complete; tick++) {
      await new Promise(resolve => setImmediate(resolve))
      t.mock.timers.tick(1000)
    }
    await work
    assert.equal(failed, undefined); assert.equal(output, 'Hello there.')
    assert.equal(posts, 1); assert.equal(polls, 6); assert.equal(settlements, 1)
    assert.deepEqual([...new Set(ids)], ['send-slow'])
  } finally { t.mock.timers.reset(); rmSync(h.directory, { recursive: true, force: true }) }
})

test('a never-completed cloud result releases the operation within its budget and keeps settlement uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 })
  let posts = 0, polls = 0, settled = 0
  const h = mainHarness(undefined, async (_input, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ error: 'translation_processing' }, { status: 202 }) }
    polls++; return Response.json({ state: 'processing' })
  })
  try {
    const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
    const provider = new CloudflareProvider('fixture', 'https://fixture.invalid', async () => { settled++ })
    let done = false, rejected: any
    const work = provider.translate({ requestId: 'send-uncertain', text: '你好呀', targetLanguage: 'en-US' })
      .catch((error: unknown) => { rejected = error }).finally(() => { done = true })
    for (let tick = 0; tick < 60 && !done; tick++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000) }
    await work
    assert.match(rejected?.message, /结果待确认/); assert.equal(rejected?.confirmedFailure, false)
    assert.equal(posts, 1); assert.equal(polls, 12); assert.equal(settled, 0)
    assert.ok(Date.now() - 1700000000000 <= 42000)
  } finally { t.mock.timers.reset(); rmSync(h.directory, { recursive: true, force: true }) }
})
