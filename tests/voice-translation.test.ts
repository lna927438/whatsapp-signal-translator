import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { mainHarness } from './main-harness.ts'

function wav(seed = 1) {
  const bytes = new Uint8Array(6444), view = new DataView(bytes.buffer)
  for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
  for (const [at, value] of [[4, bytes.length - 8], [16, 16], [24, 16000], [28, 32000], [40, bytes.length - 44]]) view.setUint32(at, value, true)
  for (const [at, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(at, value, true)
  for (let i = 44; i < bytes.length; i += 2) view.setInt16(i, Math.round(Math.sin(i / (10 + seed)) * 10000), true)
  return bytes
}
function deferred<T = string>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()) }
function fixture(options: { recognize?: (...args: any[]) => Promise<string>; translate?: (...args: any[]) => Promise<string>; timeout?: number } = {}) {
  const h = mainHarness(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts')
  const recognitions: any[] = [], preparations: any[] = [], translations: any[] = []
  const service = new VoiceTranslationService({
    recognize: async (...args: any[]) => { recognitions.push(args); return options.recognize ? options.recognize(...args) : 'Can you call me tomorrow morning?' },
    prepare: async (request: any) => { preparations.push(request); return request },
    translate: async (request: any) => { translations.push(request); return options.translate ? options.translate(request) : '你明天早上能给我打电话吗？' }
  }, options.timeout)
  const input = (patch: any = {}) => ({ owner: 'owner', accountId: 'wa', conversationId: 'peer:123@c.us', messageId: 'voice:message', bytes: wav(), authorized: () => true, ...patch })
  return { ...h, service, recognitions, preparations, translations, input, close: () => { service.clear(); assert.match(relative(resolve(process.env.TEMP || ''), h.directory), /^hellodog-test-[a-zA-Z0-9]+$/); rmSync(h.directory, { recursive: true, force: true }) } }
}
test('one click transcribes locally and explicitly translates into Chinese using the selected provider', async () => {
  const h = fixture()
  try {
    const result = await h.service.translate(h.input({ providerPreference: 'openai' }))
    assert.equal(result.targetLanguage, 'zh-CN'); assert.equal(result.translation, '你明天早上能给我打电话吗？'); assert.match(result.audioId, /^[a-f0-9]{64}$/)
    assert.equal(h.recognitions.length, 1); assert.equal(h.translations.length, 1)
    const request = h.translations[0]; assert.equal(request.targetLanguage, 'zh-CN'); assert.equal(request.sourceLanguage, 'auto'); assert.equal(request.providerPreference, 'openai')
    assert.equal(request.messageId, 'voice:message'); assert.match(request.requestId, /^voice-zh-[a-f0-9]{64}$/)
    assert.ok(!Object.hasOwn(request, 'bytes')); assert.ok(!Object.hasOwn(request, 'audioBase64'))
  } finally { h.close() }
})
test('duplicate clicks share recognition and one translation; retry after a provider error reuses transcript and immutable request', async () => {
  const hold = deferred(), h = fixture({ translate: () => hold.promise })
  try {
    const jobs = Array.from({ length: 8 }, () => h.service.translate(h.input()))
    const rejected = Promise.all(jobs.map(job => assert.rejects(job, /offline/)))
    await until(() => h.translations.length === 1); hold.reject(new Error('offline')); await rejected
    assert.equal(h.recognitions.length, 1)
    await assert.rejects(h.service.translate(h.input()), /offline/)
    assert.equal(h.recognitions.length, 1); assert.equal(h.translations[0].requestId, h.translations[1].requestId)
  } finally { h.close() }
})
test('local ASR runs serially across windows; a bounded queue rejects excess jobs without starting them', async () => {
  const holds: ReturnType<typeof deferred<string>>[] = [], h = fixture({ recognize: async () => { const item = deferred(); holds.push(item); return item.promise } })
  try {
    const jobs = Array.from({ length: 6 }, (_, i) => h.service.translate(h.input({ messageId: 'message-' + i, bytes: wav(i + 1) })))
    await until(() => holds.length === 1)
    await assert.rejects(h.service.translate(h.input({ messageId: 'excess' })), /较多/)
    for (let i = 0; i < 6; i++) { await until(() => holds.length === i + 1); holds[i].resolve('Please call tomorrow.'); await jobs[i] }
    assert.equal(h.recognitions.length, 6)
  } finally { h.close() }
})
test('invalid or silent audio and expired messages cannot reach recognition or charging', async () => {
  const h = fixture()
  try {
    for (const patch of [{ bytes: new Uint8Array([1]) }, { bytes: wav().fill(0) }, { expiresAt: Date.now() - 1 }, { authorized: () => false }]) await assert.rejects(h.service.translate(h.input(patch)))
    assert.equal(h.recognitions.length, 0); assert.equal(h.translations.length, 0)
  } finally { h.close() }
})
test('logout cancels queued work and clears transcripts; old recognition never starts paid translation', async () => {
  const hold = deferred(), h = fixture({ recognize: () => hold.promise })
  try {
    const first = h.service.translate(h.input()), firstRejected = assert.rejects(first, /状态已变化/)
    const queued = h.service.translate(h.input({ messageId: 'second' })), queueRejected = assert.rejects(queued, /状态已变化/)
    await until(() => h.recognitions.length === 1); h.service.clear(); await queueRejected
    hold.resolve('Private previous transcript.'); await firstRejected
    assert.equal(h.translations.length, 0); assert.equal(h.recognitions.length, 1)
  } finally { h.close() }
})
test('an expired or switched message cannot return a late translation', async () => {
  const hold = deferred(), h = fixture({ translate: () => hold.promise }); let valid = true
  try {
    const job = h.service.translate(h.input({ authorized: () => valid })), rejected = assert.rejects(job, /状态已变化/)
    await until(() => h.translations.length === 1); valid = false; hold.resolve('旧窗口译文'); await rejected
  } finally { h.close() }
})
test('same audio stays isolated across accounts and messages; local files have a stable audio identity', async () => {
  const h = fixture()
  try {
    await h.service.translate(h.input()); await h.service.translate(h.input({ accountId: 'other' })); await h.service.translate(h.input({ messageId: 'other' }))
    await h.service.translate(h.input({ messageId: undefined })); await h.service.translate(h.input({ messageId: undefined }))
    assert.equal(new Set(h.translations.map(request => request.requestId)).size, 4); assert.equal(h.recognitions.length, 4)
  } finally { h.close() }
})
test('already Chinese speech shows its transcript without purchasing text translation', async () => {
  const h = fixture({ recognize: async () => '我明天会和你一起去吃早餐，然后再讨论工作安排。' })
  try { const result = await h.service.translate(h.input()); assert.equal(result.translation, result.text); assert.equal(h.translations.length, 0) } finally { h.close() }
})
test('overall timeout releases the UI and invalidates late work before charging', async () => {
  const hold = deferred(), h = fixture({ recognize: () => hold.promise, timeout: 30 })
  try {
    const job = h.service.translate(h.input()), rejected = assert.rejects(job, /超时/)
    await new Promise(resolve => setTimeout(resolve, 60)); await rejected
    hold.resolve('Late recognition.'); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(h.translations.length, 0)
  } finally { h.close() }
})
test('blank recognition/translation cannot masquerade as completed Chinese', async () => {
  for (const options of [{ recognize: async () => '   ' }, { translate: async () => '  ' }]) {
    const h = fixture(options); try { await assert.rejects(h.service.translate(h.input()), /清晰人声|未取得中文/) } finally { h.close() }
  }
})
test('real billing engine recovers original transcript and charge after recognition changes or cache clearing', async () => {
  const h = fixture(), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
  try {
    const paid: any[] = []; engine.setOnlineSession('owner', 'fixture-token'); engine.settings.get = async () => ({ provider: 'openai' })
    engine.createProvider = () => ({ translate: async (request: any) => { paid.push(request); await engine.receipts.update('owner', request.requestId, { state: 'charged', translated: '明天请给我打电话。', chargedCharacters: request.text.length }); return '明天请给我打电话。' } })
    const request = { requestId: 'voice-zh-' + 'a'.repeat(64), text: 'Please call me tomorrow.', sourceLanguage: 'auto', targetLanguage: 'zh-CN', accountId: 'wa', conversationId: 'peer', messageId: 'original-voice', providerPreference: 'deepseek' }
    await engine.translateIncoming(await engine.preserveVoiceRequest(request), true); await engine.flush(); await engine.clearCache()
    const recovered = await engine.preserveVoiceRequest({ ...request, text: 'Call me tomorrow please.', providerPreference: 'openai' })
    assert.equal(recovered.text, request.text); assert.equal(recovered.providerPreference, 'deepseek')
    assert.equal(await engine.translateIncoming(recovered, true), '明天请给我打电话。'); assert.equal(paid.length, 1)
    await engine.trackContent([{ owner: 'owner', accountId: 'wa', conversationId: 'peer', identity: 'original-voice', expiresAt: Date.now() - 1, reason: 'message' }])
    await assert.rejects(engine.preserveVoiceRequest(request), /失效|过期/)
  } finally { h.close() }
})
