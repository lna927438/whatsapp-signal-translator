import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mainHarness } from './main-harness.ts'
import type { GoogleVoiceEmbeddedDraftData } from '../src/main/platforms/googleVoice/embeddedTranslation'
import type { GoogleVoiceDispatchData } from '../src/main/platforms/googleVoice/dispatchLedger'
import type { RuntimeSettings } from '../src/main/types'

const accountId = 'gv-00000000-0000-4000-8000-000000000001'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const conversationId = 'gv_' + hash(['/u/0/messages', 't.migration-fixture'])
const source = '我计划明天下午查看新的项目进度，你什么时候方便？'
const translated = 'I plan to review the new project progress tomorrow afternoon. When are you available?'

function fixture() {
  const h = mainHarness()
  const { TranslationEngine } = h.load('src/main/translation/translationEngine.ts')
  const { GoogleVoiceEmbeddedTranslation } = h.load('src/main/platforms/googleVoice/embeddedTranslation.ts')
  const { createGoogleVoiceTranslator } = h.load('src/main/platforms/googleVoice/translationBridge.ts')
  const { GoogleVoiceDispatchLedger } = h.load('src/main/platforms/googleVoice/dispatchLedger.ts')
  const preferences: RuntimeSettings = { provider: 'openai', localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, blockChineseSend: true, groupTranslate: false, fontSize: 13, translationColor: '#fff', historyMode: 'visible' }
  let drafts: GoogleVoiceEmbeddedDraftData = { records: {} }, dispatchData: GoogleVoiceDispatchData = { records: [] }, revision = 0
  let currentUrl = 'https://voice.google.com/u/0/messages?itemId=t.migration-fixture'
  const providerCalls: string[] = [], settlements: string[] = []
  const storage = { read: async () => structuredClone(drafts), write: async (value: GoogleVoiceEmbeddedDraftData) => { drafts = structuredClone(value) } }
  const dispatchStore = { read: async () => structuredClone(dispatchData), write: async (value: GoogleVoiceDispatchData) => { dispatchData = structuredClone(value) } }
  let engine: any, run: any, bridge: any, dispatch: any
  const restart = () => {
    dispatch = new GoogleVoiceDispatchLedger(dispatchStore)
    engine = new TranslationEngine(); engine.setOnlineSession('owner', 'fixture-only')
    engine.settings.get = async () => preferences
    engine.createProvider = () => ({ translate: async (request: any) => {
      providerCalls.push(request.requestId)
      await engine.receipts.update('owner', request.requestId, { state: 'charged', translated, chargedCharacters: Array.from(request.text).length })
      return translated
    } })
    engine.cloudProvider = () => ({ status: async (id: string) => { settlements.push(id); return { state: 'processing' } } })
    run = createGoogleVoiceTranslator(engine, { check: async () => true }, async () => preferences, dispatch)
    bridge = new GoogleVoiceEmbeddedTranslation({ storage, translate: run, trustedPage: () => {
      const captured = revision
      return { owner: 'owner', accountId, url: currentUrl, authorized: () => revision === captured }
    } })
  }
  restart()
  const seed = async (text = source, id = randomUUID()) => {
    const payload = { direction: 'outgoing', id, conversationId, text }
    const result = await run('owner', accountId, 'translate', payload, () => true)
    return { payload, result }
  }
  const request = (type: string, payload?: unknown) => bridge.request({}, { v: 1, type: 'voice.' + type, payload })
  const logicalId = (text = source) => request('outgoing-id', { conversationId, text })
  return { seed, request, logicalId, restart, providerCalls, settlements, preferences, storage, get dispatch() { return dispatch },
    get engine() { return engine }, get run() { return run }, get drafts() { return structuredClone(drafts) },
    get dispatchData() { return structuredClone(dispatchData) }, changePage: () => revision++, navigate: (url: string) => { currentUrl = url; revision++ } }
}

