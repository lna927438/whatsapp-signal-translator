import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { mainHarness } from './main-harness.ts'
import type { GoogleVoiceEmbeddedDraftData } from '../src/main/platforms/googleVoice/embeddedTranslation'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const windowA = 'gv-00000000-0000-4000-8000-000000000001'
const windowB = 'gv-00000000-0000-4000-8000-000000000002'
const url = 'https://voice.google.com/u/0/messages?itemId=t.fixture'
const conversationId = 'gv_' + hash(['/u/0/messages', 't.fixture'])
const eventA = { sender: 'registered-a' }, eventB = { sender: 'registered-b' }
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value))
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(timeoutMs = 1000) {
  let revision = 0, owner = 'owner-a', currentUrl = url, data: GoogleVoiceEmbeddedDraftData = { records: {} }
  let readGate: Promise<void> | undefined, writeGate: Promise<void> | undefined, writeError = false
  const calls: Array<{ owner: string; accountId: string; op: string; payload: any; authorized: () => boolean }> = []
  let execute = async (call: typeof calls[number]): Promise<unknown> => {
    if (call.op === 'status') return { connected: true, targetLanguage: 'en-US', localLanguage: 'zh-CN', sendAutoTranslate: true, privateToken: 'must-not-leak' }
    if (call.op === 'translate') return { enabled: true, text: 'Hello', requestId: 'send-gv-' + call.payload.id, providerSecret: 'must-not-leak' }
    if (call.op === 'authorize') return { authorized: true, requestId: call.payload.requestId, attempt: 1 }
    if (call.op === 'dispatch-resolve') return { resolved: true }
    return { state: 'clear' }
  }
  const storage = {
    async read() { await readGate; return structuredClone(data) },
    async write(value: GoogleVoiceEmbeddedDraftData) { await writeGate; if (writeError) throw new Error('secret disk path'); data = structuredClone(value) }
  }
  const { GoogleVoiceEmbeddedTranslation } = mainHarness().load('src/main/platforms/googleVoice/embeddedTranslation.ts')
  const build = () => new GoogleVoiceEmbeddedTranslation({
    timeoutMs, storage,
    trustedPage: (event: unknown) => {
      if (event !== eventA && event !== eventB) throw new Error('unregistered sender secret')
      const captured = revision, capturedOwner = owner, capturedUrl = currentUrl
      return { owner: capturedOwner, accountId: event === eventA ? windowA : windowB, url: capturedUrl, authorized: () => captured === revision && capturedOwner === owner && capturedUrl === currentUrl }
    },
    translate: async (user: string, accountId: string, op: string, payload: unknown, authorized: () => boolean) => {
      if (op === 'recover-draft') return { state: 'new' }
      const call = { owner: user, accountId, op, payload, authorized }; calls.push(call); return execute(call)
    }
  })
  let bridge = build()
  const request = (type: string, payload?: unknown, event: unknown = eventA) => bridge.request(event, { v: 1, type: 'voice.' + type, ...(payload ? { payload } : {}) })
  const id = async (text = '你好', event = eventA) => { const reply = await request('outgoing-id', { conversationId, text }, event); assert.equal(reply.ok, true); return reply.result.id as string }
  return { request, id, calls, raw: (input: unknown, event: unknown = eventA) => bridge.request(event, input), data: () => structuredClone(data), restart: () => { bridge = build() }, setData: (value: GoogleVoiceEmbeddedDraftData) => { data = value }, setReadGate: (value: Promise<void> | undefined) => { readGate = value }, setWriteGate: (value: Promise<void> | undefined) => { writeGate = value }, setWriteError: (value: boolean) => { writeError = value }, setHandler: (value: typeof execute) => { execute = value }, navigate: (value: string) => { currentUrl = value; revision++ }, changeOwner: () => { owner = 'owner-b'; revision++ } }
}

