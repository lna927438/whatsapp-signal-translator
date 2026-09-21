import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
const { retryHelloDogMessage, helloDogPreparationFailureLabel }: typeof import('../integrations/hellodog-source/hellodog.send-status.std.ts') = createRequire(import.meta.url)('../integrations/hellodog-source/hellodog.send-status.std.ts')
const { patchSignalSendStatus } = await import(new URL('../scripts/patch-signal-send-status.mjs', import.meta.url).href)
const native = (file: string) => readFileSync(new URL('../integrations/signal-desktop/' + file, import.meta.url), 'utf8')
function functionSource(source: string, name: string) {
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn); return fn.getText(ast).replace(/^export /, '')
}
function setup(enqueue?: () => Promise<void>, initialErrors: any[] = [{ name: 'HelloDogSendPreparationError' }]) {
  const message = { id: 'original-message', attributes: { type: 'outgoing', conversationId: 'peer', errors: initialErrors,
    sendStateByConversationId: { peer: { status: 'Failed', updatedAt: 1 }, done: { status: 'Delivered', updatedAt: 1 } } as Record<string, any> },
    get(key: string): any { return (this.attributes as any)[key] }, set(value: any) { Object.assign(this.attributes, value) } }
  const conversation = { id: 'peer', attributes: {}, getMemberConversationIds: () => new Set(['peer', 'done']), get: () => 1 }
  let queued = 0, saved = 0
  const states: any = {}
  runInNewContext(ts.transpileModule(native('ts/messages/MessageSendState.std.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { exports: states, require: () => ({ __esModule: true, default: (fn: any) => fn }) })
  const file = 'ts/state/ducks/conversations.preload.ts', patched = patchSignalSendStatus(file, native(file))
  assert.equal(patchSignalSendStatus(file, patched), patched)
  const selector = native('ts/state/selectors/message.preload.ts'), exported: any = {}
  const code = [functionSource(selector, 'hasErrors'), functionSource(selector, 'getMessagePropStatus'), functionSource(patched, 'retryMessageSend'),
    'exports.status=getMessagePropStatus; exports.retry=retryMessageSend;'].join('\n')
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: exported, ...states, retryHelloDogMessage, process: { env: { HELLODOG_EMBEDDED: '1', HELLODOG_BRIDGE_ACTIVE: '1' } },
    getMessageById: async () => message, window: { ConversationController: { get: () => conversation }, MessageCache: { saveMessage: async () => { saved++ } } },
    isMe: () => false, isStory: () => false, conversationQueueJobEnum: { enum: { NormalMessage: 'NormalMessage' } },
    conversationJobQueue: { add: async (data: any, save: Function) => { queued++; assert.equal(data.messageId, message.id); await enqueue?.(); await save({ id: 'same-native-job' }) } },
    noopAction: () => ({}), getLastChallengeError: (m: any) => m.errors?.find((e: any) => e.name === 'SendMessageChallengeError'), isOutgoing: (m: any) => m.type === 'outgoing', isNoteToSelf: () => false, isMessageJustForMe: () => false
  })
  return { message, retry: () => exported.retry(message.id)(() => {}), status: () => exported.status(message.attributes, 'done'), queued: () => queued, saved: () => saved }
}

test('actual native retry changes the failed display to sending while preserving ID and successful recipients', async () => {
  let finish!: () => void
  const h = setup(() => new Promise<void>(resolve => { finish = resolve })), done = h.message.get('sendStateByConversationId').done
  assert.equal(h.status(), 'error')
  const pending = h.retry(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.status(), 'sending'); assert.equal(h.message.get('errors').length, 0)
  assert.equal(h.message.get('sendStateByConversationId').peer.status, 'Pending')
  assert.equal(h.message.get('sendStateByConversationId').done, done)
  assert.equal(h.queued(), 1); finish(); await pending; assert.equal(h.saved(), 1)
})

test('repeated manual retry while persistence is pending cannot queue another native job', async () => {
  let finish!: () => void
  const h = setup(() => new Promise<void>(resolve => { finish = resolve }))
  const first = h.retry(); await new Promise(resolve => setImmediate(resolve)); const second = h.retry()
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.queued(), 1)
  finish(); await Promise.all([first, second]); assert.equal(h.saved(), 1)
})

test('native queue persistence failure restores old failure and makes a later manual retry possible', async () => {
  let fail = true
  const h = setup(async () => { if (fail) throw Error('synthetic disk failure') })
  await assert.rejects(h.retry(), /disk failure/)
  assert.equal(h.status(), 'error'); assert.equal(h.message.get('sendStateByConversationId').peer.status, 'Failed')
  assert.equal(h.message.get('errors')[0].name, 'HelloDogSendPreparationError')
  fail = false; await h.retry(); assert.equal(h.status(), 'sending'); assert.equal(h.queued(), 2)
})

