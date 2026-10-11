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
function fixture(options: { recognize?: (...args: any[]) => Promise<string | { text: string; language?: string }>; translate?: (...args: any[]) => Promise<string>; timeout?: number } = {}) {
  const h = mainHarness(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts')
  const recognitions: any[] = [], preparations: any[] = [], translations: any[] = []
  const service = new VoiceTranslationService({
    recognize: async (...args: any[]) => { recognitions.push(args); return options.recognize ? options.recognize(...args) : { text: 'Can you call me tomorrow morning?', language: 'en' } },
    prepare: async (request: any) => { preparations.push(request); return request },
    translate: async (request: any) => { translations.push(request); return options.translate ? options.translate(request) : request.targetLanguage === 'en-US' ? 'Can you call me tomorrow morning?' : '你明天早上能给我打电话吗？' }
  }, options.timeout)
  const input = (patch: any = {}) => ({ owner: 'owner', accountId: 'wa', conversationId: 'peer:123@c.us', messageId: 'voice:message', bytes: wav(), authorized: () => true, ...patch })
  return { ...h, service, recognitions, preparations, translations, input, close: () => { service.clear(); assert.match(relative(resolve(process.env.TEMP || ''), h.directory), /^hellodog-test-[a-zA-Z0-9]+$/); rmSync(h.directory, { recursive: true, force: true }) } }
}
test('one click transcribes locally and explicitly translates into Chinese using the selected provider', async () => {
  const h = fixture()
  try {
    const result = await h.service.translate(h.input({ providerPreference: 'openai' }))
    assert.equal(result.targetLanguage, 'zh-CN'); assert.equal(result.translation, '你明天早上能给我打电话吗？'); assert.match(result.audioId, /^[a-f0-9]{64}$/)
    assert.equal(result.englishTranslation, 'Can you call me tomorrow morning?')
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
test('Chinese speech retains its transcript and purchases only the required English translation', async () => {
  const h = fixture({ recognize: async () => '我明天会和你一起去吃早餐，然后再讨论工作安排。' })
  try { const result = await h.service.translate(h.input()); assert.equal(result.translation, result.text); assert.equal(result.englishTranslation, 'Can you call me tomorrow morning?'); assert.equal(h.translations.length, 1); assert.equal(h.translations[0].targetLanguage, 'en-US') } finally { h.close() }
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

test('English ASR language preserves a short transcript even when writing style settings are enabled', async () => {
  const h = fixture({ recognize: async () => ({ text: 'Call tomorrow.', language: 'en' }) })
  try {
    const result = await h.service.translate(h.input({ quality: { style: 'friendly' } }))
    assert.equal(result.englishTranslation, 'Call tomorrow.')
    assert.equal(h.translations.length, 1)
    assert.equal(h.translations[0].targetLanguage, 'zh-CN')
    await h.service.translate(h.input())
    assert.equal(h.recognitions.length, 1); assert.equal(h.translations.length, 1)
  } finally { h.close() }
})

test('third-language speech requests both targets concurrently with separate stable request IDs', async () => {
  const holds = new Map<string, ReturnType<typeof deferred<string>>>(), h = fixture({
    recognize: async () => ({ text: 'Bonjour, pouvez-vous rappeler demain ?', language: 'fr' }),
    translate: async request => { const hold = deferred(); holds.set(request.targetLanguage, hold); return hold.promise }
  })
  try {
    const job = h.service.translate(h.input())
    await until(() => holds.size === 2)
    assert.equal(h.recognitions.length, 1)
    assert.match(h.translations.find(request => request.targetLanguage === 'en-US').requestId, /^voice-en-[a-f0-9]{64}$/)
    holds.get('zh-CN')!.resolve('你好，可以明天回电话吗？')
    holds.get('en-US')!.resolve('Hello, could you call back tomorrow?')
    const result = await job
    assert.equal(result.englishTranslation, 'Hello, could you call back tomorrow?')
    assert.equal(result.translation, '你好，可以明天回电话吗？')
  } finally { h.close() }
})

test('ASR English metadata cannot bypass translating mixed Chinese speech into English', async () => {
  const h = fixture({ recognize: async () => ({ text: 'Hello 明天请给我打电话', language: 'en' }) })
  try { await h.service.translate(h.input()); assert.equal(h.translations.some(request => request.targetLanguage === 'en-US'), true) } finally { h.close() }
})

test('real bilingual receipts survive partial failure, transcript changes, cache clearing and separate same-audio messages', async () => {
  const h = fixture(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts'), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
  const { TranslationOutcomeError } = h.load('src/main/translation/providers/cloudflare.ts')
  const paid: any[] = []; let failEnglish = true, transcript = 'Bonjour, pouvez-vous rappeler demain ?'
  engine.setOnlineSession('owner', 'fixture-token'); engine.settings.get = async () => ({ provider: 'openai' })
  engine.createProvider = () => ({ translate: async (request: any) => {
    if (request.targetLanguage === 'en-US' && failEnglish) throw new TranslationOutcomeError('synthetic English failure', true)
    paid.push(request)
    const translated = request.targetLanguage === 'en-US' ? 'Hello, could you call tomorrow?' : '你好，明天可以打电话吗？'
    await engine.receipts.update('owner', request.requestId, { state: 'charged', translated, chargedCharacters: request.text.length })
    return translated
  } })
  const service = new VoiceTranslationService({ recognize: async () => ({ text: transcript, language: 'fr' }),
    prepare: (request: any) => engine.preserveVoiceRequest(request), translate: (request: any) => engine.translateIncoming(request, true) })
  try {
    await assert.rejects(service.translate(h.input()), /synthetic English failure/)
    await engine.flush(); assert.equal(paid.length, 1)
    service.clear(); await engine.clearCache(); transcript = 'Bonjour, rappelle-moi demain.'; failEnglish = false
    const result = await service.translate(h.input({ providerPreference: 'openai' }))
    assert.equal(result.englishTranslation, 'Hello, could you call tomorrow?'); assert.equal(paid.length, 2)
    assert.equal(result.text, 'Bonjour, pouvez-vous rappeler demain ?')
    await service.translate(h.input()); assert.equal(paid.length, 2)
    service.clear(); await engine.clearCache(); await service.translate(h.input()); assert.equal(paid.length, 2)
    await service.translate(h.input({ messageId: 'different-message-same-audio' })); assert.equal(paid.length, 4)
    assert.equal(new Set(paid.map(request => request.requestId)).size, 4)
    assert.equal(paid.filter(request => request.targetLanguage === 'en-US').length, 2)
    assert.equal(paid.filter(request => request.targetLanguage === 'zh-CN').length, 2)
    // The existing ledger may issue a recovery ID only for a confirmed,
    // uncharged failure. Both later replays above still recover that receipt.
    await assert.rejects(engine.preserveVoiceRequest({ ...paid[0], targetLanguage: paid[0].targetLanguage === 'en-US' ? 'zh-CN' : 'en-US' }), /请求无效/)
    await engine.trackContent([{ owner: 'owner', accountId: 'wa', conversationId: 'peer:123@c.us', identity: 'voice:message', expiresAt: Date.now() - 1, reason: 'message' }])
    await assert.rejects(service.translate(h.input()), /失效|过期/)
    assert.equal(paid.length, 4)
  } finally { service.clear(); h.close() }
})

test('Chinese speech recovers its original transcript from the English-only paid receipt after restart', async () => {
  const h = fixture(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts'), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
  let transcript = '我明天会和你一起去吃早餐，然后讨论工作安排。', calls = 0
  engine.setOnlineSession('owner', 'fixture-token'); engine.settings.get = async () => ({ provider: 'openai' })
  engine.createProvider = () => ({ translate: async (request: any) => {
    calls++; const translated = 'I will have breakfast with you tomorrow, then discuss the work schedule.'
    await engine.receipts.update('owner', request.requestId, { state: 'charged', translated, chargedCharacters: request.text.length }); return translated
  } })
  const service = new VoiceTranslationService({ recognize: async () => ({ text: transcript, language: 'zh' }), prepare: (request: any) => engine.preserveVoiceRequest(request), translate: (request: any) => engine.translateIncoming(request, true) })
  try {
    const first = await service.translate(h.input()); assert.equal(calls, 1)
    service.clear(); await engine.clearCache(); transcript = '明天我会和你一起吃早饭，再谈工作。'
    const second = await service.translate(h.input())
    assert.equal(second.text, first.text); assert.equal(second.translation, first.translation); assert.equal(second.englishTranslation, first.englishTranslation); assert.equal(calls, 1)
  } finally { service.clear(); h.close() }
})

for (const scenario of [
  { name: 'English speech', language: 'en', text: 'Could you please call me tomorrow morning?', target: 'zh-CN', paid: 1 },
  { name: 'Chinese speech with only an English receipt', language: 'zh', text: '我明天会和你一起去吃早餐，然后讨论工作安排。', target: 'en-US', paid: 1 },
  { name: 'third-language speech with a cleared English receipt', language: 'fr', text: 'Bonjour, pouvez-vous rappeler demain ?', target: 'en-US', paid: 2 },
  { name: 'third-language speech with a cleared Chinese receipt', language: 'fr', text: 'Bonjour, pouvez-vous rappeler demain ?', target: 'zh-CN', paid: 2 }
]) {
  test(`completed bilingual cache validates each durable target: ${scenario.name}`, async () => {
    const h = fixture(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts'), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
    const paid: any[] = []; let recognitions = 0
    engine.setOnlineSession('owner', 'fixture-token'); engine.settings.get = async () => ({ provider: 'openai' })
    engine.createProvider = () => ({ translate: async (request: any) => {
      paid.push(request)
      const translated = request.targetLanguage === 'en-US' ? 'Could you call me tomorrow morning?' : '你明天早上能给我打电话吗？'
      await engine.receipts.update('owner', request.requestId, { state: 'charged', translated, chargedCharacters: request.text.length })
      return translated
    } })
    const service = new VoiceTranslationService({ recognize: async () => { recognitions++; return { text: scenario.text, language: scenario.language } },
      prepare: (request: any) => engine.preserveVoiceRequest(request), translate: (request: any) => engine.translateIncoming(request, true) })
    try {
      const input = h.input(), first = await service.translate(input)
      assert.equal(paid.length, scenario.paid)
      assert.deepEqual(await service.translate(input), first); assert.equal(recognitions, 1); assert.equal(paid.length, scenario.paid)
      const receipt = paid.find(request => request.targetLanguage === scenario.target)
      assert.ok(receipt)
      // Exercise a target-specific ledger decision, independently of the shared
      // message tombstone. No cached result may bypass either target's record.
      await engine.receipts.update('owner', receipt.requestId, { contentExpired: true, translated: undefined })
      await assert.rejects(service.translate(input), /失效|过期/)
      await assert.rejects(service.translate(input), /失效|过期/)
      assert.equal(recognitions, 1); assert.equal(paid.length, scenario.paid)
    } finally { service.clear(); await engine.flush(); h.close() }
  })
}

test('Chinese completed cache respects message retention and request-specific cleanup without a second charge', async () => {
  for (const mode of ['retention', 'request'] as const) {
    const h = fixture(), { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts'), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
    let calls = 0, requestId = '', recognitions = 0
    engine.setOnlineSession('owner', 'fixture-token'); engine.settings.get = async () => ({ provider: 'openai' })
    engine.createProvider = () => ({ translate: async (request: any) => {
      calls++; requestId = request.requestId
      const translated = 'Could you call me tomorrow morning?'
      await engine.receipts.update('owner', request.requestId, { state: 'charged', translated, chargedCharacters: request.text.length })
      return translated
    } })
    const service = new VoiceTranslationService({ recognize: async () => { recognitions++; return { text: '你明天早上能给我打电话吗？', language: 'zh' } },
      prepare: (request: any) => engine.preserveVoiceRequest(request), translate: (request: any) => engine.translateIncoming(request, true) })
    try {
      await service.translate(h.input()); assert.equal(calls, 1)
      if (mode === 'retention') {
        await engine.receipts.update('owner', requestId, { createdAt: Date.now() - 8 * 86400000 })
        await engine.setRetention(7)
        assert.equal((await engine.receipts.get('owner', requestId)).contentExpired, true)
      } else {
        // The cleanup API can target a receipt instead of the shared message.
        // There is no Chinese receipt to detect this English-only expiry.
        await engine.trackContent([{ owner: 'owner', accountId: 'wa', conversationId: 'peer:123@c.us', identity: requestId, expiresAt: Date.now() - 1, reason: 'message' }])
        assert.equal((await engine.receipts.get('owner', requestId)).contentExpired, true)
      }
      await assert.rejects(service.translate(h.input()), /失效|过期|清理/)
      assert.equal(calls, 1); assert.equal(recognitions, 1)
    } finally { service.clear(); await engine.flush(); h.close() }
  }
})
