import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

const original = 'What is your point of view?'
const invalid = '作为一个人工智能，我没有个人观点或情感。'
const corrected = '你的观点是什么？'
const request = { text: original, sourceLanguage: 'auto', targetLanguage: 'zh-CN', accountId: 'signal-a', conversationId: 'signal:peer', messageId: 'peer:42', requestId: 'sd-semantic-fixture', context: [], cacheUserId: 'owner' }
function fixture() {
  const h = mainHarness(), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts')
  const create = () => { const engine = new TranslationEngine(); engine.setOnlineSession('owner', 'fixture'); engine.settings.get = async () => ({ provider: 'openai' }); engine.createProvider = () => { throw Error('No additional paid API call is allowed') }; engine.cloudProvider = () => ({ repair: async () => { throw Error('Repair unavailable in this fixture') } }); return engine }
  const engine = create()
  const seed = async (input = request, translated = invalid) => {
    await engine.receipts.prepare('owner', 'openai', input)
    await engine.receipts.update('owner', input.requestId, { state: 'charged', translated, chargedCharacters: Array.from(input.text).length, balanceAfter: 800 })
    await engine.cache.set('openai', input, translated)
  }
  return { ...h, engine, create, seed, close: () => rmSync(h.directory, { recursive: true, force: true }) }
}

test('settled bad translations are quarantined across restart without a new request, charge, or global cache clear', async () => {
  const f = fixture(); try {
    await f.seed(); await f.seed({ ...request, messageId: 'other', requestId: 'sd-other' }, corrected)
    const engine = f.create()
    assert.equal(await engine.cached(request), undefined)
    await assert.rejects(engine.translateIncoming(request, true), (error: any) => error.confirmedFailure === false && /免费修正/.test(error.message))
    const rows = await engine.history(), bad = rows.find((row: any) => row.requestId === request.requestId)
    assert.equal(bad.state, 'charged'); assert.equal(bad.chargedCharacters, original.length); assert.equal(bad.balanceAfter, 800)
    assert.equal(bad.translationIssue, 'semantic_mismatch'); assert.equal(bad.translated, invalid); assert.equal(rows.length, 2)
    assert.equal(await engine.cached({ ...request, messageId: 'other', requestId: 'sd-other' }), corrected)
    assert.equal((await engine.messageRequests.store.read())[request.requestId], undefined)
  } finally { f.close() }
})

test('free correction replaces a bad annotation even if the cache write failed, retaining the exact paid record', async () => {
  const f = fixture(); try {
    await f.seed()
    const set = f.engine.cache.set.bind(f.engine.cache); f.engine.cache.set = async () => { throw Error('simulated cache disk failure') }
    await assert.rejects(f.engine.correct(request.requestId, corrected), /disk/)
    f.engine.cache.set = set
    const engine = f.create()
    assert.equal(await engine.cached(request), corrected)
    assert.equal(await engine.translateIncoming(request, true), corrected)
    const [receipt] = await engine.history(); assert.equal(receipt.translationIssue, undefined); assert.equal(receipt.correction, corrected)
    assert.equal(receipt.state, 'charged'); assert.equal(receipt.chargedCharacters, original.length); assert.equal(receipt.requestId, request.requestId)
    await assert.rejects(engine.restoreCorrection(request.requestId), /免费修正/)
    assert.equal(await engine.cached(request), corrected)
  } finally { f.close() }
})

test('explicit human corrections remain authoritative, while another account or changed original cannot read them', async () => {
  const f = fixture(); try {
    await f.seed(); await f.engine.correct(request.requestId, invalid)
    assert.equal(await f.engine.cached(request), invalid)
    assert.equal((await f.engine.history())[0].translationIssue, undefined)
    assert.equal(await f.engine.cached({ ...request, text: 'A different original' }), undefined)
    f.engine.setOnlineSession('another-owner', 'fixture'); assert.equal(await f.engine.cached(request), undefined)
  } finally { f.close() }
})