test('a late delivery receipt and new errors survive failed retry persistence', async () => {
  let reject!: (error: Error) => void
  const h = setup(() => new Promise<void>((_, rejectWork) => { reject = rejectWork }))
  const pending = h.retry(); await new Promise(resolve => setImmediate(resolve))
  const newErrors = [{ name: 'NetworkFailure' }]
  h.message.set({ sendStateByConversationId: { ...h.message.get('sendStateByConversationId'), peer: { status: 'Delivered', updatedAt: 3 } }, errors: newErrors })
  reject(Error('synthetic persistence failure')); await assert.rejects(pending)
  assert.equal(h.message.get('sendStateByConversationId').peer.status, 'Delivered'); assert.equal(h.message.get('errors'), newErrors)
})

test('retry preserves official challenge and identity errors', async () => {
  const challenge = { name: 'SendMessageChallengeError', retryAfter: 123, data: {} }, identity = { name: 'OutgoingIdentityKeyError' }
  const h = setup(undefined, [challenge, identity, { name: 'HelloDogSendPreparationError' }])
  await h.retry(); assert.deepEqual(h.message.get('errors'), [challenge, identity]); assert.equal(h.status(), 'paused')
})

test('a receipt arriving before the retry mutation is never replaced with Pending', async () => {
  const before = { peer: { status: 'Failed' } }, next = { peer: { status: 'Pending' } }, identity = {}, oldErrors = [{ name: 'Error' }]
  let current = { states: before, errors: oldErrors }
  const result = retryHelloDogMessage({ enabled: true, identity, beforeStates: before, nextStates: next, errors: oldErrors,
    current: () => current, update: (states, errors) => { current = { states: states as any, errors: errors as any } }, enqueue: async () => {} })
  current = { states: { peer: { status: 'Delivered' } }, errors: [] }; await result
  assert.equal(current.states.peer.status, 'Delivered'); assert.deepEqual(current.errors, [])
})

test('preflight classification uses exact tags and never mislabels transport, incoming, partial or pending sends', () => {
  const original = { type: 'outgoing', errors: [{ name: 'HelloDogSendPreparationError' }], sendStateByConversationId: { peer: { status: 'Failed' } } }
  assert.match(helloDogPreparationFailureLabel(original, 'zh-CN')!.label, /发送前/)
  assert.match(helloDogPreparationFailureLabel(original, 'en-US')!.detail, /check the conversation before retrying/)
  for (const modified of [undefined, { ...original, type: 'incoming' }, { ...original, errors: [] }, { ...original, errors: [{ name: 'Error', message: 'HelloDogSendPreparationError' }] },
    { ...original, errors: [...original.errors, { name: 'HTTPError' }] }, ...['Pending', 'Sent', 'Delivered', 'Read', 'Viewed', 'Skipped'].map(status => ({ ...original, sendStateByConversationId: { peer: { status } } }))]) {
    assert.equal(helloDogPreparationFailureLabel(modified, 'zh-CN'), undefined)
  }
})

test('both native patches are idempotent, type-syntax valid, and refuse changed upstream anchors', () => {
  for (const file of ['ts/state/ducks/conversations.preload.ts', 'ts/components/conversation/MessageMetadata.dom.tsx']) {
    const original = native(file), transformed = patchSignalSendStatus(file, original)
    assert.equal(patchSignalSendStatus(file, transformed), transformed)
    const checked = ts.transpileModule(transformed, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
    assert.deepEqual((checked.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [])
    assert.throws(() => patchSignalSendStatus(file, '// Changed upstream'), /anchor changed/)
  }
})

test('actual native metadata renders a distinct preflight label and leaves transport failure wording unchanged', () => {
  const file = 'ts/components/conversation/MessageMetadata.dom.tsx', exports: any = {}
  let attributes: any = { type: 'outgoing', errors: [{ name: 'HelloDogSendPreparationError' }], sendStateByConversationId: { peer: { status: 'Failed' } } }
  const jsx = (tag: any, props: any) => ({ tag: typeof tag === 'string' ? tag : 'component', props })
  const source = patchSignalSendStatus(file, native(file))
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  runInNewContext(code, { exports, window: { MessageCache: { getById: () => ({ attributes }) } }, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === 'react') return { forwardRef: (render: any) => render, useState: () => [undefined, () => {}], useCallback: (fn: any) => fn }
    if (name === 'classnames') return { __esModule: true, default: (...values: any[]) => values.join(' ') }
    if (name.includes('hellodog.send-status')) return { helloDogPreparationFailureLabel }
    if (name.includes('refMerger')) return { refMerger: () => undefined }
    if (name.includes('tw.dom')) return { tw: (strings: TemplateStringsArray) => strings.join('') }
    return {}
  } })
  const i18n = Object.assign((key: string) => key === 'icu:sendFailed' ? '发送失败' : key, { getLocale: () => 'zh-CN' })
  const render = () => JSON.stringify(exports.MessageMetadata({ id: 'synthetic-original', direction: 'outgoing', status: 'error', hasText: true, i18n, timestamp: 1 }, undefined))
  assert.match(render(), /发送前检查未通过/); assert.match(render(), /先核对会话/); assert.doesNotMatch(render(), /消息尚未发出/)
  attributes = { ...attributes, errors: [{ name: 'HTTPError' }] }
  assert.match(render(), /发送失败/); assert.doesNotMatch(render(), /发送前检查未通过/)
})
