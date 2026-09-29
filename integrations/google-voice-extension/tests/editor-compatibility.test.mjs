import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'

const { JSDOM } = createRequire(new URL('../../../tests/package.json', import.meta.url))('jsdom')
const modules = ['protocol.mjs', 'send-guard.mjs', 'voice-adapter.mjs', 'content-runtime.js'].map(file =>
  readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
).join('\n')
const pause = () => new Promise(resolve => setTimeout(resolve, 25))
function fixture() {
  const dom = new JSDOM(`<gv-thread-details><gv-message-list></gv-message-list><gv-message-entry>
    <textarea class="message-input" aria-readonly="false">Synthetic draft</textarea>
    <gv-message-actions><button aria-label="Add image" type="button">Add image</button><input type="file"></gv-message-actions>
    <button class="send-button" aria-label="Send message" type="button">Send</button>
    </gv-message-entry></gv-thread-details>`, { url: 'https://voice.google.com/u/0/messages?itemId=t.synthetic-editor', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, calls = [], roots = []
  Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextEncoder = TextEncoder
  w.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}] }
  const attach = w.Element.prototype.attachShadow
  w.Element.prototype.attachShadow = function (options) { const root = attach.call(this, options); roots.push(root); return root }
  w.fixtureBridge = async request => {
    calls.push(request)
    if (request.type !== 'voice.status') throw new Error('Unrecognized editor must never reach translation or authorization')
    return { ok: true, result: { connected: true, targetLanguage: 'en-US', receiveAutoTranslate: false } }
  }
  w.eval(`(() => {${modules}\nwindow.SendGuard = SendGuard; window.adapter = new GoogleVoiceDomAdapter(document, location); window.start = () => window.runtime = installGoogleVoiceRuntime({sendRequest: value => window.fixtureBridge(value)});})()`)
  const entry = w.document.querySelector('gv-message-entry'), draft = entry.querySelector('textarea'), send = entry.querySelector('.send-button')
  return { w, entry, draft, send, calls, adapter: w.adapter, panel: () => roots.filter(root => root.host.isConnected).map(root => root.textContent + root.querySelector('textarea')?.value).join('\n'),
    close() { w.runtime?.dispose(); w.adapter.dispose(); dom.window.close() } }
}

test('editable native textarea does not require a redundant aria-readonly=false attribute', async () => {
  const f = fixture()
  try {
    f.draft.removeAttribute('aria-readonly')
    assert.equal(await f.adapter.refresh(), true)
    f.draft.readOnly = true; assert.equal(await f.adapter.refresh(), false)
    f.draft.readOnly = false; f.draft.setAttribute('aria-readonly', 'true'); assert.equal(await f.adapter.refresh(), false)
    f.draft.setAttribute('aria-readonly', 'false'); f.draft.disabled = true; assert.equal(await f.adapter.refresh(), false)
  } finally { f.close() }
})

test('renamed or role-based send controls are blocked with a reason before native handlers', async () => {
  for (const roleButton of [false, true]) {
    const f = fixture()
    try {
      let nativeClicks = 0
      const target = roleButton ? f.w.document.createElement('span') : f.send
      if (roleButton) { target.setAttribute('role', 'button'); target.setAttribute('aria-label', 'Send message'); target.textContent = 'Send'; f.send.replaceWith(target) }
      else target.className = 'new-send-class'
      target.addEventListener('click', () => { nativeClicks++ })
      f.w.start()
      const event = new f.w.MouseEvent('click', { bubbles: true, cancelable: true }); target.dispatchEvent(event)
      await pause()
      assert.equal(event.defaultPrevented, true); assert.equal(nativeClicks, 0)
      assert.match(f.panel(), /未识别.*已阻止|已阻止.*未识别/)
      assert.ok(f.calls.every(call => call.type === 'voice.status'))
    } finally { f.close() }
  }
})

test('renamed composer Enter cannot bypass preview and recognized native image controls remain usable', async () => {
  const f = fixture()
  try {
    let nativeSends = 0, imageClicks = 0
    f.draft.className = 'new-message-class'; f.draft.addEventListener('keydown', () => { nativeSends++ })
    const image = f.entry.querySelector('gv-message-actions button'); image.addEventListener('click', () => { imageClicks++ })
    f.w.start(); image.click()
    const event = new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); f.draft.dispatchEvent(event)
    await pause()
    assert.equal(imageClicks, 1); assert.equal(event.defaultPrevented, true); assert.equal(nativeSends, 0)
    assert.match(f.panel(), /未识别的输入框/); assert.ok(f.calls.every(call => call.type === 'voice.status'))
  } finally { f.close() }
})

