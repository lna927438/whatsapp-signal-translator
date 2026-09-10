import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { whatsappInjectionScript } = createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/script.ts') as typeof import('../src/main/platforms/whatsapp/inject/script')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)) }; assert.fail('UI did not settle') }
function harness(options: { wrappedReceipt?: boolean; rerender?: boolean; delayTranslation?: boolean; receipt?: boolean; emptyComposer?: boolean; incomingError?: string } = {}) {
  const dom = new JSDOM('<div id="sidebar">other chat</div><div id="main"><header><span title="Alex" dir="auto">Alex</span></header><div class="message-in" data-id="false_peer-a@c.us_old"><span class="selectable-text">hello</span></div><footer><div contenteditable="true" role="textbox">原文</div><button aria-label="Send">send</button></footer></div>', { url: 'https://web.whatsapp.com', runScripts: 'outside-only' })
  const win = dom.window as any
  const composer = win.document.querySelector('[contenteditable]')
  const button = win.document.querySelector('button')
  const statuses: any[] = [], prepared: any[] = []
  let submits = 0, nativeClicks = 0, incoming = 0, releaseTranslation!: () => void, lastTask: any
  const translationGate = options.delayTranslation ? new Promise<void>(resolve => { releaseTranslation = resolve }) : Promise.resolve()
  const intervals: Array<() => void> = []
  win.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length }
  const originalTimeout = win.setTimeout.bind(win)
  win.setTimeout = (fn: () => void, delay: number) => originalTimeout(fn, delay === 100 ? 0 : delay)
  win.realtimeTranslator = {
    getRuntimeSettings: async () => ({ receiveAutoTranslate: Boolean(options.incomingError), groupTranslate: true }),
    reportConversation: () => {}, reportStatus: (status: any) => statuses.push(status),
    translateIncoming: async () => { incoming++; throw new Error(options.incomingError || 'offline') },
    prepareSend: async (payload: any) => {
      prepared.push(payload)
      lastTask = { ...payload, id: 'send-test', state: 'draft', request: { text: payload.text }, translated: 'translation' }
      return lastTask
    },
    translateSend: async () => { await translationGate; return { ...lastTask, state: 'ready' } },
    pendingSend: async () => lastTask && lastTask.state !== 'sent' ? lastTask : null,
    submitSend: async () => {
      submits++
      const args = { ...lastTask, original: lastTask.request.text }
      if (!win.__RT_SEND_SELECT__(args)) throw new Error('guard rejected')
      composer.textContent = 'translation' // Models Chromium insertText, not WhatsApp dispatch.
      const result = await win.__RT_SEND_COMMIT__(args)
      win.__RT_SEND_RELEASE__(lastTask.id, result.dispatched === false)
      if (!result.confirmed) { lastTask.state = 'uncertain'; throw new Error('发送结果未确认') }
      lastTask.state = 'sent'
      return lastTask
    }
  }
  button.addEventListener('click', () => {
    nativeClicks++
    if (options.emptyComposer !== false) composer.textContent = ''
    if (options.receipt !== false) {
      const el = win.document.createElement('div')
      el.className = 'message-out'; el.setAttribute('data-id', 'true_peer-a@c.us_new-' + nativeClicks)
      el.innerHTML = '<span class="selectable-text">translation</span>'
      let receipt = el
      if (options.wrappedReceipt) {
        receipt = win.document.createElement('div'); receipt.setAttribute('data-id', el.getAttribute('data-id'))
        el.removeAttribute('data-id'); receipt.appendChild(el)
      }
      win.document.querySelector('#main').insertBefore(receipt, win.document.querySelector('footer'))
      if (options.rerender) {
        const header = win.document.querySelector('#main header'); header.replaceWith(header.cloneNode(true))
        composer.replaceWith(composer.cloneNode(true))
      }
    }
  })
  win.eval(whatsappInjectionScript)
  const enter = () => composer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return { win, dom, composer, enter, statuses, prepared, intervals, release: () => releaseTranslation(), get submits() { return submits }, get nativeClicks() { return nativeClicks }, get incoming() { return incoming } }
}

