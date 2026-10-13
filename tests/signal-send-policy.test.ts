import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const policySource = compile('../integrations/hellodog-source/hellodog.send-policy.preload.ts')
const token = '10000000-0000-4000-8000-000000000001'
const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve } }

function policyFixture(shortTimeout = false) {
  const calls: any[] = [], acknowledgements: any[] = [], exports: any = {}
  let respond = async (request: any): Promise<any> => ({ authorized: true, text: request.text })
  const ipc = Object.assign(new EventEmitter(), {
    invoke: async (channel: string, request: any) => { calls.push([channel, request]); return respond(request) },
    send: (...args: any[]) => acknowledgements.push(args),
  })
  runInNewContext(policySource, { exports, Error, Date, process: { env: { HELLODOG_EMBEDDED: '1', HELLODOG_BRIDGE_ACTIVE: '1' } },
    require: (name: string) => { assert.equal(name, 'electron'); return { ipcRenderer: ipc } },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, shortTimeout ? 15 : ms), clearTimeout })
  const message: any = { id: 'message-a', attributes: { conversationId: 'conversation-a', body: '  中文 Alice\n原有  空格  ' }, get(key: string) { return this.attributes[key] }, set(value: any) { Object.assign(this.attributes, value) } }
  const conversation: any = { id: 'conversation-a' }
  return { exports, message, conversation, calls, acknowledgements,
    invalidate: (id: any = token) => ipc.emit('hellodog:send-policy-invalidate', {}, id),
    respond: (value: typeof respond) => { respond = value },
    guard: (revision = exports.captureHelloDogSendPolicy(), editTimestamp?: number) => exports.createHelloDogDispatchGuard(message, conversation, editTimestamp, revision),
  }
}

test('Signal final policy authorization preserves exact raw text and uses only the private read-only operation', async () => {
  const h = policyFixture(), original = h.message.get('body'), authorize = h.guard(), commit = await authorize()
  commit(); assert.equal(h.message.get('body'), original)
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'hellodog:translate')
  assert.equal(h.calls[0][1].text, original); assert.equal(h.calls[0][1].dispatchPolicyOnly, true)
  assert.equal(h.calls[0][1].authorizationOnly, undefined); assert.equal(h.calls[0][1].requestId, undefined)
})

test('Signal synchronous epoch ACK cancels approval before upload, during the response and immediately before transport', async () => {
  for (const phase of ['before-upload', 'awaiting-policy', 'before-transport']) {
    const h = policyFixture(), revision = h.exports.captureHelloDogSendPolicy(), authorize = h.guard(revision), gate = deferred()
    if (phase === 'before-upload') { h.invalidate(); await assert.rejects(authorize(), /设置或消息已变化/); assert.equal(h.calls.length, 0) }
    else if (phase === 'awaiting-policy') {
      h.respond(async request => { await gate.promise; return { authorized: true, text: request.text } })
      const pending = authorize(), rejected = assert.rejects(pending, /设置或消息已变化/)
      await tick(); h.invalidate(); gate.resolve(); await rejected
    } else { const commit = await authorize(); h.invalidate(); assert.throws(commit, /设置或消息已变化/) }
    assert.equal(h.exports.captureHelloDogSendPolicy(), revision + 1)
    assert.deepEqual(h.acknowledgements, [['hellodog:send-policy-invalidated', token]])
  }
})

test('Signal expired, erased, changed text/conversation and removed edits cannot reuse a final approval', async () => {
  for (const change of ['text', 'conversation', 'erase', 'expire', 'edit']) {
    const h = policyFixture()
    if (change === 'edit') h.message.set({ editHistory: [{ timestamp: 5, body: 'edited 中文' }] })
    const authorize = h.guard(undefined, change === 'edit' ? 5 : undefined), commit = await authorize()
    if (change === 'text') h.message.set({ body: '另外一段中文' })
    else if (change === 'conversation') h.message.set({ conversationId: 'other' })
    else if (change === 'erase') h.message.set({ deletedForEveryone: true })
    else if (change === 'expire') h.message.set({ expirationStartTimestamp: 1, expireTimer: 1 })
    else h.message.set({ editHistory: [] })
    assert.throws(commit, /设置或消息已变化/)
  }
})

test('Signal failed, mismatched or lost final approval is a bounded preparation failure without a fallback', async () => {
  for (const mode of ['rejected', 'mismatch', 'malformed', 'timeout']) {
    const h = policyFixture(mode === 'timeout')
    h.respond(async () => { if (mode === 'rejected') throw Error('private failure'); if (mode === 'timeout') return new Promise(() => {}); return mode === 'mismatch' ? { authorized: true, text: 'Changed' } : { authorized: false } })
    await assert.rejects(h.guard()(), (error: any) => error.name === 'HelloDogSendPreparationError')
    assert.equal(h.calls.length, 1); assert.equal(h.message.get('body'), '  中文 Alice\n原有  空格  ')
  }
  const h = policyFixture(); h.invalidate('bad token'); assert.equal(h.acknowledgements.length, 0)
})