test('unknown action inside native attachment actions cannot become an unguarded send entry', async () => {
  const f = fixture()
  try {
    let clicks = 0
    const unknown = f.w.document.createElement('button'); unknown.textContent = 'Unrecognized'; unknown.addEventListener('click', () => { clicks++ })
    f.entry.querySelector('gv-message-actions').append(unknown); f.w.start()
    unknown.click(); await pause()
    assert.equal(clicks, 0); assert.match(f.panel(), /未识别.*已阻止|已阻止.*未识别/)
    assert.equal(await f.adapter.refresh(), false)
  } finally { f.close() }
})

test('hidden progress remnants do not permanently block a verified CSS image preview', async () => {
  const f = fixture()
  try {
    const markup = '<gv-send-attachment-list><div class="container" role="grid"><div role="row"><div class="item" role="gridcell"><span class="close-icon-overlay" role="button">Remove</span><div class="content"></div></div></div></div></gv-send-attachment-list><div hidden><div role="progressbar"></div></div>'
    f.entry.insertAdjacentHTML('afterbegin', markup)
    f.entry.querySelector('.content').style.backgroundImage = 'url("data:image/png;base64,AQID")'
    const file = { token: 'image/png;AQID', type: 'image/png', size: 3, fingerprint: 'a'.repeat(64) }
    const media = { fingerprint: 'b'.repeat(64), count: 1, types: ['image/png'], totalBytes: 3 }
    f.adapter.attachments.set(f.entry, { revision: 1, knownFiles: [file], cssSignature: JSON.stringify([[file.type, file.size, file.fingerprint]]), cssMedia: media, media, deadline: Date.now() + 1000 })
    assert.equal(await f.adapter.refresh(), true)
    f.entry.querySelector('[hidden]').removeAttribute('hidden'); assert.equal(await f.adapter.refresh(), false)
    assert.match(f.adapter.reason, /图片仍在准备/)
  } finally { f.close() }
})

test('Enter in an unknown second editor cannot translate or submit the recognized editor draft', async () => {
  const f = fixture()
  try {
    const other = f.w.document.createElement('textarea'); other.value = 'OTHER TEXT'; f.entry.append(other)
    await f.adapter.refresh(); assert.equal(f.adapter.snapshot().text, 'Synthetic draft')
    let nativeEvents = 0; other.addEventListener('keydown', () => { nativeEvents++ }); f.w.start()
    const event = new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); other.dispatchEvent(event)
    await pause()
    assert.equal(event.defaultPrevented, true); assert.equal(nativeEvents, 0)
    assert.match(f.panel(), /未识别的输入框/); assert.equal(f.draft.value, 'Synthetic draft'); assert.equal(other.value, 'OTHER TEXT')
    assert.ok(f.calls.every(call => call.type === 'voice.status'))
  } finally { f.close() }
})

test('hidden non-send template controls do not disable a recognized composer, but becoming visible fails closed', async () => {
  const f = fixture()
  try {
    const template = f.w.document.createElement('button'); template.type = 'button'; template.hidden = true; template.textContent = 'Inactive template'; f.entry.append(template)
    assert.equal(await f.adapter.refresh(), true)
    template.hidden = false; assert.equal(await f.adapter.refresh(), false); assert.match(f.adapter.reason, /未识别/)
  } finally { f.close() }
})

test('aria-disabled appearing during authorization blocks the final native click and preserves uncertainty', async () => {
  const f = fixture()
  try {
    let clicks = 0; f.send.addEventListener('click', () => { clicks++ })
    await f.adapter.refresh()
    const guard = new f.w.SendGuard(f.adapter, {
      status: async () => ({ connected: true, targetLanguage: 'en-US' }),
      translate: async () => ({ enabled: true, text: 'Translated draft', requestId: 'send-aria-fixture' }),
      authorize: async payload => { f.send.setAttribute('aria-disabled', 'true'); return { authorized: true, requestId: payload.requestId, attempt: 1 } }
    })
    await guard.prepare(); await assert.rejects(guard.confirm(), /发送前页面已变化/)
    assert.equal(clicks, 0); assert.equal(guard.state, 'uncertain')
  } finally { f.close() }
})
