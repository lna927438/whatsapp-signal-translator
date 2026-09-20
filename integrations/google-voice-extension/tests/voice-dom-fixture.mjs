import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { ExtensionBridge } from '../background-core.mjs'
import { mainHarness } from '../../../tests/main-harness.ts'
const require = createRequire(import.meta.url), { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = new URL('./artifacts/', import.meta.url); await mkdir(output, { recursive: true })
const h = mainHarness(), { GoogleVoiceExtensionBridge } = h.load('src/main/platforms/googleVoice/extensionBridge.ts'), { GoogleVoiceDispatchLedger } = h.load('src/main/platforms/googleVoice/dispatchLedger.ts'), { createGoogleVoiceTranslator } = h.load('src/main/platforms/googleVoice/translationBridge.ts')
let pairData = { pairs: [] }, dispatchData = { records: [] }, values = {}, lostReply = false, quotaDenied = false, incomingProviderCalls = 0
const incoming = new Map(), outgoing = new Map(), requests = new Map(), nativeCalls = [], checks = [], errors = []
const preferences = { localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, historyMode: 'visible', translationsVisible: true, translationQuality: { tone: 'natural' } }
const store = (get, set) => ({ read: async () => structuredClone(get()), write: async value => set(structuredClone(value)) })
const ledger = new GoogleVoiceDispatchLedger(store(() => dispatchData, value => { dispatchData = value }))
const translator = {
  preserveOutgoingRequest: async value => { requests.set(value.requestId, value); return value }, prepareOutgoingRequest: async value => value, preserveIncomingRequest: async value => value,
  existingOutgoing: async id => { if (!requests.has(id)) throw new Error('missing fixture receipt'); return requests.get(id) },
  translate: async value => { if (!outgoing.has(value.requestId)) outgoing.set(value.requestId, 'Hello fixture'); return outgoing.get(value.requestId) },
  cached: async value => incoming.get(value.requestId), translateIncoming: async value => { incomingProviderCalls++; const text = '样例译文：' + value.text; incoming.set(value.requestId, text); return text }
}
const host = new GoogleVoiceExtensionBridge(store(() => pairData, value => { pairData = value }), () => ({ owner: 'fixture-owner', authorized: () => true }), async (_owner, id) => id === 'fixture-window',
  createGoogleVoiceTranslator(translator, { check: async () => { if (quotaDenied) throw new Error('fixture quota denied') } }, async () => preferences, ledger))
const extensionId = 'kigfaejcipjibnmnpinplphfldjahknn', runtime = { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}` },
  storage = { get: async key => ({ [key]: structuredClone(values[key]) }), set: async value => { values = { ...values, ...structuredClone(value) } }, remove: async key => { delete values[key] } },
  native = { request: async (op, payload, pairToken) => {
    nativeCalls.push({ op, payload: structuredClone(payload) })
    const answer = await host.request({ v: 1, id: randomUUID(), op, payload, pairToken })
    if (!answer.ok) throw new Error('fixture host rejected')
    if (op === 'translate' && payload.direction === 'outgoing' && lostReply) { lostReply = false; throw new Error('fixture lost receipt') }
    return answer.result
  } }
let extension = new ExtensionBridge({ native, storage, runtime })
await extension.handle({ v: 1, type: 'pair', code: await host.code('fixture-window') }, { id: extensionId, url: runtime.getURL('popup.html') })
const message = (id, text, incoming = false, time = '2:36 AM', extra = '') => `<gv-message-item id="fixture-${id}"><div class="full-container ${incoming ? 'incoming' : 'outgoing'}"><div class="message-row ${incoming ? '' : 'outgoing'}"><gv-annotation class="content">${text}</gv-annotation></div><div class="status" aria-hidden="true">${time}</div><span class="cdk-visually-hidden">Message from ${incoming ? 'Synthetic sender' : 'you'}, ${text}, Friday, September 18 2026, ${time}.</span>${extra}</div></gv-message-item>`
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px Arial;margin:16px}gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}gv-message-item{padding:8px;border-bottom:1px solid #ddd}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}textarea{width:600px;height:80px}button{padding:8px}gv-message-entry{position:fixed;bottom:0;background:#fff;width:100%;padding:12px}.full-container{display:block}</style><h1>Offline Google Voice DOM fixture</h1><gv-thread-details><gv-message-list>${message('out','Hello shared history')}${message('duplicate','Hello shared history')}${message('in','Incoming fixture text',true)}</gv-message-list><gv-message-entry><div class="root"><div class="container"><div class="message-input-container"><textarea class="message-input" placeholder="Type a message" aria-readonly="false"></textarea></div><gv-message-actions><button aria-label="Add image">Add image</button><input type="file" style="display:none"></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></div></div></gv-message-entry></gv-thread-details>`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
  await page.exposeFunction('fixtureBridge', async (value, url) => {
    try { return { ok: true, result: await extension.handle(value, { id: extensionId, frameId: 0, tab: { id: 99 }, url }) } }
    catch (error) { return { ok: false, error: error.message } }
  })
  const content = await readFile(new URL('../content.js', import.meta.url), 'utf8')
  await page.addInitScript(() => {
    window.fixtureRoots = []; const original = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (options) { const root = original.call(this, options); window.fixtureRoots.push(root); return root }
    window.chrome = { runtime: { id: 'kigfaejcipjibnmnpinplphfldjahknn', sendMessage: message => window.fixtureBridge(message, location.href), onMessage: { addListener: listener => { window.extensionMessage = listener }, removeListener: listener => { if (window.extensionMessage === listener) window.extensionMessage = null } } } }
  })
  // Run even earlier than document_start: observe Document safely before the
  // document element exists, and install interception before site handlers.
  await page.addInitScript({ content })
  async function load() {
    await page.goto('https://voice.google.com/u/6/messages?itemId=t.fixture-one')
    await page.evaluate(() => {
      window.sent = []; window.addImageClicked = false
      const draft = document.querySelector('textarea'), button = document.querySelector('.send-button')
      draft.addEventListener('input', () => { button.disabled = !draft.value })
      button.addEventListener('click', () => { window.sent.push(draft.value); draft.value = ''; draft.dispatchEvent(new Event('input', { bubbles: true })) })
      document.querySelector('[aria-label="Add image"]').addEventListener('click', () => { window.addImageClicked = true })
    })
    await page.waitForSelector('[data-hellodog-voice="toolbar"]')
  }
  async function panelHas(text) {
    try { await page.waitForFunction(value => window.fixtureRoots.some(root => root.host.isConnected && (root.textContent + [...root.querySelectorAll('textarea')].map(node => node.value).join('\n')).includes(value)), text, { timeout: 8000 }) }
    catch (error) { console.log(JSON.stringify({ expectedPanel: text, errors, operations: nativeCalls.map(call => call.op), panels: await page.evaluate(() => window.fixtureRoots.filter(root => root.host.isConnected).map(root => ({ text: root.textContent, value: root.querySelector('textarea')?.value }))) })); throw error }
  }
  async function clickPanel(text) { await page.evaluate(value => { const root = [...window.fixtureRoots].reverse().find(root => root.host.isConnected); const button = [...root.querySelectorAll('button')].find(button => button.textContent === value); if (!button || button.disabled) throw new Error('fixture panel button unavailable: '+value); button.click() }, text) }
  async function prepare(text) { await page.locator('textarea.message-input').fill(text); await page.locator('textarea.message-input').press('Enter') }
  await load()
  try { await page.waitForFunction(() => [...document.querySelectorAll('[data-hellodog-voice="translation"]')].length === 3 && [...document.querySelectorAll('[data-hellodog-voice="translation"]')].every(node => node.textContent.startsWith('样例译文')), undefined, { timeout: 8000 }) }
  catch (error) { console.log(JSON.stringify({ errors, operations: nativeCalls.map(call => call.op), body: await page.locator('body').innerText() })); throw error }
  assert.equal(incoming.size, 2); checks.push('verified incoming/outgoing DOM with three views and two unique translation requests')
  const translationCallsBeforeRedraw = nativeCalls.filter(call => call.op === 'translate').length
  await page.evaluate(() => { const item = document.getElementById('fixture-duplicate'); item.innerHTML = document.getElementById('fixture-out').innerHTML.replace(/<div data-hellodog-voice="translation"[\s\S]*?<\/div>/, '') })
  await page.waitForFunction(() => document.querySelectorAll('#fixture-duplicate [data-hellodog-voice="translation"]').length === 1)
  assert.equal(incoming.size, 2); assert.equal(nativeCalls.filter(call => call.op === 'translate').length, translationCallsBeforeRedraw); checks.push('same-time same-text virtual redraw reuses result without additional request or billing')
  const modifierCalls = nativeCalls.length
  const keyboard = await page.evaluate(() => {
    const draft = document.querySelector('textarea.message-input'), results = []
    for (const props of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...props }); draft.dispatchEvent(event); results.push(event.defaultPrevented)
    }
    for (const type of ['keyup', 'keypress']) { const event = new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true }); draft.dispatchEvent(event); results.push(event.defaultPrevented) }
    const input = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }); draft.dispatchEvent(input); results.push(input.defaultPrevented)
    return results
  })
  assert.equal(keyboard.every(Boolean), true); assert.equal(nativeCalls.length, modifierCalls)
  await page.locator('textarea.message-input').fill('Newline fixture'); await page.locator('textarea.message-input').press('Shift+Enter')
  assert.equal(await page.locator('textarea.message-input').inputValue(), 'Newline fixture\n'); assert.equal(nativeCalls.length, modifierCalls)
  checks.push('IME modifier Enter keypress keyup and paragraph events cannot submit; Shift Enter retains newline without translation')
  await prepare('切换会话样例'); await panelHas('发送前预览')
  await page.evaluate(() => { window.oldConfirm = [...window.fixtureRoots].reverse().find(root => root.host.isConnected).querySelector('.actions button'); history.pushState({}, '', '/u/6/messages?itemId=t.fixture-other') })
  const callsBeforeChangedThread = nativeCalls.filter(call => call.op === 'authorize').length
  await page.evaluate(() => window.oldConfirm.click())
  await page.waitForFunction(() => !window.fixtureRoots.some(root => root.host.isConnected && root.textContent.includes('发送前预览')))
  assert.equal(nativeCalls.filter(call => call.op === 'authorize').length, callsBeforeChangedThread); assert.equal(dispatchData.records.length, 0)
  await page.evaluate(() => history.pushState({}, '', '/u/6/messages?itemId=t.fixture-one'))
  checks.push('conversation changed after preview prevents native authorization and send')
  await prepare('你好'); await panelHas('发送前预览'); assert.deepEqual(await page.evaluate(() => window.sent), [])
  await page.locator('textarea.message-input').fill('用户已修改草稿'); await clickPanel('确认发送'); await panelHas('草稿已变化')
  assert.equal(dispatchData.records.length, 0); checks.push('draft edit between preview and confirmation prevents reservation and send')
  lostReply = true; await prepare('新的样例'); await panelHas('fixture lost receipt')
  const preparedId = nativeCalls.filter(call => call.op === 'translate' && call.payload.direction === 'outgoing').at(-1).payload.id, costsBeforeReload = outgoing.size
  extension = new ExtensionBridge({ native, storage, runtime }); await load(); await prepare('新的样例'); await panelHas('发送前预览')
  assert.equal(incomingProviderCalls, 2); checks.push('full page and background reload preserves historical IDs and host cache prevents another provider call')
  assert.equal(nativeCalls.filter(call => call.op === 'translate' && call.payload.direction === 'outgoing').at(-1).payload.id, preparedId)
  assert.equal(outgoing.size, costsBeforeReload); checks.push('lost translation receipt plus full document/background reload reuses persistent draft ID')
  await clickPanel('确认发送'); await panelHas('已提交'); assert.deepEqual(await page.evaluate(() => window.sent), ['Hello fixture'])
  assert.equal(dispatchData.records[0].state, 'uncertain'); assert.equal(dispatchData.records[0].attempts, 1); checks.push('explicit confirmation reserves durable attempt then native button dispatches once')
  const beforeRepeat = outgoing.size; await prepare('新的样例'); await panelHas('发送结果待核对')
  assert.equal(outgoing.size, beforeRepeat); assert.equal(await page.evaluate(() => window.sent.length), 1)
  await clickPanel('已核对：确认未发送'); await panelHas('已确认未发送')
  await prepare('新的样例'); await panelHas('发送前预览'); await clickPanel('确认发送'); await panelHas('已提交')
  assert.equal(outgoing.size, beforeRepeat); assert.equal(dispatchData.records[0].attempts, 2); checks.push('uncertain same draft blocks API and replay; explicit not-sent reuse increments attempt without retranslation charge')
  await assert.rejects(extension.handle({ v: 1, type: 'voice.dispatch-resolve', payload: { conversationId: dispatchData.records[0].conversationId.replace(/^google-voice:/, ''), requestId: dispatchData.records[0].requestId, attempt: 1, outcome: 'sent', confirmed: true } }, { id: extensionId, frameId: 0, tab: { id: 99 }, url: page.url() }))
  checks.push('obsolete recovery attempt cannot clear a later durable submission')
  extension = new ExtensionBridge({ native, storage, runtime }); await load()
  const costsBeforeRecovery = outgoing.size; await prepare('新的样例'); await panelHas('发送结果待核对')
  assert.equal(outgoing.size, costsBeforeRecovery); assert.deepEqual(await page.evaluate(() => window.sent), [])
  checks.push('document and background restart recover durable uncertain attempt before translating or dispatching')
  await prepare('完全不同的草稿'); await panelHas('发送前预览'); checks.push('different draft continues while earlier message remains uncertain')
  preferences.sendAutoTranslate = false; const beforePlain = outgoing.size; await prepare('Plain English fixture'); await panelHas('原文无需翻译')
  await clickPanel('确认发送'); await panelHas('已提交'); assert.equal(outgoing.size, beforePlain); assert.equal(await page.evaluate(() => window.sent.at(-1)), 'Plain English fixture')
  checks.push('plain host-authorized text with translation disabled uses no translation API')
  const outgoingCount = () => nativeCalls.filter(call => call.op === 'authorize' || call.op === 'translate' && call.payload.direction === 'outgoing').length; const callsBeforeAttachment = outgoingCount(); await page.locator('[aria-label="Add image"]').click()
  assert.equal(await page.evaluate(() => window.addImageClicked), true); assert.equal(outgoingCount(), callsBeforeAttachment); checks.push('official image chooser remains available without translation or authorization')
  const fileEvents = await page.evaluate(() => {
    const draft = document.querySelector('textarea.message-input'), result = []
    for (const type of ['paste', 'drop']) {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.mp4', { type: 'video/mp4' }))
      const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true })
      draft.dispatchEvent(event); result.push(event.defaultPrevented)
    }
    return result
  })
  assert.deepEqual(fileEvents, [true, true]); assert.equal(outgoingCount(), callsBeforeAttachment)
  checks.push('unsupported pasted and dropped video files are blocked before official media handlers')
  await page.evaluate(() => history.pushState({}, '', '/u/6/messages'))
  await page.locator('textarea.message-input').fill('Unknown recipient'); const beforeUnknown = outgoingCount(); await page.locator('.send-button').click(); await panelHas('完整选定 1–7 位收件人')
  assert.equal(outgoingCount(), beforeUnknown); checks.push('new recipient route lacking stable conversation blocked before provider')
  await page.evaluate(() => history.pushState({}, '', '/u/6/messages?itemId=t.fixture-two'))
  const formCalls = outgoingCount()
  const submitBlocked = await page.evaluate(() => {
    const entry = document.querySelector('gv-message-entry'), form = document.createElement('form'); entry.before(form); form.append(entry)
    const event = new Event('submit', { bubbles: true, cancelable: true }); form.dispatchEvent(event); return event.defaultPrevented
  })
  assert.equal(submitBlocked, true); await panelHas('当前短信编辑器尚未识别'); assert.equal(outgoingCount(), formCalls)
  await page.evaluate(() => { const entry = document.querySelector('gv-message-entry'), form = entry.closest('form'); form.before(entry); form.remove() })
  checks.push('unexpected enclosing form submission is intercepted and rejected before provider')
  preferences.sendAutoTranslate = true; quotaDenied = true; const beforeDenied = outgoing.size; await prepare('余额不足样例'); await panelHas('fixture host rejected'); assert.equal(outgoing.size, beforeDenied)
  checks.push('quota denial preserves original draft and never sends Chinese fallback')
  assert.equal(await page.locator('textarea.message-input').inputValue(), '余额不足样例')
  assert.deepEqual(errors, []); assert.equal(JSON.stringify(values.outgoingDraftIds).includes('新的样例'), false)
  await page.screenshot({ path: fileURLToPath(new URL('voice-dom-fixture.png', output)) })
  const result = { at: new Date().toISOString(), passed: true, checks, scope: 'Offline observed Google Voice DOM-shaped fixtures through actual HelloDog main bridge, translation protocol and durable ledger with synthetic in-memory provider/wallet/storage; no real SMS, account, cloud charge or browser extension installation' }
  await writeFile(new URL('voice-dom-results.json', output), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result))
} finally { await browser.close() }
