import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { ExtensionBridge, SelectionTasks } from '../background-core.mjs'
import { NativeClient, NativeBusyError, HOST, isVoiceUrl, selectedContext, mediaValue, recipientContextValue, translationPayload, translatedValue, translatedTextValue, statusValue } from '../protocol.mjs'
import { SendGuard, installSendInterception } from '../send-guard.mjs'

const token = 'a'.repeat(64), code = 'b'.repeat(64), extensionId = 'kigfaejcipjibnmnpinplphfldjahknn'
const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }
function setup() {
  const values = {}, calls = [], native = { request: async (op, payload) => { calls.push({ op, payload }); return op === 'pair' ? { pairToken: token } : op === 'status' ? { connected: true, targetLanguage: 'en-US', secret: 'never-forward' } : { enabled: true, text: '翻译结果', requestId: 'gv-test-1' } } }
  const storage = { get: async key => ({ [key]: values[key] }), set: async data => Object.assign(values, data), remove: async key => { delete values[key] } }
  const bridge = new ExtensionBridge({ native, storage, runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}` } })
  return { bridge, native, values, calls, storage }
}
function guardSetup() {
  let snapshot = { conversationId: 'thread-1', text: '你好', revision: 1, composer: {}, sendButton: {} }, sent = 0, replaced = 0
  const calls = [], adapter = { supported: true, snapshot: () => ({ ...snapshot }), replace: (_old, text) => { snapshot.text = text; snapshot.revision++; replaced++; return true }, dispatch: () => { sent++ } }
  const bridge = { status: async () => ({ connected: true, sendAutoTranslate: true, targetLanguage: 'en-US' }), translate: async data => { calls.push(data); return { enabled: true, text: 'Hello', requestId: 'gv-fixture-1' } }, authorize: async payload => ({ authorized: true, requestId: payload.requestId, attempt: 1 }) }
  return { guard: new SendGuard(adapter, bridge), adapter, bridge, snapshot, calls, sent: () => sent, replaced: () => replaced }
}
test('MV3 has one exact host, fixed ID, no injected MAIN world or powerful unrelated permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)))
  assert.equal(manifest.manifest_version, 3)
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'storage', 'contextMenus'])
  assert.deepEqual(manifest.host_permissions, ['https://voice.google.com/*'])
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED')
  assert.equal(manifest.content_scripts[0].all_frames, false)
  assert.equal(manifest.externally_connectable, undefined)
  assert.equal(manifest.web_accessible_resources, undefined)
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(n => String.fromCharCode(97 + (n >> 4), 97 + (n & 15))).join('')
  assert.equal(id, extensionId)
})
test('origin checks reject lookalikes, credential URLs, ports, HTTP and subframes', async () => {
  for (const url of ['http://voice.google.com/', 'https://voice.google.com.evil.invalid/', 'https://voice.google.com:444/', 'https://name@voice.google.com/']) assert.equal(isVoiceUrl(url), false)
  assert.equal(isVoiceUrl('https://voice.google.com/u/0/messages'), true)
  const { bridge } = setup()
  assert.equal(bridge.contentSender({ id: extensionId, tab: { id: 1 }, frameId: 1, url: 'https://voice.google.com/' }), false)
})
test('context menu supports omitted top frame ID but rejects child frames and navigated pages', () => {
  const info = { menuItemId: 'hellodog-translate-selection', selectionText: 'Hello', pageUrl: 'https://voice.google.com/u/0/messages' }, tab = { id: 3, url: info.pageUrl }
  assert.equal(selectedContext(info, tab).text, 'Hello')
  assert.equal(selectedContext({ ...info, frameId: 0 }, tab).tabId, 3)
  assert.equal(selectedContext({ ...info, frameId: 4 }, tab), null)
  assert.equal(selectedContext({ ...info, frameUrl: info.pageUrl }, tab), null)
  assert.equal(selectedContext(info, { ...tab, url: 'https://voice.google.com/u/1/messages' }), null)
})
test('only extension popup pairs; token is stored and never returned to popup or page', async () => {
  const { bridge, values, calls } = setup()
  for (const sender of [{ ...popup, tab: { id: 1 } }, { ...popup, url: 'https://voice.google.com/' }, { ...popup, id: 'evil' }]) await assert.rejects(bridge.handle({ v: 1, type: 'pair', code }, sender))
  assert.equal(calls.length, 0)
  const result = await bridge.handle({ v: 1, type: 'pair', code }, popup)
  assert.equal(values.pairToken, token); assert.equal(JSON.stringify(result).includes(token), false)
  assert.equal(result.adapter.supported, false)
  const status = await bridge.handle({ v: 1, type: 'status' }, popup)
  assert.equal(status.status.secret, undefined)
  await bridge.handle({ v: 1, type: 'disconnect' }, popup)
  assert.equal(values.pairToken, undefined)
})
test('malformed pairing response cannot store a token', async () => {
  const s = setup(); s.native.request = async () => ({ pairToken: '../bad' })
  await assert.rejects(s.bridge.handle({ v: 1, type: 'pair', code }, popup)); assert.equal(s.values.pairToken, undefined)
})
test('manual translation validates origin/text and only forwards fixed incoming payload', async () => {
  const s = setup(); s.values.pairToken = token
  for (const args of [['hello', 'https://evil.invalid/'], ['', 'https://voice.google.com/'], ['x'.repeat(8001), 'https://voice.google.com/']]) await assert.rejects(s.bridge.translateSelection(...args, randomUUID()))
  assert.equal(s.calls.length, 0)
  await s.bridge.translateSelection('Hello', 'https://voice.google.com/', randomUUID())
  assert.deepEqual(Object.keys(s.calls[0].payload).sort(), ['conversationId', 'direction', 'id', 'manual', 'text'])
  assert.equal(s.calls[0].payload.direction, 'incoming'); assert.equal(s.calls[0].payload.manual, true)
})
test('unverified content cannot translate or authorize outgoing text', async () => {
  const s = setup(), sender = { id: extensionId, frameId: 0, tab: { id: 2 }, url: 'https://voice.google.com/' }
  const result = await s.bridge.handle({ v: 1, type: 'adapter.status' }, sender)
  assert.equal(result.adapter.supported, false)
  for (const type of ['translate', 'authorize', 'pair', 'status']) await assert.rejects(s.bridge.handle({ v: 1, type, code }, sender))
  assert.equal(s.calls.length, 0)
})
test('selection captures pairing and refuses a replacement token before translation', async () => {
  const s = setup(); s.values.pairToken = token
  s.native.request = async () => ({ connected: true, localLanguage: 'zh-CN' })
  const scope = await s.bridge.selectionScope()
  s.values.pairToken = 'c'.repeat(64)
  assert.equal(await scope.current(), false)
  s.native.request = async () => { throw new Error('must not translate under new pairing') }
  await assert.rejects(scope.translate('Synthetic', 'https://voice.google.com/', randomUUID()), /连接已变化/)
})
test('selection does not reveal old receipt after pairing changes while translating', async () => {
  const s = setup(); s.values.pairToken = token
  s.native.request = async (op, _payload, observedToken) => {
    if (op === 'status') return { connected: true, localLanguage: 'zh-CN' }
    assert.equal(observedToken, token); delete s.values.pairToken
    return { enabled: true, text: 'Old result', requestId: 'gv-synthetic' }
  }
  const scope = await s.bridge.selectionScope()
  await assert.rejects(scope.translate('Synthetic', 'https://voice.google.com/', randomUUID()), /连接已变化/)
})
function nativeSetup(timeoutMs = 500) {
  const callbacks = {}, sent = [], port = { onMessage: { addListener: fn => { callbacks.message = fn } }, onDisconnect: { addListener: fn => { callbacks.disconnect = fn } }, postMessage: value => sent.push(value) }
  let connects = 0
  return { client: new NativeClient({ connectNative: name => { assert.equal(name, HOST); connects++; return port } }, { timeoutMs }), callbacks, sent, connects: () => connects }
}
test('native allows one in-flight request, rejects excess without queueing and correlates replies', async () => {
  const s = nativeSetup(), one = s.client.request('status', undefined, token)
  await assert.rejects(s.client.request('translate', { text: 'not submitted' }, token), NativeBusyError)
  assert.equal(s.sent.length, 1)
  s.callbacks.message({ v: 1, id: randomUUID(), ok: true, result: { unrelated: true } })
  assert.equal(s.client.pending.size, 1)
  s.callbacks.message({ v: 1, id: s.sent[0].id, ok: true, result: { order: 1 } })
  assert.deepEqual(await one, { order: 1 })
  const two = s.client.request('status', undefined, token)
  s.callbacks.message({ v: 1, id: s.sent[0].id, ok: true, result: { stale: true } })
  assert.equal(s.client.pending.size, 1)
  s.callbacks.message({ v: 1, id: s.sent[1].id, ok: true, result: { order: 2 } })
  assert.deepEqual(await two, { order: 2 }); assert.equal(s.connects(), 1)
})
test('native disconnect rejects pending requests; no automatic translation retry', async () => {
  const s = nativeSetup(), task = s.client.request('translate', { text: 'fixture' }, token)
  s.callbacks.disconnect(); await assert.rejects(task, /断开/); assert.equal(s.sent.length, 1)
})
test('native timeout does not release a still-running host slot or allow delayed queued billing', async () => {
  const s = nativeSetup(5)
  await assert.rejects(s.client.request('translate', { text: 'synthetic' }, token), /超时/)
  assert.equal(s.sent.length, 1); assert.equal(s.client.pending.size, 1)
  await assert.rejects(s.client.request('translate', { text: 'must not queue' }, token), NativeBusyError)
  assert.equal(s.sent.length, 1)
  s.callbacks.message({ v: 1, id: s.sent[0].id, ok: true, result: { late: true } })
  assert.equal(s.client.pending.size, 0)
  const next = s.client.request('status', undefined, token)
  s.callbacks.message({ v: 1, id: s.sent[1].id, ok: true, result: { connected: true } })
  assert.deepEqual(await next, { connected: true })
})

test('expanded paid translations retain their own bound while original drafts stay limited', async () => {
  const s = guardSetup(), translated = 'Expanded translated sentence. '.repeat(320)
  s.bridge.translate = async () => ({ enabled: true, text: translated, requestId: 'send-expanded' })
  assert.ok(translated.length > 8000)
  assert.equal((await s.guard.prepare()).text, translated); assert.equal(s.sent(), 0)
  await s.guard.confirm(); assert.equal(s.sent(), 1); assert.equal(s.snapshot.text, translated)
  assert.equal(translatedTextValue('中'.repeat(20000)).length, 20000)
  assert.throws(() => translatedTextValue('😀'.repeat(10001)), /译文/)
  for (const value of ['', '  ', 'a\0b', 'x'.repeat(20001), 123]) assert.throws(() => translatedValue({ enabled: true, text: value, requestId: 'send-invalid' }))
  assert.throws(() => translationPayload({ direction: 'outgoing', id: randomUUID(), conversationId: 'fixture', text: 'x'.repeat(8001) }))
})

test('authorization bridge preserves expanded translated receipt and still rejects oversized translations', async () => {
  const s = setup(); s.values.pairToken = token
  const url = 'https://voice.google.com/u/0/messages?itemId=t.expanded', conversationId = 'gv_' + createHash('sha256').update(JSON.stringify(['/u/0/messages', 't.expanded'])).digest('hex')
  const sender = { id: extensionId, frameId: 0, tab: { id: 2 }, url }, original = { conversationId, text: 'Short original' }
  const { id } = await s.bridge.handle({ v: 1, type: 'voice.outgoing-id', payload: original }, sender)
  const payload = { ...original, id, translated: 'Expanded translation '.repeat(500), requestId: 'send-expanded-bridge' }
  s.native.request = async (op, value) => { assert.equal(op, 'authorize'); assert.equal(value.translated, payload.translated); return { authorized: true, requestId: value.requestId, attempt: 1 } }
  assert.equal((await s.bridge.handle({ v: 1, type: 'voice.authorize', payload }, sender)).authorized, true)
  await assert.rejects(s.bridge.handle({ v: 1, type: 'voice.authorize', payload: { ...payload, translated: 'x'.repeat(20001) } }, sender), /译文/)
})

test('native envelope permits bounded source plus expanded receipt but never arbitrary oversized payloads', async () => {
  const s = nativeSetup(), payload = { text: '😀'.repeat(8000), translated: '中'.repeat(20000) }
  const task = s.client.request('authorize', payload, token)
  assert.equal(s.sent.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(s.sent[0])) > 65536)
  s.callbacks.message({ v: 1, id: s.sent[0].id, ok: true, result: { authorized: true } }); await task
  await assert.rejects(s.client.request('authorize', { text: 'x'.repeat(128 * 1024) }, token), /格式无效/)
  assert.equal(s.sent.length, 1)
})

test('an expanded draft reconciles an earlier uncertain send before considering another translation', async () => {
  const s = guardSetup(); s.snapshot.text = 'Expanded paid translation '.repeat(400)
  s.bridge.dispatchStatus = async payload => {
    assert.equal(payload.text, s.snapshot.text)
    return { state: 'uncertain', requestId: 'send-expanded-existing', attempt: 1 }
  }
  await assert.rejects(s.guard.prepare(), /此前发送结果/)
  assert.equal(s.guard.state, 'uncertain'); assert.equal(s.calls.length, 0); assert.equal(s.sent(), 0)
  const next = guardSetup(); next.snapshot.text = s.snapshot.text; next.bridge.dispatchStatus = async () => ({ state: 'clear' })
  await assert.rejects(next.guard.prepare(), /文字为空或过长/); assert.equal(next.calls.length, 0)
})

test('disabled native send never starts paid translation or reserves an attempt', async () => {
  const s = guardSetup(); s.snapshot.sendButton.disabled = true
  await assert.rejects(s.guard.prepare(), /发送按钮暂不可用/); assert.equal(s.calls.length, 0)
  s.snapshot.sendButton.disabled = false; await s.guard.prepare()
  let authorizations = 0; s.bridge.authorize = async () => { authorizations++; throw new Error('must not reserve') }
  s.snapshot.sendButton.disabled = true
  await assert.rejects(s.guard.confirm(), /发送按钮暂不可用/); assert.equal(authorizations, 0); assert.equal(s.sent(), 0)
  // A disabled button must not prevent reconciliation of an earlier submission.
  const pending = guardSetup(); pending.snapshot.sendButton.disabled = true
  pending.bridge.dispatchStatus = async () => ({ state: 'uncertain', requestId: 'send-disabled-existing', attempt: 1 })
  await assert.rejects(pending.guard.prepare(), /此前发送结果/); assert.equal(pending.guard.state, 'uncertain'); assert.equal(pending.calls.length, 0)
})

test('a send button disabled while obtaining the durable ID prevents a late paid translation', async () => {
  const s = guardSetup()
  s.bridge.logicalId = async () => { s.snapshot.sendButton.disabled = true; return { id: randomUUID() } }
  await assert.rejects(s.guard.prepare(), /发送按钮暂不可用/)
  assert.equal(s.calls.length, 0); assert.equal(s.sent(), 0)
})
test('unknown adapter rejects before contacting any billing bridge', async () => {
  const s = guardSetup(); s.adapter.supported = false
  await assert.rejects(s.guard.prepare(), /尚未支持/); assert.equal(s.calls.length, 0)
})
test('failure preserves source and a same-draft retry reuses logical id', async () => {
  const s = guardSetup(); let n = 0
  s.bridge.translate = async payload => { s.calls.push(payload); if (!n++) throw new Error('offline'); return { enabled: true, text: 'Hello', requestId: 'gv-ok' } }
  await assert.rejects(s.guard.prepare(), /offline/); assert.equal(s.snapshot.text, '你好'); assert.equal(s.sent(), 0)
  await s.guard.prepare(); assert.equal(s.calls[0].id, s.calls[1].id)
})
test('Chinese output or disabled translation never reaches native send', async () => {
  for (const result of [{ enabled: true, text: 'Hello你好', requestId: 'gv-fixture' }, { enabled: false }]) {
    const s = guardSetup(); s.bridge.translate = async () => result
    await assert.rejects(s.guard.prepare()); assert.equal(s.sent(), 0); assert.equal(s.replaced(), 0)
  }
})

test('an explicitly disabled Chinese switch permits only exact untranslated originals', async () => {
  const s = guardSetup()
  s.bridge.status = async () => ({ connected: true, sendAutoTranslate: true, targetLanguage: 'en-US', blockChineseSend: false })
  s.bridge.translate = async payload => ({ enabled: true, text: payload.text, untranslated: true, requestId: 'send-gv-plain-fixture' })
  const preview = await s.guard.prepare(); assert.equal(preview.text, '你好'); assert.equal(preview.untranslated, true)
  await s.guard.confirm(); assert.equal(s.sent(), 1); assert.equal(s.snapshot.text, '你好')
  const bad = guardSetup()
  bad.bridge.status = s.bridge.status
  await assert.rejects(bad.guard.prepare(), /发送原文/); assert.equal(bad.sent(), 0)
})

test('live Chinese policy is checked after editor settlement, including OFF-ON-OFF revisions', async () => {
  for (const change of ['enabled', 'off-on-off', 'target', 'disconnected']) {
    const s = guardSetup(), status = { connected: true, targetLanguage: 'en-US', blockChineseSend: false, sendPolicyRevision: 10 }
    let statusReads = 0, authorizations = 0, finish
    s.bridge.status = async () => { statusReads++; return { ...status } }
    s.bridge.translate = async payload => { s.calls.push(payload); return { enabled: true, text: payload.text, untranslated: true, requestId: 'send-gv-live-policy' } }
    s.bridge.authorize = async payload => { authorizations++; return { authorized: true, requestId: payload.requestId, attempt: 1 } }
    s.adapter.settle = () => new Promise(resolve => { finish = resolve })
    await s.guard.prepare(); const pending = s.guard.confirm()
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function')
    if (change === 'enabled') { status.blockChineseSend = true; status.sendPolicyRevision++ }
    else if (change === 'off-on-off') status.sendPolicyRevision += 2
    else if (change === 'target') status.targetLanguage = 'fr-FR'
    else status.connected = false
    finish(); await assert.rejects(pending, /设置或连接已变化/)
    assert.equal(s.sent(), 0); assert.equal(s.snapshot.text, '你好'); assert.equal(s.guard.state, 'uncertain')
    assert.equal(statusReads, 2); assert.equal(authorizations, 1); assert.equal(s.calls.length, 1)
  }
})

test('late policy-read failure, navigation or invalidation never reaches the native button', async () => {
  for (const change of ['failure', 'navigation', 'invalidation', 'edit']) {
    const s = guardSetup(); let reads = 0, finish, fail
    s.bridge.status = async () => ++reads === 1 ? { connected: true, targetLanguage: 'en-US' } : new Promise((resolve, reject) => { finish = resolve; fail = reject })
    await s.guard.prepare(); const pending = s.guard.confirm()
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function')
    if (change === 'failure') fail(new Error('fixture status unavailable'))
    else {
      if (change === 'navigation') s.snapshot.conversationId = 'different-thread'
      else if (change === 'invalidation') s.guard.invalidate()
      else { s.snapshot.text = 'Changed draft'; s.snapshot.revision++ }
      finish({ connected: true, targetLanguage: 'en-US' })
    }
    await assert.rejects(pending); assert.equal(s.sent(), 0)
  }
})

test('status forwarding preserves only a bounded integer policy revision', () => {
  assert.deepEqual(statusValue({ connected: true, blockChineseSend: false, sendPolicyRevision: 12, privateToken: 'never-forward' }), { connected: true, blockChineseSend: false, sendPolicyRevision: 12 })
  for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null]) assert.equal(statusValue({ connected: true, sendPolicyRevision: value }).sendPolicyRevision, undefined)
})

test('enabled Chinese switch rejects Han even with a Chinese or Japanese target', async () => {
  for (const targetLanguage of ['zh-CN', 'ja']) {
    const s = guardSetup()
    s.bridge.status = async () => ({ connected: true, sendAutoTranslate: true, targetLanguage, blockChineseSend: true })
    s.bridge.translate = async () => ({ enabled: true, text: '中文𠀀', requestId: 'gv-fixture' })
    await assert.rejects(s.guard.prepare(), /中文/); assert.equal(s.sent(), 0)
  }
})
test('conversation changes or draft edits during translation are blocked', async () => {
  for (const change of [s => { s.snapshot.conversationId = 'thread-2' }, s => { s.snapshot.text = '别的内容'; s.snapshot.revision++ }]) {
    const s = guardSetup(); s.bridge.translate = async () => { change(s); return { enabled: true, text: 'Hello', requestId: 'gv-fixture' } }
    await assert.rejects(s.guard.prepare(), /变化/); assert.equal(s.sent(), 0)
  }
})
test('explicit confirm required; authorization denial never changes composer', async () => {
  const s = guardSetup(); await s.guard.prepare(); assert.equal(s.sent(), 0); assert.equal(s.snapshot.text, '你好')
  s.bridge.authorize = async () => ({ authorized: false })
  await assert.rejects(s.guard.confirm(), /授权/); assert.equal(s.replaced(), 0)
})
test('closing a paid preview resumes idle without discarding its draft identity or charging again', async () => {
  const s = guardSetup(), paid = new Set()
  s.bridge.translate = async payload => { paid.add(payload.id); return { enabled: true, text: 'Hello', requestId: 'gv-fixture-1' } }
  await s.guard.prepare(); const id = s.guard.job.id
  s.guard.dismissPreview(); assert.equal(s.guard.state, 'idle'); assert.equal(s.guard.job.id, id)
  await assert.rejects(s.guard.confirm(), /预览/)
  await s.guard.prepare(); assert.equal(s.guard.job.id, id); assert.equal(paid.size, 1)
  assert.equal(s.sent(), 0); assert.equal(s.replaced(), 0)
})
test('closing preparation discards its late result but preserves the paid draft for a new preview', async () => {
  const s = guardSetup(); let finish
  s.bridge.translate = () => new Promise(resolve => { finish = resolve })
  const pending = s.guard.prepare(); await new Promise(resolve => setImmediate(resolve))
  const id = s.guard.job.id; s.guard.dismissPreview(); assert.equal(s.guard.state, 'idle')
  finish({ enabled: true, text: 'Hello', requestId: 'gv-fixture-1' })
  await assert.rejects(pending, /预览已关闭/); assert.equal(s.guard.state, 'idle'); assert.equal(s.guard.job.id, id)
  assert.equal(s.sent(), 0); assert.equal(s.replaced(), 0)
})
test('a dismissed preparation cannot overwrite a newer preview when its response arrives last', async () => {
  const s = guardSetup(); let finish, first = true
  s.bridge.translate = async () => {
    if (first) { first = false; return new Promise(resolve => { finish = resolve }) }
    return { enabled: true, text: 'Current preview', requestId: 'gv-fixture-1' }
  }
  const pending = s.guard.prepare(); await new Promise(resolve => setImmediate(resolve))
  s.guard.dismissPreview(); await s.guard.prepare()
  finish({ enabled: true, text: 'Obsolete preview', requestId: 'gv-fixture-1' })
  await assert.rejects(pending, /预览已关闭/)
  assert.equal(s.guard.state, 'preview'); assert.equal(s.guard.job.translated.text, 'Current preview')
})
test('closing authorization preserves a late durable reservation and never writes or sends', async () => {
  const s = guardSetup(); await s.guard.prepare(); let finish
  s.bridge.authorize = () => new Promise(resolve => { finish = resolve })
  const pending = s.guard.confirm(); s.guard.dismissPreview(); assert.equal(s.guard.state, 'authorizing')
  finish({ authorized: true, requestId: 'gv-fixture-1', attempt: 3 })
  await assert.rejects(pending, /预览已关闭/); assert.equal(s.guard.state, 'uncertain')
  assert.equal(s.guard.job.pendingAttempt, 3); assert.equal(s.replaced(), 0); assert.equal(s.sent(), 0)
  await assert.rejects(s.guard.prepare(), /待确认/)
  s.bridge.dispatchResolve = async payload => { assert.equal(payload.attempt, 3); return { resolved: true } }
  await s.guard.resolve('not-sent'); assert.equal(s.guard.state, 'idle')
})
test('closing authorization with a lost reply keeps durable reconciliation ahead of another translation', async () => {
  const s = guardSetup(); await s.guard.prepare(); let fail
  s.bridge.authorize = () => new Promise((_resolve, reject) => { fail = reject })
  const pending = s.guard.confirm(); s.guard.dismissPreview(); fail(new Error('lost receipt'))
  await assert.rejects(pending, /lost receipt/); assert.equal(s.guard.state, 'failed')
  s.bridge.dispatchStatus = async () => ({ state: 'uncertain', requestId: 'gv-fixture-1', attempt: 1 })
  await assert.rejects(s.guard.prepare(), /此前发送/); assert.equal(s.calls.length, 1); assert.equal(s.sent(), 0)
})
test('closing while the translated editor settles preserves uncertainty and cancels the native click', async () => {
  const s = guardSetup(); await s.guard.prepare(); let finish
  s.adapter.settle = () => new Promise(resolve => { finish = resolve })
  const pending = s.guard.confirm(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.replaced(), 1); s.guard.dismissPreview(); finish()
  await assert.rejects(pending, /预览已关闭/); assert.equal(s.guard.state, 'uncertain'); assert.equal(s.sent(), 0)
})
test('conversation changes during authorization are rechecked before write', async () => {
  const s = guardSetup(); await s.guard.prepare(); s.bridge.authorize = async payload => { s.snapshot.conversationId = 'thread-2'; return { authorized: true, requestId: payload.requestId, attempt: 1 } }
  await assert.rejects(s.guard.confirm(), /变化/); assert.equal(s.replaced(), 0)
})
test('failed write verification blocks send; no original Chinese fallback', async () => {
  const s = guardSetup(); await s.guard.prepare(); s.adapter.replace = () => true
  await assert.rejects(s.guard.confirm(), /核对/); assert.equal(s.sent(), 0)
})
test('dispatch exception remains uncertain and cannot replay', async () => {
  const s = guardSetup(); await s.guard.prepare(); s.adapter.dispatch = () => { throw new Error('unknown click') }
  await assert.rejects(s.guard.confirm(), /unknown/); assert.equal(s.guard.state, 'uncertain')
  await assert.rejects(s.guard.confirm()); await assert.rejects(s.guard.prepare(), /待确认/)
})
test('strict successful path dispatches translated text once and stays unconfirmed', async () => {
  const s = guardSetup(); await s.guard.prepare(); const value = await s.guard.confirm()
  assert.equal(value.state, 'uncertain'); assert.equal(s.sent(), 1); assert.equal(s.snapshot.text, 'Hello')
  await assert.rejects(s.guard.confirm()); assert.equal(s.sent(), 1)
})
test('context invalidation while translating discards the preview and preserves the original draft', async () => {
  const f = guardSetup(); let finish
  f.bridge.translate = () => new Promise(resolve => { finish = resolve })
  const pending = f.guard.prepare()
  await new Promise(resolve => setImmediate(resolve))
  f.guard.invalidate(); finish({ enabled: true, text: 'Hello', requestId: 'fixture-invalidated' })
  await assert.rejects(pending, /变化/)
  assert.equal(f.replaced(), 0); assert.equal(f.sent(), 0)
  await assert.rejects(f.guard.confirm(), /变化/)
})
test('context invalidation during authorization cannot replace or dispatch a draft', async () => {
  const f = guardSetup(); await f.guard.prepare(); let finish
  f.bridge.authorize = () => new Promise(resolve => { finish = resolve })
  const pending = f.guard.confirm(); f.guard.invalidate()
  finish({ authorized: true, requestId: 'gv-fixture-1', attempt: 1 })
  await assert.rejects(pending, /变化/)
  assert.equal(f.replaced(), 0); assert.equal(f.sent(), 0)
})
test('context invalidation during input settling cannot dispatch an already replaced draft', async () => {
  const f = guardSetup(); await f.guard.prepare(); let finish
  f.adapter.settle = () => new Promise(resolve => { finish = resolve })
  const pending = f.guard.confirm(); await new Promise(resolve => setImmediate(resolve))
  f.guard.invalidate(); finish()
  await assert.rejects(pending, /变化/)
  assert.equal(f.replaced(), 1); assert.equal(f.sent(), 0)
})
test('uncertain send blocks the same original and translated draft but permits another draft', async () => {
  const s = guardSetup(); await s.guard.prepare(); await s.guard.confirm()
  await assert.rejects(s.guard.prepare(), /待确认/)
  s.snapshot.text = '另一条短信'; s.snapshot.revision++
  await s.guard.prepare(); assert.equal(s.guard.state, 'preview'); assert.equal(s.sent(), 1)
})
test('durable draft identifier is obtained before translation and draft edits prevent charging', async () => {
  const s = guardSetup(), stable = randomUUID()
  s.bridge.dispatchStatus = async () => ({ state: 'clear' }); s.bridge.logicalId = async () => ({ id: stable })
  await s.guard.prepare(); assert.equal(s.calls[0].id, stable)
  s.snapshot.text = 'changed'; s.snapshot.revision++
  s.bridge.logicalId = async () => { s.snapshot.text = 'changed again'; return { id: stable } }
  await assert.rejects(s.guard.prepare(), /未提交翻译/); assert.equal(s.calls.length, 1)
})
test('durable uncertain state is checked before translation; only explicit outcome clears it', async () => {
  const s = guardSetup(); s.bridge.dispatchStatus = async () => ({ state: 'uncertain', requestId: 'send-existing', attempt: 1 })
  const resolved = []; s.bridge.dispatchResolve = async payload => { resolved.push(payload); return { resolved: true } }
  await assert.rejects(s.guard.prepare(), /此前发送/); assert.equal(s.calls.length, 0)
  await assert.rejects(s.guard.resolve('guess'))
  await s.guard.resolve('not-sent'); assert.equal(s.guard.state, 'idle')
  assert.deepEqual(resolved, [{ conversationId: 'thread-1', requestId: 'send-existing', attempt: 1, outcome: 'not-sent', confirmed: true }])
})
test('plain host-authorized text works with automatic sending translation disabled', async () => {
  const s = guardSetup(); s.snapshot.text = 'Hello'
  s.bridge.status = async () => ({ connected: true, sendAutoTranslate: false, targetLanguage: 'en-US' })
  s.bridge.translate = async () => ({ enabled: true, text: 'Hello', requestId: 'send-gv-plain-fixture', untranslated: true })
  await s.guard.prepare(); await s.guard.confirm(); assert.equal(s.sent(), 1)
})

const syntheticMedia = { fingerprint: 'a'.repeat(64), count: 1, types: ['image/png'], totalBytes: 500 }
const syntheticRecipients = { kind: 'recipients', recipientKey: 'b'.repeat(64), recipientCount: 2 }
test('media-only request requires verified images and rejects malformed or incoming recipients', () => {
  const payload = { id: randomUUID(), conversationId: 'fixture', direction: 'outgoing', text: '', media: syntheticMedia, context: syntheticRecipients }
  assert.deepEqual(translationPayload(payload).media, syntheticMedia)
  assert.deepEqual(translationPayload(payload).context, syntheticRecipients)
  assert.throws(() => translationPayload({ ...payload, media: undefined }))
  assert.throws(() => translationPayload({ ...payload, direction: 'incoming' }))
  for (const media of [{ ...syntheticMedia, count: 2 }, { ...syntheticMedia, totalBytes: 21 * 1024 * 1024 }, { ...syntheticMedia, types: ['video/mp4'] }, { ...syntheticMedia, fingerprint: 'x'.repeat(64) }]) assert.throws(() => mediaValue(media))
  for (const context of [{ ...syntheticRecipients, recipientCount: 8 }, { ...syntheticRecipients, recipientCount: 0 }, { ...syntheticRecipients, recipientKey: 'not-a-hash' }]) assert.throws(() => recipientContextValue(context))
})
test('media receipt mismatch and changed recipients during provider work never reach send', async () => {
  for (const mode of ['missing-media', 'different-media', 'different-recipients']) {
    const s = guardSetup(); s.snapshot.media = syntheticMedia; s.snapshot.context = syntheticRecipients
    s.bridge.translate = async () => {
      if (mode === 'different-recipients') s.snapshot.context = { ...syntheticRecipients, recipientKey: 'c'.repeat(64) }
      return { enabled: true, text: 'Hello', requestId: 'synthetic-media-receipt', ...(mode === 'missing-media' ? {} : { media: mode === 'different-media' ? { ...syntheticMedia, fingerprint: 'c'.repeat(64) } : syntheticMedia }) }
    }
    await assert.rejects(s.guard.prepare()); assert.equal(s.sent(), 0); assert.equal(s.replaced(), 0)
  }
})
test('media replacement during authorization or input settle preserves uncertain reservation without a click', async () => {
  for (const phase of ['authorize', 'settle']) {
    const s = guardSetup(); s.snapshot.media = syntheticMedia; s.snapshot.mediaRevision = 1
    s.bridge.translate = async () => ({ enabled: true, text: 'Hello', requestId: 'synthetic-media-receipt', media: syntheticMedia })
    await s.guard.prepare()
    if (phase === 'authorize') s.bridge.authorize = async payload => { s.snapshot.mediaRevision++; return { authorized: true, requestId: payload.requestId, attempt: 1 } }
    else s.adapter.settle = async () => { s.snapshot.mediaRevision++ }
    await assert.rejects(s.guard.confirm()); assert.equal(s.sent(), 0); assert.equal(s.guard.state, 'uncertain')
  }
})
test('all outgoing operations retain media and recipient scope including explicit uncertain resolution', async () => {
  const s = guardSetup(), seen = []; s.snapshot.text = ''; s.snapshot.media = syntheticMedia; s.snapshot.context = syntheticRecipients
  const resultId = 'send-gv-plain-synthetic'
  s.bridge.dispatchStatus = async value => { seen.push(value); return { state: 'clear' } }
  s.bridge.logicalId = async value => { seen.push(value); return { id: randomUUID() } }
  s.bridge.translate = async value => { seen.push(value); return { enabled: true, text: '', requestId: resultId, media: syntheticMedia, untranslated: true } }
  s.bridge.authorize = async value => { seen.push(value); return { authorized: true, requestId: resultId, attempt: 1 } }
  s.bridge.dispatchResolve = async value => { seen.push(value); return { resolved: true } }
  await s.guard.prepare(); await s.guard.confirm(); await s.guard.resolve('sent')
  assert.equal(seen.length, 5); assert.equal(s.sent(), 1)
  for (const value of seen) { assert.deepEqual(value.media, syntheticMedia); assert.deepEqual(value.context, syntheticRecipients) }
})
test('draft IDs survive background restart without stored plaintext; sent resolution renews the next explicit draft', async () => {
  const s = setup(); s.values.pairToken = token
  const url = 'https://voice.google.com/u/6/messages?itemId=t.synthetic', conversationId = 'gv_' + createHash('sha256').update(JSON.stringify(['/u/6/messages', 't.synthetic'])).digest('hex')
  const sender = { id: extensionId, frameId: 0, tab: { id: 1 }, url }, payload = { conversationId, text: 'SYNTHETIC PRIVATE DRAFT' }
  const message = { v: 1, type: 'voice.outgoing-id', payload }
  const [first, concurrent] = await Promise.all([s.bridge.handle(message, sender), s.bridge.handle(message, sender)])
  assert.equal(first.id, concurrent.id)
  const restarted = new ExtensionBridge({ native: s.native, storage: s.storage, runtime: s.bridge.runtime })
  assert.equal((await restarted.handle(message, sender)).id, first.id)
  assert.equal(JSON.stringify(s.values.outgoingDraftIds).includes(payload.text), false); assert.equal(JSON.stringify(s.values.outgoingDraftIds).includes(token), false)
  s.native.request = async (op, value) => op === 'authorize' ? { authorized: true, requestId: value.requestId, attempt: 1 } : { resolved: true }
  await restarted.handle({ v: 1, type: 'voice.authorize', payload: { ...payload, id: first.id, translated: 'Hello', requestId: 'send-synthetic' } }, sender)
  await restarted.handle({ v: 1, type: 'voice.dispatch-resolve', payload: { conversationId, requestId: 'send-synthetic', attempt: 1, outcome: 'not-sent', confirmed: true } }, sender)
  assert.equal((await restarted.handle(message, sender)).id, first.id)
  await restarted.handle({ v: 1, type: 'voice.dispatch-resolve', payload: { conversationId, requestId: 'send-synthetic', attempt: 1, outcome: 'sent', confirmed: true } }, sender)
  assert.notEqual((await restarted.handle(message, sender)).id, first.id)
})
test('DOM bridge refuses wrong conversation, sender and unallocated outgoing IDs before native billing', async () => {
  const s = setup(); s.values.pairToken = token
  const url = 'https://voice.google.com/u/6/messages?itemId=t.synthetic', conversationId = 'gv_' + createHash('sha256').update(JSON.stringify(['/u/6/messages', 't.synthetic'])).digest('hex')
  const sender = { id: extensionId, frameId: 0, tab: { id: 1 }, url }, payload = { conversationId, id: randomUUID(), text: 'Synthetic', direction: 'outgoing' }
  await assert.rejects(s.bridge.handle({ v: 1, type: 'voice.translate', payload }, sender), /草稿编号/)
  await assert.rejects(s.bridge.handle({ v: 1, type: 'voice.translate', payload: { ...payload, conversationId: 'wrong' } }, sender), /会话/)
  await assert.rejects(s.bridge.handle({ v: 1, type: 'voice.translate', payload }, { ...sender, frameId: 1 }))
  assert.equal(s.calls.length, 0)
})
test('capture gate blocks send and composition events, refusing unsupported adapters', async () => {
  const target = new EventTarget(); let attempts = 0
  assert.throws(() => installSendInterception(target, { supported: false }, () => {}))
  const dispose = installSendInterception(target, { supported: true, isSendEvent: () => true }, () => attempts++)
  const enter = new Event('keydown', { cancelable: true }); target.dispatchEvent(enter); await Promise.resolve()
  assert.equal(enter.defaultPrevented, true); assert.equal(attempts, 1)
  const ime = new Event('keydown', { cancelable: true }); Object.defineProperty(ime, 'isComposing', { value: true }); target.dispatchEvent(ime); await Promise.resolve()
  assert.equal(ime.defaultPrevented, true); assert.equal(attempts, 1); dispose()
})
test('manual selection retry keeps original business ID, dedupes pending and reuses successful preview', async () => {
  const tasks = new SelectionTasks(), request = { tabId: 1, ticket: randomUUID(), key: 'a'.repeat(64), id: randomUUID() }, seen = []
  const fail = id => { seen.push(id); throw new Error('lost receipt') }
  await assert.rejects(tasks.run(request, fail)); await assert.rejects(tasks.run(request, fail))
  assert.deepEqual(seen, [request.id, request.id])
  let finish, calls = 0
  const translate = id => { calls++; assert.equal(id, request.id); return new Promise(resolve => { finish = resolve }) }
  const one = tasks.run(request, translate), two = tasks.run(request, translate)
  await Promise.resolve(); assert.equal(calls, 1)
  finish({ text: 'cached result' }); await Promise.all([one, two])
  assert.deepEqual(await tasks.run(request, () => { throw new Error('must not bill again') }), { text: 'cached result' })
})
test('selection navigation/new language cannot reuse a different task or response', async () => {
  const tasks = new SelectionTasks(), base = { tabId: 1, ticket: randomUUID(), key: 'a'.repeat(64), id: randomUUID() }
  await tasks.run(base, async () => ({ text: 'first' }))
  await assert.rejects(tasks.run({ ...base, id: randomUUID() }, async () => ({})), /编号/)
  assert.deepEqual(await tasks.run({ ...base, ticket: randomUUID(), id: randomUUID() }, async () => ({ text: 'new document' })), { text: 'new document' })
  tasks.clear(1); assert.equal(tasks.tabs.size, 0)
})
test('extension protocol round-trips with the actual HelloDog main bridge using only synthetic data', async () => {
  const { mainHarness } = await import('../../../tests/main-harness.ts')
  const h = mainHarness(), { GoogleVoiceExtensionBridge } = h.load('src/main/platforms/googleVoice/extensionBridge.ts')
  let owner = 'synthetic-owner', data = { pairs: [] }; const calls = []
  const host = new GoogleVoiceExtensionBridge({ read: async () => structuredClone(data), write: async value => { data = structuredClone(value) } },
    () => { const captured = owner; return { owner: captured, authorized: () => owner === captured } },
    async (user, id) => user === 'synthetic-owner' && id === 'fixture-window',
    async (user, window, op, payload) => { calls.push({ user, window, op, payload }); return op === 'status' ? { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US' } : { enabled: true, text: '本地样例结果', requestId: 'gv-fixture-confirmed' } })
  const s = setup()
  s.native.request = async (op, payload, pairToken) => {
    const result = await host.request({ v: 1, id: randomUUID(), op, payload, pairToken })
    if (!result.ok) throw new Error('host rejected')
    return result.result
  }
  const code = await host.code('fixture-window')
  await s.bridge.handle({ v: 1, type: 'pair', code }, popup)
  assert.equal((await s.bridge.handle({ v: 1, type: 'status' }, popup)).status.localLanguage, 'zh-CN')
  assert.match((await s.bridge.selectionScope()).key, /^[a-f0-9]{64}$/)
  assert.equal((await s.bridge.translateSelection('Synthetic text only', 'https://voice.google.com/', randomUUID())).text, '本地样例结果')
  assert.equal(calls.at(-1).window, 'fixture-window'); assert.equal(calls.at(-1).payload.conversationId, 'manual-selection')
  owner = 'another-owner'
  await assert.rejects(s.bridge.handle({ v: 1, type: 'status' }, popup), /host rejected/)
})