test('first-recipient route changes retain the paid caption through restart and only retry in the original draft', async () => {
  const h = fixture(), context = { kind: 'recipients', recipientKey: 'a'.repeat(64), recipientCount: 1 }
  const draftConversation = 'gv_' + hash(['/u/0/messages', 'draft', context.recipientKey, context.recipientCount])
  const media = { fingerprint: 'b'.repeat(64), count: 1, types: ['image/png'], totalBytes: 1024 }
  h.navigate('https://voice.google.com/u/0/messages?itemId=draft')
  const original = { conversationId: draftConversation, text: source, context, media }
  const id = await h.request('outgoing-id', original)
  assert.equal(id.ok, true)
  const payload = { ...original, id: id.result.id, direction: 'outgoing' }
  const result = await h.request('translate', payload)
  assert.equal(result.ok, true); assert.equal(h.providerCalls.length, 1)
  const authorized = await h.request('authorize', { ...payload, translated: result.result.text, requestId: result.result.requestId })
  assert.equal(authorized.ok, true)

  h.navigate('https://voice.google.com/u/0/messages?itemId=t.migration-fixture'); h.restart()
  const current = { conversationId, text: source, media }
  assert.equal((await h.request('dispatch-status', current)).result.state, 'uncertain')
  assert.equal((await h.request('dispatch-status', { ...current, text: translated })).result.state, 'uncertain')
  const resolve = { conversationId, media, requestId: result.result.requestId, attempt: 1, outcome: 'not-sent', confirmed: true }
  const refused = await h.request('dispatch-resolve', resolve)
  assert.equal(refused.ok, false); assert.match(refused.error, /原来的收件人/)
  assert.equal(h.dispatchData.records[0].state, 'uncertain')
  h.restart()
  const changedId = await h.request('outgoing-id', current)
  assert.equal(changedId.ok, true)
  assert.equal((await h.request('translate', { ...current, id: changedId.result.id, direction: 'outgoing' })).ok, false)
  assert.equal(h.providerCalls.length, 1)
  assert.equal((await h.engine.history()).filter((row: any) => row.state === 'charged').length, 1)

  h.navigate('https://voice.google.com/u/0/messages?itemId=draft'); h.restart()
  assert.equal((await h.request('outgoing-id', original)).result.id, id.result.id)
  assert.equal((await h.request('dispatch-resolve', { ...resolve, conversationId: draftConversation, context })).ok, true)
  h.restart()
  const retry = await h.request('translate', payload)
  assert.equal(retry.ok, true); assert.equal(retry.result.requestId, result.result.requestId)
  const next = await h.request('authorize', { ...payload, translated: retry.result.text, requestId: retry.result.requestId })
  assert.equal(next.ok, true); assert.equal(next.result.attempt, 2)
  assert.equal(h.providerCalls.length, 1)
  assert.equal((await h.engine.history()).filter((row: any) => row.state === 'charged').length, 1)

  h.navigate('https://voice.google.com/u/0/messages?itemId=t.migration-fixture'); h.restart()
  assert.equal((await h.request('dispatch-resolve', { ...resolve, attempt: 2, outcome: 'sent' })).ok, true)
  h.restart()
  assert.equal((await h.request('dispatch-status', current)).result.state, 'clear')
})

