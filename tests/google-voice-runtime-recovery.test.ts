import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { JSDOM } from 'jsdom'

const modules = ['protocol.mjs', 'send-guard.mjs', 'voice-adapter.mjs', 'content-runtime.js'].map(file =>
  readFileSync(new URL('../integrations/google-voice-extension/' + file, import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
).join('\n')
const until = async (check: () => boolean) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('Google Voice runtime did not settle') }

function fixture(translate: (request: any, attempt: number) => Promise<any>, shortTimeout = false) {
  const dom = new JSDOM(`<gv-thread-details><gv-message-list><gv-message-item>
    <div class="full-container incoming"><div class="message-row"><gv-annotation class="content"><span>Hello there.</span></gv-annotation></div>
    <div class="status">2:01 PM</div><span class="cdk-visually-hidden">Message from Synthetic sender, Hello there., Sunday, September 20 2026, 2:01 PM.</span></div>
    </gv-message-item></gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea>
    <gv-message-actions><button aria-label="Add image">Add image</button></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></gv-message-entry></gv-thread-details>`,
    { url: 'https://voice.google.com/u/0/messages?itemId=t.synthetic-recovery', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window as any, calls: any[] = [], operations: string[] = [], intervals: Function[] = []
  let time = Date.now(), online = true, sent = 0
  Object.defineProperty(w, 'crypto', { value: webcrypto })
  Object.defineProperty(w.navigator, 'onLine', { get: () => online })
  w.TextEncoder = TextEncoder; w.Date.now = () => time
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 400, height: 100, top: 0, left: 0, bottom: 100, right: 400 })
  w.HTMLElement.prototype.getClientRects = () => [{ width: 400, height: 100, top: 0, left: 0, bottom: 100, right: 400 }]
  w.setInterval = (fn: Function) => { intervals.push(fn); return intervals.length }; w.clearInterval = () => {}
  const timeout = w.setTimeout.bind(w)
  w.setTimeout = (fn: Function, ms: number) => timeout(fn, ms === 250 ? 0 : shortTimeout && ms === 75000 ? 25 : ms)
  w.document.querySelector('.send-button').addEventListener('click', () => { sent++ })
  w.fixtureBridge = async (request: any) => {
    operations.push(request.type)
    if (request.type === 'voice.status') return { ok: true, result: { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, historyMode: 'visible', translationsVisible: true } }
    assert.equal(request.type, 'voice.translate'); assert.equal(request.payload.direction, 'incoming')
    calls.push(structuredClone(request.payload)); return translate(request.payload, calls.length)
  }
  w.eval(`(() => {${modules}\nwindow.fixtureRuntime = installGoogleVoiceRuntime({sendRequest: message => window.fixtureBridge(message)});})()`)
  return { dom, w, calls, operations, get sent() { return sent }, advance(ms: number) { time += ms; intervals.forEach(fn => fn()) },
    setOnline(value: boolean) { online = value; w.dispatchEvent(new w.Event(value ? 'online' : 'offline')) },
    annotation: () => w.document.querySelector('[data-hellodog-voice="translation"]'),
    close() { w.fixtureRuntime.dispose(); dom.window.close() } }
}
const success = { ok: true, result: { enabled: true, text: '你好。', requestId: 'gv-synthetic-recovery' } }

test('Google Voice automatically recovers a transient translation failure under the same message ID without sending', async () => {
  const h = fixture(async (_request, attempt) => attempt === 1 ? { ok: false, code: 'unavailable', error: 'Temporarily unavailable' } : success)
  try {
    await until(() => h.calls.length === 1 && h.annotation()?.querySelector('button')?.textContent === '等待翻译')
    h.advance(4000); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(h.calls.length, 1)
    h.advance(6000); await until(() => h.annotation()?.textContent === '你好。')
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].id, h.calls[1].id); assert.equal(h.calls[0].conversationId, h.calls[1].conversationId)
    assert.equal(h.sent, 0); assert.ok(h.operations.every(value => ['voice.status', 'voice.translate'].includes(value)))
  } finally { h.close() }
})

test('Google Voice lost IPC reply releases the scan; a late reply cannot overwrite the recovered result', async () => {
  let late: (value: any) => void = () => {}
  const h = fixture(async (_request, attempt) => attempt === 1 ? new Promise(resolve => { late = resolve }) : success, true)
  try {
    await until(() => h.annotation()?.querySelector('button')?.textContent === '等待翻译')
    h.advance(10000); await until(() => h.annotation()?.textContent === '你好。')
    late({ ok: true, result: { enabled: true, text: 'Late stale result', requestId: 'gv-synthetic-recovery' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(h.annotation()?.textContent, '你好。'); assert.equal(h.calls.length, 2); assert.equal(h.calls[0].id, h.calls[1].id); assert.equal(h.sent, 0)
  } finally { h.close() }
})

test('Google Voice retries are bounded during an outage and resume a stationary message after cooldown', async () => {
  const h = fixture(async (_request, attempt) => attempt <= 3 ? { ok: false, code: 'unavailable', error: 'Unavailable' } : success)
  try {
    await until(() => h.calls.length === 1 && h.annotation()?.querySelector('button')?.textContent === '等待翻译')
    h.advance(10000); await until(() => h.calls.length === 2 && h.annotation()?.querySelector('button')?.textContent === '等待翻译')
    h.advance(10000); await until(() => h.calls.length === 3 && h.annotation()?.querySelector('button')?.textContent === '重试翻译')
    for (let i = 0; i < 4; i++) { h.setOnline(true); h.advance(10000); await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.equal(h.calls.length, 3)
    h.advance(300000); await until(() => h.annotation()?.textContent === '你好。'); assert.equal(h.calls.length, 4)
    assert.equal(new Set(h.calls.map(value => value.id)).size, 1); assert.equal(h.sent, 0)
  } finally { h.close() }
})

test('Google Voice login, balance, account and invalid errors never loop automatically', async () => {
  for (const code of ['login', 'balance', 'account', 'disabled', 'invalid']) {
    const h = fixture(async () => ({ ok: false, code, error: 'Requires user action' }))
    try {
      await until(() => h.annotation()?.querySelector('button')?.textContent === '重试翻译')
      h.advance(600000); h.setOnline(true); await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(h.calls.length, 1); assert.equal(h.sent, 0)
    } finally { h.close() }
  }
})

test('Google Voice offline pauses retries and online resumes the same incoming message after cooldown', async () => {
  const h = fixture(async (_request, attempt) => attempt === 1 ? { ok: false, code: 'unavailable' } : success)
  try {
    await until(() => h.annotation()?.querySelector('button')?.textContent === '等待翻译')
    h.setOnline(false); h.advance(10000); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(h.calls.length, 1)
    h.setOnline(true); await until(() => h.annotation()?.textContent === '你好。'); assert.equal(h.calls.length, 2); assert.equal(h.sent, 0)
  } finally { h.close() }
})