function nativeJobFixture(kind: 'direct' | 'group' | 'sync', phase: string) {
  const h = policyFixture(), gate = deferred(); let waiting = false, transport = 0, failed = 0, networkRetries = 0, translated = 0
  const wait = async (name: string) => { if (phase === name) { waiting = true; await gate.promise } }
  const message = h.message
  message.set({ timestamp: 1, sendStateByConversationId: { 'conversation-a': { status: 'Pending' } } })
  const conversation: any = Object.assign(h.conversation, { attributes: {}, get: (key: string) => key === 'type' ? kind === 'group' ? 'group' : 'private' : undefined,
    getGroupV2Info: () => ({}), getExpireTimerVersion: () => 1, toSenderKeyTarget: () => ({}),
    queueJob: async (_name: string, callback: Function) => { await wait('queue'); return callback({}) } })
  const dispatch = async () => { transport++; await wait('committed'); return {} }
  h.respond(async request => { await wait('policy'); return { authorized: true, text: request.text } })
  const stubs: Record<string, any> = {
    lodash: { default: { isNumber: (n: any) => typeof n === 'number' } },
    '@signalapp/libsignal-client': { ContentHint: { Resendable: 1 } },
    '../../util/assert.std.ts': { strictAssert: (value: any) => assert.ok(value) },
    '../../types/Message2.preload.ts': { GROUP: 'group' },
    '../../messages/getMessageById.preload.ts': { getMessageById: async () => message },
    '../../util/whatTypeOfConversation.dom.ts': { isMe: () => kind === 'sync', isGroup: () => kind === 'group', isGroupV2: () => false },
    '../../state/selectors/message.preload.ts': { isOutgoing: () => true },
    '../../util/isSignalConversation.dom.ts': { isSignalConversation: () => false },
    '../../util/getMessageSentTimestamp.std.ts': { getMessageSentTimestamp: () => 1 },
    '../../util/editHelpers.std.ts': { getTargetOfThisEditTimestamp: () => undefined },
    '../../hellodog/hellodog.preload.ts': { translateHelloDogMessage: async () => { translated++; await wait('translation') } },
    '../../hellodog/hellodog.recovery.preload.ts': require('../integrations/hellodog-source/hellodog.recovery.preload.ts'),
    '../../hellodog/hellodog.send-policy.preload.ts': h.exports,
    '../../test-node/util/messageFailures.preload.ts': { markFailed: () => {}, saveErrorsOnMessage: async (_message: any, errors: Error[]) => { failed++; assert.equal(errors[0].name, 'HelloDogSendPreparationError') } },
    './handleMultipleSendErrors.std.ts': { handleMultipleSendErrors: async () => { networkRetries++; throw Error('Unexpected network retry') } },
    '../../messages/send.preload.ts': { send: async (_message: any, options: any) => options.promise.catch(() => undefined), sendSyncMessageOnly: dispatch },
    '../../util/sendToGroup.preload.ts': { sendToGroup: dispatch },
    '../../util/getSendOptions.preload.ts': { getSendOptions: async () => { await wait('options'); return {} } },
    '../../util/handleMessageSend.preload.ts': { handleMessageSend: (promise: Promise<unknown>) => promise },
    './shouldSendToConversation.preload.ts': { shouldSendToDirectConversation: () => [true] },
  }
  const exports: any = {}
  const code = compile('../integrations/signal-desktop/ts/jobs/helpers/sendNormalMessage.preload.ts')
  // Replace only native network/attachment fixtures. The full persisted job and
  // actual placements of its upload, queue, final gate and transport remain real.
  runInNewContext(code + '\ngetMessageRecipients=globalThis.fixtureRecipients;getMessageSendData=globalThis.fixtureUpload;didSendToEveryone=globalThis.fixtureSent;', {
    exports, Error, window: { ConversationController: { get: () => conversation, doWeHaveOtherDevices: () => true } },
    require: (name: string) => stubs[name] || {},
    fixtureRecipients: () => ({ allRecipientServiceIds: ['synthetic'], recipientServiceIdsWithoutMe: kind === 'sync' ? [] : ['synthetic'], sentRecipientServiceIds: [], untrustedServiceIds: [] }),
    fixtureUpload: async () => { const body = message.get('body'); await wait('upload'); return { body, attachments: [] } },
    fixtureSent: () => transport > 0,
  })
  const start = () => exports.sendNormalMessage(conversation, { isFinalAttempt: false, shouldContinue: true, timeRemaining: 86400000,
    log: { info() {}, warn() {}, error() {} }, messaging: { getDataOrEditMessage: async () => { await wait('sync-data'); return {} }, sendMessageToServiceId: dispatch } }, { messageId: message.id })
  return { ...h, start, gate, waiting: () => waiting, counts: () => ({ transport, failed, networkRetries, translated }) }
}

test('actual Signal native job refuses old OFF Chinese after translation, upload and direct/group queue waits without network retry', async () => {
  for (const kind of ['direct', 'group', 'sync'] as const) for (const phase of ['translation', 'upload', 'policy', ...(kind === 'sync' ? ['sync-data'] : ['queue', 'options'])]) {
    const h = nativeJobFixture(kind, phase), work = h.start()
    await tick(); assert.equal(h.waiting(), true, kind + '/' + phase)
    h.invalidate(); h.gate.resolve(); await work
    assert.deepEqual(h.counts(), { transport: 0, failed: 1, networkRetries: 0, translated: 1 }, kind + '/' + phase)
    assert.equal(h.message.get('body'), '  中文 Alice\n原有  空格  ')
  }
})

test('actual Signal native direct/group/sync dispatch is once-only and a committed transport is not retracted by a later setting', async () => {
  for (const kind of ['direct', 'group', 'sync'] as const) {
    const h = nativeJobFixture(kind, 'committed'), work = h.start()
    await tick(); assert.equal(h.waiting(), true); assert.equal(h.counts().transport, 1)
    h.invalidate(); h.gate.resolve(); await work
    assert.deepEqual(h.counts(), { transport: 1, failed: 0, networkRetries: 0, translated: 1 })
    assert.equal(h.calls.length, 1)
  }
})