test('internal bridge derives owner/window from the actual sender and strips provider fields', async () => {
  const h = fixture()
  const reply = await h.raw({ v: 1, type: 'voice.status', owner: 'forged', accountId: windowB })
  assert.deepEqual(normalized(reply), { ok: true, result: { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', sendAutoTranslate: true } })
  assert.equal(h.calls[0].owner, 'owner-a'); assert.equal(h.calls[0].accountId, windowA)
  assert.equal((await h.raw({ v: 1, type: 'voice.status' }, { sender: 'forged' })).ok, false)
  assert.equal(h.calls.length, 1)
})

test('persistent draft UUID survives bridge restart and keeps exact translation identity', async () => {
  const h = fixture(), id = await h.id()
  const payload = { id, conversationId, direction: 'outgoing', text: '你好' }
  assert.equal((await h.request('translate', payload)).ok, true)
  h.restart(); assert.equal(await h.id(), id)
  assert.equal((await h.request('translate', payload)).ok, true)
  assert.deepEqual(h.calls.filter(call => call.op === 'translate').map(call => call.payload.id), [id, id])
  assert.ok(!JSON.stringify(h.data()).includes('你好'))
})

test('draft identities are isolated by trusted owner and registered window', async () => {
  const h = fixture(), first = await h.id(), second = await h.id('你好', eventB)
  assert.notEqual(first, second); h.changeOwner(); assert.notEqual(first, await h.id())
  assert.equal(Object.keys(h.data().records).length, 3)
})

test('URL conversation must match the payload; fresh-recipient and login surfaces cannot translate', async () => {
  const h = fixture()
  assert.equal((await h.request('outgoing-id', { conversationId: 'forged', text: '你好' })).code, 'changed')
  h.navigate('https://voice.google.com/u/0/messages?itemId=draft')
  assert.equal((await h.request('outgoing-id', { conversationId, text: '你好' })).code, 'unsupported')
  h.navigate('https://accounts.google.com/signin')
  assert.equal((await h.request('status')).ok, false)
  assert.equal(h.calls.length, 0); assert.equal(Object.keys(h.data().records).length, 0)
})

test('outgoing translate and authorize refuse forged UUID without reaching the engine', async () => {
  const h = fixture(), id = randomUUID()
  assert.equal((await h.request('translate', { id, conversationId, direction: 'outgoing', text: '你好' })).code, 'draft')
  assert.equal((await h.request('authorize', { id, conversationId, text: '你好', translated: 'Hello', requestId: 'send-fixture' })).code, 'draft')
  assert.equal(h.calls.length, 0)
})

test('incoming translations do not allocate outgoing identities and validate receipts', async () => {
  const h = fixture()
  const reply = await h.request('translate', { id: randomUUID(), conversationId, direction: 'incoming', text: 'Hello', manual: true })
  assert.equal(reply.ok, true); assert.equal(reply.result.text, 'Hello'); assert.equal(reply.result.providerSecret, undefined)
  assert.equal(Object.keys(h.data().records).length, 0)
  h.setHandler(async () => ({ enabled: true, requestId: 'bad request', text: 'Hello' }))
  assert.equal((await h.request('translate', { id: randomUUID(), conversationId, direction: 'incoming', text: 'Hello' })).code, 'invalid')
})

test('incoming disabled/cache-miss replies are ordinary results; outgoing disabled previews still fail', async () => {
  const h = fixture(), id = await h.id()
  h.setHandler(async () => ({ enabled: false, manual: true, privateToken: 'must-not-leak' }))
  assert.deepEqual(normalized(await h.request('translate', { id: randomUUID(), conversationId, direction: 'incoming', text: 'Hello' })), { ok: true, result: { enabled: false, manual: true } })
  assert.equal((await h.request('translate', { id, conversationId, direction: 'outgoing', text: '你好' })).code, 'disabled')
})

test('fixed login/balance/account failures stay actionable without echoing untrusted detail', async () => {
  const h = fixture()
  for (const [message, code] of [
    ['可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。', 'balance'],
    ['可用字符余额不足。原请求已保留，结算以查询结果为准。', 'balance'],
    ['登录已失效，请重新登录。', 'login'],
    ['登录会话已失效，请重新登录。草稿与翻译记录已保留。', 'login'],
    ['请先登录在线账号。', 'login'],
    ['账号已停用，请联系管理员。', 'account']
  ]) { h.setHandler(async () => { throw new Error(message) }); assert.equal((await h.request('status')).code, code) }
  h.setHandler(async () => { throw new Error('登录已失效，请重新登录。 secret-token-and-message') })
  const reply = await h.request('status'); assert.equal(reply.code, 'unavailable'); assert.ok(!reply.error.includes('secret'))
})

test('same-window work is not queued; other account window has independent capacity', async () => {
  const h = fixture(), gate = deferred<unknown>()
  h.setHandler(() => gate.promise)
  const first = h.request('status'); await tick()
  assert.equal((await h.request('status')).code, 'busy')
  const other = h.request('status', undefined, eventB); await tick(); assert.equal(h.calls.length, 2)
  gate.resolve({ connected: true }); assert.equal((await first).ok, true); assert.equal((await other).ok, true)
})

test('UI timeout never releases an unfinished upstream slot or replays work', async () => {
  const h = fixture(15), gate = deferred<unknown>(); h.setHandler(() => gate.promise)
  assert.equal((await h.request('status')).code, 'timeout')
  assert.equal((await h.request('status')).code, 'busy'); assert.equal(h.calls.length, 1)
  gate.resolve({ connected: true }); await tick()
  assert.equal((await h.request('status')).ok, true); assert.equal(h.calls.length, 2)
})

test('timeout during local persistence cannot start a late billable request', async () => {
  const h = fixture(15), id = await h.id(), gate = deferred<void>(); h.setWriteGate(gate.promise)
  assert.equal((await h.request('translate', { id, conversationId, direction: 'outgoing', text: '你好' })).code, 'timeout')
  assert.equal((await h.request('status')).code, 'busy'); assert.equal(h.calls.length, 0)
  gate.resolve(); await tick(); h.setWriteGate(undefined)
  assert.equal(h.calls.length, 0); assert.equal(await h.id(), id)
})

test('navigation invalidates a returned result and the engine identity callback', async () => {
  const h = fixture(), gate = deferred<unknown>(); h.setHandler(() => gate.promise)
  const pending = h.request('status'); await tick(); h.navigate('https://voice.google.com/u/1/messages?itemId=t.other')
  assert.equal(h.calls[0].authorized(), false); gate.resolve({ connected: true })
  assert.equal((await pending).code, 'changed')
})

test('identity change while storage is loading does not start a billable request', async () => {
  const h = fixture(), id = await h.id(), gate = deferred<void>(); h.setReadGate(gate.promise)
  const pending = h.request('translate', { id, conversationId, direction: 'outgoing', text: '你好' })
  await tick(); h.changeOwner(); gate.resolve()
  assert.equal((await pending).code, 'changed'); assert.equal(h.calls.length, 0)
})

test('unconfirmed persistence prevents authorization and never exposes underlying errors', async () => {
  const h = fixture(), id = await h.id(); h.setWriteError(true)
  const reply = await h.request('authorize', { id, conversationId, text: '你好', translated: 'Hello', requestId: 'send-fixture' })
  assert.equal(reply.ok, false); assert.ok(!reply.error.includes('secret')); assert.equal(h.calls.length, 0)
})

test('not-sent preserves draft ID; sent releases only the matching window record', async () => {
  const h = fixture(), id = await h.id(), other = await h.id('你好', eventB), requestId = 'send-fixture'
  for (const [event, recordId] of [[eventA, id], [eventB, other]] as const) assert.equal((await h.request('authorize', { id: recordId, conversationId, text: '你好', translated: 'Hello', requestId }, event)).ok, true)
  assert.equal((await h.request('dispatch-resolve', { conversationId, requestId, attempt: 1, outcome: 'not-sent', confirmed: true })).ok, true)
  assert.equal(await h.id(), id)
  assert.equal((await h.request('dispatch-resolve', { conversationId, requestId, attempt: 1, outcome: 'sent', confirmed: true })).ok, true)
  assert.notEqual(await h.id(), id); assert.equal(await h.id('你好', eventB), other)
})

test('dispatch operations preserve exact request and attempt; mismatched authorization is rejected', async () => {
  const h = fixture(), id = await h.id()
  h.setHandler(async () => ({ authorized: true, requestId: 'wrong', attempt: 1 }))
  assert.equal((await h.request('authorize', { id, conversationId, text: '你好', translated: 'Hello', requestId: 'send-fixture' })).code, 'invalid')
  h.setHandler(async () => ({ state: 'uncertain', requestId: 'send-fixture', attempt: 2, privateToken: 'secret' }))
  assert.deepEqual(normalized(await h.request('dispatch-status', { conversationId, text: '你好' })), { ok: true, result: { state: 'uncertain', requestId: 'send-fixture', attempt: 2 } })
  assert.equal((await h.request('dispatch-resolve', { conversationId, requestId: 'send-fixture', attempt: 0, outcome: 'sent', confirmed: true })).code, 'invalid')
})

test('corrupted persistent IDs fail closed instead of silently generating new billable identities', async () => {
  const h = fixture(); h.setData({ records: { invalid: { id: 'not-a-uuid', scopeHash: 'wrong' } } })
  assert.equal((await h.request('outgoing-id', { conversationId, text: '你好' })).code, 'invalid')
  assert.equal(Object.keys(h.data().records)[0], 'invalid'); assert.equal(h.calls.length, 0)
})

test('oversized, unknown and malformed operations never reach storage or engine', async () => {
  const h = fixture()
  for (const input of [null, [], { v: 1, type: 'pair' }, { v: 2, type: 'voice.status' }, { v: 1, type: 'voice.status', junk: 'x'.repeat(65536) }]) assert.equal((await h.raw(input)).ok, false)
  assert.equal((await h.request('outgoing-id', { conversationId, text: 'x'.repeat(8001) })).code, 'invalid')
  assert.equal((await h.request('outgoing-id', { conversationId, text: 'nul\0text' })).code, 'invalid')
  assert.equal(h.calls.length, 0); assert.equal(Object.keys(h.data().records).length, 0)
})