test('WhatsApp repeated Enter becomes one guarded submission and requires a new outgoing bubble', async () => {
  const h = harness({ delayTranslation: true })
  try {
    h.enter(); h.enter(); h.enter()
    await tick(); assert.equal(h.prepared.length, 1)
    h.release()
    await until(() => h.statuses.some(item => item.state === 'success'))
    assert.equal(h.submits, 1); assert.equal(h.nativeClicks, 1)
  } finally { h.dom.window.close() }
})

test('WhatsApp translation display controls update existing messages without replacing or resending them', () => {
  const h = harness()
  try {
    const node = h.win.document.createElement('span')
    node.className = 'rt-translation'; node.textContent = '保留这条译文'
    h.win.document.querySelector('.message-in').appendChild(node)
    h.win.__RT_APPLY_SETTINGS__({ fontSize: 18, translationColor: '#336633', translationsVisible: false })
    assert.equal(node.style.display, 'none'); assert.equal(node.style.fontSize, '18px')
    h.win.__RT_APPLY_SETTINGS__({ fontSize: 14, translationColor: '#336633', translationsVisible: true })
    assert.equal(node.style.display, 'block'); assert.equal(node.textContent, '保留这条译文')
    assert.equal(h.nativeClicks, 0); assert.equal(h.incoming, 0)
  } finally { h.dom.window.close() }
})

test('WhatsApp switching to a same-name chat while translating does not send or overwrite its draft', async () => {
  const h = harness({ delayTranslation: true })
  try {
    h.enter(); await tick()
    h.win.document.querySelector('#sidebar').dispatchEvent(new h.win.MouseEvent('pointerdown', { bubbles: true }))
    h.win.document.querySelector('[data-id]').setAttribute('data-id', 'false_peer-b@c.us_other')
    h.composer.textContent = 'draft for different Alex'
    h.release()
    await until(() => h.statuses.some(item => item.state === 'error'))
    assert.equal(h.submits, 0); assert.equal(h.nativeClicks, 0)
    assert.equal(h.composer.textContent, 'draft for different Alex')
    assert.equal(h.prepared[0].text, '原文')
  } finally { h.dom.window.close() }
})

test('WhatsApp a newer draft written during translation stays intact and is not sent', async () => {
  const h = harness({ delayTranslation: true })
  try {
    h.enter(); await tick(); h.composer.textContent = 'new work'; h.release()
    await until(() => h.statuses.some(item => item.state === 'error'))
    assert.equal(h.submits, 0); assert.equal(h.composer.textContent, 'new work')
  } finally { h.dom.window.close() }
})

test('WhatsApp an empty composer without a new receipt is uncertain, never reported as success', async () => {
  const h = harness({ receipt: false })
  try {
    h.enter()
    await until(() => h.statuses.some(item => item.message.includes('未确认')))
    assert.equal(h.nativeClicks, 1)
    assert.ok(!h.statuses.some(item => item.state === 'success'))
  } finally { h.dom.window.close() }
})

test('WhatsApp an existing identical bubble cannot serve as a new send receipt', async () => {
  const h = harness({ receipt: false })
  try {
    const old = h.win.document.createElement('div')
    old.className = 'message-out'; old.setAttribute('data-id', 'true_peer-a@c.us_old-send'); old.innerHTML = '<span class="selectable-text">translation</span>'
    h.win.document.querySelector('#main').appendChild(old)
    h.enter()
    await until(() => h.statuses.some(item => item.message.includes('未确认')))
    assert.ok(!h.statuses.some(item => item.state === 'success'))
  } finally { h.dom.window.close() }
})

test('WhatsApp account-disabled errors pause automatic incoming translation instead of polling repeatedly', async () => {
  const h = harness({ incomingError: '账号已停用，无法使用在线翻译。' })
  try {
    await until(() => h.incoming === 1)
    await tick()
    for (let n = 0; n < 5; n++) { h.intervals.forEach(fn => fn()); await tick() }
    assert.equal(h.incoming, 1)
  } finally { h.dom.window.close() }
})


test('WhatsApp recognizes IDs on an ancestor and accepts same-peer React rerenders after dispatch', async () => {
  const h = harness({ wrappedReceipt: true, rerender: true })
  try {
    h.enter()
    await until(() => h.statuses.some(item => item.state === 'success'))
    assert.equal(h.submits, 1); assert.equal(h.nativeClicks, 1)
  } finally { h.dom.window.close() }
})