test('migration restores a paid unreserved UUID and immutable request across whitespace and restart without a second debit', async () => {
  const h = fixture(), text = ' \n' + source + '\n ', old = await h.seed(text)
  assert.equal(h.providerCalls.length, 1)
  h.restart()
  const recovered = await h.logicalId(text)
  assert.equal(recovered.ok, true); assert.equal(recovered.result.id, old.payload.id)
  const row = Object.values(h.drafts.records)[0]
  assert.equal(row.recoveryRequestId, old.result.requestId)
  assert.ok(!JSON.stringify(h.drafts).includes(source))
  const payload = { ...old.payload, recoveryRequestId: 'send-gv-' + 'f'.repeat(64) }
  const result = await h.request('translate', payload)
  assert.equal(result.ok, true); assert.equal(result.result.requestId, old.result.requestId)
  assert.equal(result.result.text, old.result.text); assert.equal(h.providerCalls.length, 1)
  h.restart()
  assert.equal((await h.logicalId(text)).result.id, old.payload.id)
  assert.equal((await h.request('translate', old.payload)).result.requestId, old.result.requestId)
  assert.equal(h.providerCalls.length, 1)
  const authorized = await h.request('authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text })
  assert.equal(authorized.ok, true)
  assert.equal(h.dispatchData.records[0].originalHash, createHash('sha256').update(text).digest('hex'))
  assert.equal((await h.engine.history()).filter((row: any) => row.state === 'charged').length, 1)
})

test('migration keeps a pending immutable ID and only checks that original settlement', async () => {
  const h = fixture(), old = await h.seed()
  await h.engine.receipts.update('owner', old.result.requestId, { state: 'pending', translated: undefined, chargedCharacters: undefined })
  h.restart()
  assert.equal((await h.logicalId()).result.id, old.payload.id)
  const reply = await h.request('translate', old.payload)
  assert.equal(reply.ok, false); assert.ok(h.settlements.length > 0)
  assert.deepEqual([...new Set(h.settlements)], [old.result.requestId])
  assert.equal(h.providerCalls.length, 1); assert.equal((await h.engine.history()).length, 1)
  assert.equal((await h.engine.history())[0].retryRequestId, undefined)
})

test('a sent UUID is excluded: identical later text is a new message with its own charge', async () => {
  const h = fixture(), old = await h.seed()
  const authorization = await h.run('owner', accountId, 'authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text }, () => true)
  await h.run('owner', accountId, 'dispatch-resolve', { conversationId, requestId: old.result.requestId, attempt: authorization.attempt, outcome: 'sent', confirmed: true }, () => true)
  h.restart()
  const recovered = await h.logicalId()
  assert.equal(recovered.ok, true); assert.notEqual(recovered.result.id, old.payload.id)
  const next = await h.request('translate', { ...old.payload, id: recovered.result.id })
  assert.equal(next.ok, true); assert.notEqual(next.result.requestId, old.result.requestId)
  assert.equal(h.providerCalls.length, 2)
})

test('explicit not-sent restores the old paid identity and permits only another reserved attempt', async () => {
  const h = fixture(), old = await h.seed()
  const authorization = await h.run('owner', accountId, 'authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text }, () => true)
  await h.run('owner', accountId, 'dispatch-resolve', { conversationId, requestId: old.result.requestId, attempt: authorization.attempt, outcome: 'not-sent', confirmed: true }, () => true)
  h.restart()
  assert.equal((await h.logicalId()).result.id, old.payload.id)
  assert.equal((await h.request('translate', old.payload)).result.requestId, old.result.requestId)
  const retried = await h.request('authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text })
  assert.equal(retried.ok, true); assert.equal(retried.result.attempt, 2); assert.equal(h.providerCalls.length, 1)
})

test('multiple unpaid-dispatch UUIDs cannot be guessed from identical text', async () => {
  const h = fixture(); await h.seed(); await h.seed()
  const reply = await h.logicalId()
  assert.equal(reply.ok, false); assert.equal(reply.code, 'draft-recovery'); assert.match(reply.error, /多条/)
  assert.equal(h.providerCalls.length, 2); assert.equal(Object.keys(h.drafts.records).length, 0)
})

test('expired and broken retry records fail closed with an actionable reason', async () => {
  for (const problem of ['expired', 'broken'] as const) {
    const h = fixture(), old = await h.seed()
    if (problem === 'expired') {
      await h.run('owner', accountId, 'authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text }, () => true)
      await h.run('owner', accountId, 'dispatch-resolve', { conversationId, requestId: old.result.requestId, attempt: 1, outcome: 'not-sent', confirmed: true }, () => true)
      await h.engine.receipts.expireMessage('owner', accountId, 'google-voice:' + conversationId, old.payload.id)
    }
    else {
      await h.engine.receipts.update('owner', old.result.requestId, { state: 'failed', chargedCharacters: 0 })
      await h.engine.receipts.retryFailedOutgoing('owner', old.result.requestId)
    }
    const reply = await h.logicalId()
    assert.equal(reply.ok, false); assert.equal(reply.code, 'draft-recovery'); assert.match(reply.error, problem === 'expired' ? /已清理/ : /不完整/)
    assert.equal(h.providerCalls.length, 1); assert.equal(Object.keys(h.drafts.records).length, 0)
  }
})

test('a complete failed-to-paid retry chain restores its terminal request without another provider call', async () => {
  const h = fixture(), old = await h.seed()
  await h.engine.receipts.update('owner', old.result.requestId, { state: 'failed', chargedCharacters: 0, translated: undefined })
  await h.engine.clearCache()
  const child = await h.engine.prepareOutgoingRequest((await h.engine.receipts.get('owner', old.result.requestId)).request)
  await h.engine.translate(child)
  h.restart()
  assert.equal((await h.logicalId()).result.id, old.payload.id)
  const restored = await h.request('translate', old.payload)
  assert.equal(restored.ok, true); assert.equal(restored.result.requestId, child.requestId); assert.equal(h.providerCalls.length, 2)
})

test('unconfirmed sends and mismatched restored settings never create replacement charges', async () => {
  const h = fixture(), old = await h.seed()
  await h.run('owner', accountId, 'authorize', { ...old.payload, requestId: old.result.requestId, translated: old.result.text }, () => true)
  const unknown = await h.logicalId()
  assert.equal(unknown.ok, false); assert.match(unknown.error, /待确认/)
  assert.equal(Object.keys(h.drafts.records).length, 0)
  const other = fixture(), draft = await other.seed()
  assert.equal((await other.logicalId()).result.id, draft.payload.id)
  other.preferences.targetLanguage = 'fr-FR'
  const mismatch = await other.request('translate', draft.payload)
  assert.equal(mismatch.ok, false); assert.equal(mismatch.code, 'draft-recovery'); assert.match(mismatch.error, /设置/)
  assert.equal(h.providerCalls.length, 1); assert.equal(other.providerCalls.length, 1)
})

test('different text is a new draft and never accepts a page-provided recovery pointer', async () => {
  const h = fixture(), old = await h.seed()
  const nextSource = source + '我们下周再约一次。', nextId = await h.logicalId(nextSource)
  assert.equal(nextId.ok, true); assert.notEqual(nextId.result.id, old.payload.id)
  const result = await h.request('translate', { id: nextId.result.id, conversationId, direction: 'outgoing', text: nextSource, recoveryRequestId: old.result.requestId })
  assert.equal(result.ok, true); assert.notEqual(result.result.requestId, old.result.requestId)
  assert.equal(h.providerCalls.length, 2)
})

test('confirmed send retires every recovered whitespace alias of the same UUID', async () => {
  const h = fixture(), raw = ' \n' + source + '\n ', old = await h.seed(raw)
  assert.equal((await h.logicalId(raw)).result.id, old.payload.id)
  assert.equal((await h.logicalId(source)).result.id, old.payload.id)
  assert.equal(Object.keys(h.drafts.records).length, 2)
  const answer = await h.request('translate', old.payload)
  const authorization = await h.request('authorize', { ...old.payload, requestId: answer.result.requestId, translated: answer.result.text })
  assert.equal(authorization.ok, true)
  const resolved = await h.request('dispatch-resolve', { conversationId, requestId: answer.result.requestId, attempt: authorization.result.attempt, outcome: 'sent', confirmed: true })
  assert.equal(resolved.ok, true); assert.equal(Object.keys(h.drafts.records).length, 0)
  assert.equal(h.dispatchData.records[0].migratedTextHash, createHash('sha256').update(source).digest('hex'))
  // Even if another legacy record later becomes available, a completed
  // migration is not an excuse to recycle that unrelated logical UUID.
  const another = await h.seed(source)
  assert.notEqual((await h.logicalId(source)).result.id, old.payload.id)
  assert.notEqual((await h.logicalId(source)).result.id, another.payload.id)
})

test('unrelated expired history cannot block new drafts; a known expired mapping still blocks replay', async () => {
  const h = fixture(), old = await h.seed()
  assert.equal((await h.logicalId()).result.id, old.payload.id)
  await h.engine.receipts.expireMessage('owner', accountId, 'google-voice:' + conversationId, old.payload.id)
  const known = await h.request('translate', old.payload)
  assert.equal(known.ok, false); assert.equal(known.code, 'draft-recovery'); assert.match(known.error, /已清理/)
  const newSource = '请告诉我下次会议安排在星期几。'
  const next = await h.logicalId(newSource)
  assert.equal(next.ok, true); assert.notEqual(next.result.id, old.payload.id)
  const response = await h.request('translate', { id: next.result.id, conversationId, text: newSource, direction: 'outgoing' })
  assert.equal(response.ok, true); assert.equal(h.providerCalls.length, 2)
})

test('migration candidates never cross owner, account or conversation scope', async () => {
  const h = fixture(), old = await h.seed(), history = await h.engine.history()
  const { recoverGoogleVoiceDraft } = mainHarness().load('src/main/platforms/googleVoice/draftRecovery.ts')
  const scope = { owner: 'owner', accountId, conversationId: 'google-voice:' + conversationId, text: source }
  assert.equal(recoverGoogleVoiceDraft(scope, history, []).id, old.payload.id)
  for (const patch of [{ owner: 'other-owner' }, { accountId: 'gv-00000000-0000-4000-8000-000000000002' }, { conversationId: 'google-voice:other-conversation' }]) {
    assert.equal(recoverGoogleVoiceDraft({ ...scope, ...patch }, history, []), undefined)
  }
})
