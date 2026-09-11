import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { whatsappInjectionScript } = createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/script.ts') as typeof import('../src/main/platforms/whatsapp/inject/script')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)) }; assert.fail('UI did not settle') }
function harness(options: { wrappedReceipt?: boolean; rerender?: boolean; renamedHeader?: boolean; directionalText?: boolean; changedPeer?: boolean; delayTranslation?: boolean; receipt?: boolean; emptyComposer?: boolean; incomingError?: string; historyMode?: 'new' | 'manual' | 'visible'; incomingResult?: string; cachedIncoming?: string; previewSend?: boolean } = {}) {
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
    getRuntimeSettings: async () => ({ receiveAutoTranslate: Boolean(options.incomingError || options.historyMode), groupTranslate: true, historyMode: options.historyMode, previewSend: options.previewSend }),
    reportConversation: () => {}, reportStatus: (status: any) => statuses.push(status),
    cachedIncoming: async () => options.cachedIncoming,
    translateIncoming: async () => { incoming++; if (options.incomingResult) return options.incomingResult; throw new Error(options.incomingError || 'offline') },
    prepareSend: async (payload: any) => {
      prepared.push(payload)
      lastTask = { ...payload, id: 'send-test', state: 'draft', request: { text: payload.text }, translated: 'translation' }
      return lastTask
    },
    translateSend: async () => { await translationGate; return { ...lastTask, state: 'ready' } },
    editSendPreview: async (_id: string, text: string) => { lastTask.translated = text; return lastTask },
    cancelSend: async () => { lastTask.state = 'cancelled' },
    pendingSend: async () => lastTask && lastTask.state !== 'sent' ? lastTask : null,
    submitSend: async () => {
      submits++
      const args = { ...lastTask, original: lastTask.request.text }
      if (!win.__RT_SEND_SELECT__(args)) throw new Error('guard rejected')
      composer.textContent = lastTask.translated // Models Chromium insertText, not WhatsApp dispatch.
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
    if (options.changedPeer) win.document.querySelector('[data-id]').setAttribute('data-id', 'false_peer-b@c.us_other')
    if (options.renamedHeader) win.document.querySelector('header span').setAttribute('title', '+123456789')
    if (options.receipt !== false) {
      const el = win.document.createElement('div')
      el.className = 'message-out'; el.setAttribute('data-id', 'true_peer-a@c.us_new-' + nativeClicks)
      el.innerHTML = options.directionalText ? '<div class="selectable-text">\u200etranslation\u200f</div>' : '<span class="selectable-text">translation</span>'
      if (!options.directionalText) el.querySelector('.selectable-text').textContent = lastTask.translated
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


test('normal send progress and success never create a chat overlay or steal focus', async () => {
  const h = harness({ delayTranslation: true })
  try {
    h.composer.focus(); h.enter(); await tick()
    assert.equal(h.win.document.getElementById('rt-send-status'), null)
    assert.equal(h.win.document.activeElement, h.composer)
    h.release(); await until(() => h.statuses.some(item => item.state === 'success'))
    assert.equal(h.win.document.getElementById('rt-send-status'), null)
  } finally { h.dom.window.close() }
})

test('uncertain sends keep recovery collapsed without resending and can be expanded explicitly', async () => {
  const h = harness({ receipt: false })
  try {
    h.enter(); await until(() => h.win.document.querySelector('#rt-send-status button'))
    const box = h.win.document.getElementById('rt-send-status')
    assert.equal(box.tagName, 'DETAILS'); assert.equal(box.open, false)
    assert.equal(box.querySelectorAll('button').length, 2)
    box.querySelector('summary').click(); assert.equal(box.open, true)
    box.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(box.open, false); assert.equal(h.nativeClicks, 1)
    assert.ok(!h.statuses.some(item => item.state === 'success'))
  } finally { h.dom.window.close() }
})

test('stable peer receipts survive contact title formatting and directional display marks', async () => {
  const h = harness({ renamedHeader: true, directionalText: true, wrappedReceipt: true })
  try {
    h.enter(); await until(() => h.statuses.some(item => item.state === 'success'))
    assert.equal(h.nativeClicks, 1)
  } finally { h.dom.window.close() }
})


test('a different peer after dispatch cannot confirm an identical outgoing bubble', async () => {
  const h = harness({ changedPeer: true })
  try {
    h.enter(); await until(() => h.statuses.some(item => item.message.includes('未确认')))
    assert.equal(h.nativeClicks, 1)
    assert.ok(!h.statuses.some(item => item.state === 'success'))
  } finally { h.dom.window.close() }
})

test('failed recovery actions remain available and never dispatch a second message', async () => {
  const h = harness({ receipt: false })
  try {
    h.win.realtimeTranslator.confirmNotSent = async () => { throw new Error('暂时无法读取任务') }
    h.enter(); await until(() => h.win.document.querySelector('#rt-send-status button'))
    const box = h.win.document.getElementById('rt-send-status')
    box.querySelector('summary').click(); box.querySelector('button').click()
    await until(() => box.textContent.includes('暂时无法读取任务'))
    assert.equal(box.querySelectorAll('button:disabled').length, 0)
    assert.equal(box.open, true); assert.equal(h.nativeClicks, 1)
  } finally { h.dom.window.close() }
})


test('opening historical WhatsApp messages restores cache without paid requests', async () => {
 const h=harness({historyMode:'new',cachedIncoming:'历史译文'})
 try{await until(()=>Boolean(h.win.document.querySelector('.rt-translation')));assert.equal(h.incoming,0);assert.equal(h.win.document.querySelector('.rt-translation').textContent,'历史译文')}finally{h.dom.window.close()}
})

test('new-only mode skips initial and prepended history, translates one appended message and avoids remount repeats', async () => {
 const h=harness({historyMode:'new',incomingResult:'译文'})
 try{
  await until(()=>Boolean(h.win.document.querySelector('[data-rt-history-action]')));assert.equal(h.incoming,0)
  const main=h.win.document.querySelector('#main');const old=h.win.document.createElement('div');old.className='message-in';old.setAttribute('data-id','false_peer-a@c.us_older');old.innerHTML='<span class="selectable-text">Older text</span>';main.insertBefore(old,main.querySelector('.message-in'))
  h.intervals.forEach(fn=>fn());await until(()=>old.getAttribute('data-rt-translated')==='history');assert.equal(h.incoming,0)
  const fresh=h.win.document.createElement('div');fresh.className='message-in';fresh.setAttribute('data-id','false_peer-a@c.us_fresh');fresh.innerHTML='<span class="selectable-text">New text</span>';main.insertBefore(fresh,main.querySelector('footer'))
  h.intervals.forEach(fn=>fn());await until(()=>fresh.getAttribute('data-rt-translated')==='done');assert.equal(h.incoming,1)
  h.intervals.forEach(fn=>fn());await tick();assert.equal(h.incoming,1)
 }finally{h.dom.window.close()}
})

test('manual history action makes one translation despite repeated clicks', async () => {
 const h=harness({historyMode:'manual',incomingResult:'手动译文'})
 try{await until(()=>Boolean(h.win.document.querySelector('[data-rt-history-action]')));const button=h.win.document.querySelector('[data-rt-history-action]');button.click();button.click();await until(()=>Boolean(h.win.document.querySelector('.rt-translation')));assert.equal(h.incoming,1)}finally{h.dom.window.close()}
})


test('optional preview waits for explicit send, edits the existing task and dispatches once', async () => {
 const h=harness({previewSend:true})
 try{h.enter();await until(()=>Boolean(h.win.document.querySelector('[data-rt-ui="send-preview"]')));assert.equal(h.nativeClicks,0)
 const panel=h.win.document.querySelector('[data-rt-ui="send-preview"]');const translated=panel.querySelector('textarea[aria-label="可编辑译文"]');translated.value='reviewed text';panel.querySelector('button').click()
 await until(()=>h.statuses.some(s=>s.state==='success'));assert.equal(h.nativeClicks,1);assert.equal(h.prepared.length,1);const sent=h.win.document.querySelector('.message-out .selectable-text').cloneNode(true);sent.querySelectorAll('[data-rt-ui], .rt-translation').forEach((node:any)=>node.remove());assert.equal(sent.textContent,'reviewed text')
 }finally{h.dom.window.close()}
})

test('cancelling optional preview preserves the original composer without dispatch', async () => {
 const h=harness({previewSend:true})
 try{h.enter();await until(()=>Boolean(h.win.document.querySelector('[data-rt-ui="send-preview"]')))
 h.win.document.querySelectorAll('[data-rt-ui="send-preview"] button')[1].click();await until(()=>h.statuses.some(s=>s.message.includes('已取消发送')));assert.equal(h.nativeClicks,0);assert.equal(h.composer.textContent,'原文')
 }finally{h.dom.window.close()}
})