test('a legacy cache-only bad answer stays local and becomes free-correctable without paying for a replacement', async () => {
  const f = fixture(); try {
    await f.engine.cache.set('openai', request, invalid)
    assert.equal(await f.engine.cached(request), undefined)
    await assert.rejects(f.engine.translateIncoming(request, true), /免费修正/)
    const [receipt] = await f.engine.history(); assert.equal(receipt.state, 'cached'); assert.equal(receipt.chargedCharacters, 0)
    await f.engine.correct(request.requestId, corrected); assert.equal(await f.engine.cached(request), corrected)
  } finally { f.close() }
})

test('an old cloud success is preserved as charged before rejecting its semantic output; there is one original POST', async () => {
  const calls: string[] = [], settled: any[] = []
  const h = mainHarness(undefined, async (_url, init) => { calls.push(String(init?.method || 'GET')); return Response.json({ requestId: request.requestId, translation: invalid, sourceCharacters: original.length, balanceAfter: 800 }) })
  try {
    const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
    const provider = new CloudflareProvider('fixture', 'https://translation.invalid', async (receipt: any) => { settled.push(receipt) })
    await assert.rejects(provider.translate(request), (error: any) => error.confirmedFailure === false && /免费修正/.test(error.message))
    assert.deepEqual(calls, ['POST']); assert.equal(settled.length, 1); assert.equal(settled[0].sourceCharacters, original.length)
    assert.equal(settled[0].requestId, request.requestId)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('confirmed provider_not_translation is terminal and uncharged instead of polling or creating another ID', async () => {
  let calls = 0
  const h = mainHarness(undefined, async () => { calls++; return Response.json({ error: 'provider_not_translation' }, { status: 502 }) })
  try {
    const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
    await assert.rejects(new CloudflareProvider('fixture', 'https://translation.invalid').translate(request), (error: any) => error.confirmedFailure === true && /未扣费/.test(error.message))
    assert.equal(calls, 1)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('recovering an old bad cloud result settles honestly and never replays the provider or authorizes sending it', async () => {
  const f = fixture(); try {
    const sending = { ...request, requestId: 'send-sd-semantic' }
    await f.engine.receipts.prepare('owner', 'openai', sending); await f.engine.receipts.update('owner', sending.requestId, { state: 'pending' })
    let lookups = 0; f.engine.cloudProvider = () => ({ status: async () => { lookups++; return { state: 'completed', response: { requestId: sending.requestId, translation: invalid, sourceCharacters: original.length, balanceAfter: 800 } } } })
    await f.engine.reconcilePending(); await f.engine.reconcilePending(); assert.equal(lookups, 1)
    const [receipt] = await f.engine.history(); assert.equal(receipt.state, 'charged'); assert.equal(receipt.chargedCharacters, original.length)
    assert.equal(await f.engine.cached(sending), undefined)
    await assert.rejects(f.engine.existingOutgoing(sending.requestId, sending.accountId, sending.conversationId, original, invalid), /免费修正/)
    await f.engine.correct(sending.requestId, corrected)
    assert.equal((await f.engine.existingOutgoing(sending.requestId, sending.accountId, sending.conversationId, original, corrected)).requestId, sending.requestId)
  } finally { f.close() }
})

test('ordinary source-derived AI statements and refusals are still valid historical translations', async () => {
  const f = fixture(); try {
    const source = { ...request, text: 'As an AI, I do not have personal opinions or emotions.' }
    await f.seed(source, invalid)
    assert.equal(await f.engine.cached(source), invalid)
    assert.equal(await f.engine.translateIncoming(source), invalid)
    assert.equal((await f.engine.history())[0].translationIssue, undefined)
  } finally { f.close() }
})

test('classic Signal quarantines persisted display copies without editing the sent archive and overlays free corrections', async () => {
  const f = fixture(); try {
    const { SignalAdapter } = f.load('src/main/platforms/signal/signalAdapter.ts')
    const adapter = new SignalAdapter(f.engine); adapter.setOnlineUser('owner')
    adapter.accounts.list = async () => [{ id: 'signal-a', platform: 'signal', signalAccount: '+12025550100' }]
    const message = { account: '+12025550100', peer: 'peer', timestamp: 42, fromMe: true, original, displayTranslated: invalid }
    await adapter.rememberMessage('owner', message); await f.seed()
    let shown = (await adapter.loadHistory(message.account))[0]
    assert.equal(shown.original, original); assert.equal(shown.displayTranslated, undefined); assert.equal(shown.translated, undefined)
    assert.equal((await adapter.historyStore.read())[0].displayTranslated, invalid)
    await f.engine.correct(request.requestId, corrected); shown = (await adapter.loadHistory(message.account))[0]
    assert.equal(shown.displayTranslated, corrected); assert.equal(shown.original, original)
    const local = { ...message, timestamp: 43, taskId: 'send-sd-local', translated: invalid, displayTranslated: undefined }
    await adapter.rememberMessage('owner', local)
    await f.seed({ ...request, messageId: 'peer:43', requestId: local.taskId })
    await assert.rejects(adapter.translateMessage('signal-a', local), /免费修正/)
    await f.engine.correct(local.taskId, corrected); assert.equal(await adapter.translateMessage('signal-a', local), corrected)
    assert.equal((await adapter.historyStore.read()).find((item: any) => item.taskId === local.taskId).translated, invalid)
  } finally { f.close() }
})

test('concurrent paid-cache repairs reuse one immutable job and replace the cached answer across restart without another debit', async () => {
  const f = fixture(); try {
    await f.seed()
    let repairs = 0
    f.engine.cloudProvider = () => ({ repair: async (input: any) => { repairs++; assert.equal(input.requestId, request.requestId); await new Promise(resolve => setTimeout(resolve, 5)); return { translation: corrected } } })
    const outputs = await Promise.all(Array.from({ length: 8 }, () => f.engine.translateIncoming(request, true)))
    assert.ok(outputs.every(value => value === corrected)); assert.equal(repairs, 1)
    const [receipt] = await f.engine.history(); assert.equal(receipt.state, 'charged'); assert.equal(receipt.chargedCharacters, original.length)
    assert.equal(receipt.balanceAfter, 800); assert.equal(receipt.translated, invalid); assert.equal(receipt.correction, corrected); assert.equal(receipt.correctionSource, 'cloud-repair')
    assert.equal(receipt.requestId, request.requestId); assert.equal((await f.engine.history()).length, 1)
    const reopened = f.create(); assert.equal(await reopened.cached(request), corrected); assert.equal(await reopened.translateIncoming(request), corrected)
  } finally { f.close() }
})

test('manual edits made during an automatic repair win, including text the automatic guard would reject', async () => {
  const f = fixture(); try {
    await f.seed(); let finish: (value: any) => void = () => {}, started: () => void = () => {}
    const ready = new Promise<void>(resolve => { started = resolve })
    f.engine.cloudProvider = () => ({ repair: () => new Promise(resolve => { finish = resolve; started() }) })
    const repair = f.engine.translateIncoming(request); await ready
    await f.engine.correct(request.requestId, invalid); finish({ translation: corrected })
    assert.equal(await repair, invalid); assert.equal(await f.engine.cached(request), invalid)
    assert.equal((await f.engine.history())[0].correctionSource, 'manual')
  } finally { f.close() }
})

test('session changes and content expiry during automatic repair prevent old-account or expired annotation writes', async () => {
  for (const change of ['session', 'expiry']) {
    const f = fixture(); try {
      await f.seed(); let finish: (value: any) => void = () => {}, started: () => void = () => {}
      const ready = new Promise<void>(resolve => { started = resolve })
      f.engine.cloudProvider = () => ({ repair: () => new Promise(resolve => { finish = resolve; started() }) })
      const repair = f.engine.translateIncoming(request); await ready
      if (change === 'session') f.engine.setOnlineSession('another-owner', 'fixture')
      else await f.engine.receipts.expireMessage('owner', request.accountId, request.conversationId, request.messageId)
      finish({ translation: corrected }); await assert.rejects(repair, /登录状态|过期/)
      const saved = await f.engine.receipts.get('owner', request.requestId); assert.equal(saved.correction, undefined); assert.equal(saved.chargedCharacters, original.length)
    } finally { f.close() }
  }
})

test('failed free repair keeps quarantine and local edits available, with no automatic rapid retry or paid fallback', async () => {
  const f = fixture(); try {
    await f.seed(); let repairs = 0
    f.engine.cloudProvider = () => ({ repair: async () => { repairs++; throw Error('repair service temporarily unavailable') } })
    await assert.rejects(f.engine.translateIncoming(request, true), /免费修正/)
    await assert.rejects(f.engine.translateIncoming(request, true), /免费修正/)
    assert.equal(repairs, 1); assert.equal((await f.engine.history())[0].state, 'charged')
    await f.engine.correct(request.requestId, corrected); assert.equal(await f.engine.translateIncoming(request), corrected)
  } finally { f.close() }
})

test('repair transport validates zero-charge proof and never invokes ordinary settlement for a repaired response', async () => {
  const { createHash } = await import('node:crypto')
  const expectedId = 'repair-' + createHash('sha256').update('semantic-repair-v1:' + request.requestId).digest('hex')
  const proof = { requestId: request.requestId, translation: corrected, sourceCharacters: original.length, balanceAfter: 790, chargedCharacters: 0, repairRequestId: expectedId, repairOf: request.requestId }
  for (const patch of [null, { chargedCharacters: 1 }, { repairOf: 'wrong-original' }, { repairRequestId: 'repair-' + '0'.repeat(64) }, { translation: invalid }, { sourceCharacters: original.length + 1 }]) {
    let settlements = 0; const calls: any[] = []
    const h = mainHarness(undefined, async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ ...proof, ...patch }) })
    try {
      const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts')
      const provider = new CloudflareProvider('fixture', 'https://translation.invalid', async () => { settlements++ })
      if (patch) await assert.rejects(provider.repair(request)); else assert.equal((await provider.repair(request)).translation, corrected)
      assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/api/translation-repair')); assert.equal(calls[0].body.requestId, request.requestId); assert.equal(settlements, 0)
    } finally { rmSync(h.directory, { recursive: true, force: true }) }
  }
})

test('lost repair responses query only the original repair status; older unsupported servers preserve quarantine', async () => {
  const { createHash } = await import('node:crypto')
  const response = { requestId: request.requestId, translation: corrected, sourceCharacters: original.length, balanceAfter: 790, chargedCharacters: 0, repairRequestId: 'repair-' + createHash('sha256').update('semantic-repair-v1:' + request.requestId).digest('hex'), repairOf: request.requestId }
  for (const unsupported of [false, true]) {
    const calls: any[] = []
    const h = mainHarness(undefined, async (url, init) => { calls.push({ url: String(url), method: init?.method || 'GET' }); if (unsupported) return new Response('Not found', { status: 404 }); if (init?.method === 'POST') throw Error('response lost'); return Response.json({ state: 'completed', response }) })
    try {
      const { CloudflareProvider } = h.load('src/main/translation/providers/cloudflare.ts'); const provider = new CloudflareProvider('fixture', 'https://translation.invalid')
      if (unsupported) await assert.rejects(provider.repair(request)); else assert.equal((await provider.repair(request)).translation, corrected)
      assert.equal(calls.filter(call => call.method === 'POST').length, 1)
      assert.ok(calls.every(call => call.url.includes('/api/translation-repair')))
      if (!unsupported) assert.ok(calls[1].url.endsWith('requestId=' + encodeURIComponent(request.requestId)))
    } finally { rmSync(h.directory, { recursive: true, force: true }) }
  }
})
