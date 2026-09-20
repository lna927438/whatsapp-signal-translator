const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const output = process.argv[2], runId = process.argv[3]
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-new-history-'))
app.on('window-all-closed', () => {})
const { GoogleVoiceEmbeddedTranslation, GoogleVoiceDispatchLedger, createGoogleVoiceTranslator } = require(join(output, 'main.cjs'))
let now = new Date(2026, 8, 20, 12, 1, 30).getTime(), mode = 'new', busyStatus = false
Date.now = () => now
const checks = [], calls = [], charged = [], windows = [], rows = new Map(), errors = [], receipts = new Map()
let drafts = { records: {} }, journal = { records: [] }
const translator = {
  history: async () => [], preserveIncomingRequest: async request => request, preserveOutgoingRequest: async request => request, prepareOutgoingRequest: async request => request,
  cached: async request => receipts.get(request.requestId),
  translateIncoming: async request => { assert.ok(!receipts.has(request.requestId), 'Duplicate billable request'); charged.push(request); const text = '合成译文：' + request.text; receipts.set(request.requestId, text); return text },
  translate: async () => { throw new Error('No outgoing translation expected') }, existingOutgoing: async () => { throw new Error('No sends allowed') }
}
const ledger = new GoogleVoiceDispatchLedger({ read: async () => journal, write: async value => { journal = value } })
const handler = createGoogleVoiceTranslator(translator, { check: async () => {} }, async () => ({ localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, translationsVisible: true, historyMode: mode }), ledger)
const bridge = new GoogleVoiceEmbeddedTranslation({ storage: { read: async () => drafts, write: async value => { drafts = value } }, translate: handler, trustedPage: event => {
  const row = rows.get(event.sender.id), url = event.sender.getURL(), epoch = row?.epoch
  if (!row || event.senderFrame !== event.sender.mainFrame) throw new Error('Synthetic page not registered')
  return { owner: 'synthetic-owner', accountId: row.id, url, authorized: () => !event.sender.isDestroyed() && row.epoch === epoch && event.sender.getURL() === url }
} })
ipcMain.handle('google-voice:translate-request', async (event, request) => {
  calls.push(request)
  if (request.type === 'voice.status' && busyStatus) return { ok: false, code: 'busy', error: 'Synthetic busy' }
  return bridge.request(event, request)
})
ipcMain.handle('google-voice:unread', () => ({ ok: true }))
const stamp = minute => `Sunday, September 20 2026, 12:${String(minute).padStart(2, '0')} PM.`
const message = (id, text, minute, extra = '') => `<gv-message-item id="${id}" ${extra}><div class="full-container incoming"><div class="message-row"><gv-annotation class="content">${text}</gv-annotation></div><div class="status">12:${String(minute).padStart(2, '0')} PM</div><span class="cdk-visually-hidden">Message from Synthetic sender, ${text}, ${stamp(minute)}</span></div></gv-message-item>`
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px Arial;padding:20px}gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}gv-message-item{padding:5px}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}textarea{width:500px;height:60px}</style><gv-thread-details><gv-message-list>${message('baseline', 'Initial history', 0)}</gv-message-list><gv-message-entry><div class="root"><div class="container"><div class="message-input-container"><textarea class="message-input" placeholder="Type a message" aria-readonly="false"></textarea></div><gv-message-actions><button aria-label="Add image">Add image</button><input type="file" style="display:none"></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></div></div></gv-message-entry></gv-thread-details><script>globalThis.sent=0;document.querySelector('textarea').addEventListener('input',()=>document.querySelector('.send-button').disabled=false);document.querySelector('.send-button').onclick=()=>sent++</script>`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) { for (let i = 0; i < 120; i++) { if (await check()) return; await pause(50) } throw new Error('Timed out: ' + label) }
const page = (window, script) => window.webContents.executeJavaScript(script)
const isolated = (window, script) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: script }])
async function advance(window, minute, seconds = 1) { now = new Date(2026, 8, 20, 12, minute, seconds).getTime(); await isolated(window, `globalThis.__fixtureNow=${now}`); await page(window, `window.dispatchEvent(new Event('scroll'))`) }
async function append(window, id, text, minute, extra) { await page(window, `document.querySelector('gv-message-list').insertAdjacentHTML('beforeend',${JSON.stringify(message(id, text, minute, extra))})`) }
async function newWindow() {
  const part = session.fromPartition('new-history-fixture-' + randomUUID())
  part.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { session: part, preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  windows.push(window); const row = { id: 'gv-' + randomUUID(), epoch: 0 }; rows.set(window.webContents.id, row)
  window.webContents.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) row.epoch++ })
  window.webContents.on('preload-error', (_e, _path, error) => errors.push(error.message))
  window.webContents.on('paint', () => {}); window.webContents.setFrameRate(60); window.webContents.startPainting()
  await window.loadURL('https://voice.google.com/u/0/messages?itemId=t.fixture')
  await isolated(window, `globalThis.__fixtureNow=${now}`)
  await until(async () => await page(window, `!!document.querySelector('[data-hellodog-voice="translation"]')`), 'initial adapter view')
  await pause(500); return window
}
app.whenReady().then(async () => {
  let window = await newWindow()
  assert.equal(charged.length, 0); assert.ok(calls.some(call => call.type === 'voice.history-baseline'))
  checks.push('Real sandboxed preload and main bridge establish first-batch baseline without translation or charge')
  await append(window, 'late-history', 'Delayed initial history', 0); await append(window, 'same-minute', 'Ambiguous baseline minute', 1); await pause(1100)
  assert.equal(charged.length, 0)
  checks.push('Asynchronous historical append and same-minute timestamp stay manual')
  await advance(window, 2); await append(window, 'live', 'Live incoming SMS', 2)
  await until(() => charged.length === 1, 'new incoming automatically translated')
  await until(async () => (await page(window, `document.querySelector('#live [data-hellodog-voice="translation"]')?.textContent`)) === '合成译文：Live incoming SMS', 'translation inside bubble')
  checks.push('Fresh timestamp and live append translate exactly once inside the official bubble')
  await page(window, `document.querySelector('#live').outerHTML=${JSON.stringify(message('live', 'Live incoming SMS', 2))}`)
  await append(window, 'duplicate-live', 'Live incoming SMS', 2)
  await pause(800); assert.equal(charged.length, 1)
  await advance(window, 3)
  await page(window, `document.querySelector('#late-history').innerHTML=${JSON.stringify(message('unused', 'Recycled DOM text', 3).replace(/^<gv-message-item[^>]*>|<\/gv-message-item>$/g, ''))}`)
  await pause(700); assert.equal(charged.length, 1)
  checks.push('Redraw, same-signature duplicates and recycled historical DOM never add a charge')
  await advance(window, 4)
  await page(window, `document.querySelector('gv-message-list').insertAdjacentHTML('afterbegin',${JSON.stringify(message('paged', 'Older paged history', 0))})`)
  await append(window, 'next-live', 'Live after history pagination', 4)
  await until(() => charged.length === 2, 'new message alongside prepend')
  assert.ok(!charged.some(row => row.text === 'Older paged history'))
  checks.push('One mutation batch with older prepended history and a new appended SMS charges only the new SMS')
  await page(window, `(()=>{const input=document.querySelector('textarea');input.value='Hello how are you?';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`)
  await until(async () => await isolated(window, `__fixtureRoots.some(root=>root.host.isConnected&&root.textContent.includes('原文无需翻译'))`), 'outgoing preview')
  await advance(window, 5); await append(window, 'during-one', 'Received during preview one', 5); await append(window, 'during-two', 'Received during preview two', 5)
  await pause(700); assert.equal(charged.length, 2)
  await isolated(window, `(()=>{const root=__fixtureRoots.find(root=>root.host.isConnected);[...root.querySelectorAll('button')].find(button=>button.textContent==='关闭').click()})()`)
  await until(() => charged.length === 4, 'preview close resumes each incoming exactly once')
  await pause(600); assert.equal(charged.length, 4); assert.equal(await page(window, 'sent'), 0)
  checks.push('Closing a preview resumes two pending incoming IDs once each without sending or duplicate charging')
  busyStatus = true; await advance(window, 6); await pause(500)
  assert.ok((await page(window, `document.querySelector('[data-hellodog-voice="toolbar"]').textContent`)).includes('文字翻译成功扣字符'))
  await append(window, 'after-busy', 'Incoming while transport busy', 6); await pause(500); assert.equal(charged.length, 4)
  busyStatus = false; await advance(window, 6, 3); await pause(500); await page(window, `window.dispatchEvent(new Event('scroll'))`)
  await until(() => charged.length === 5, 'busy recovery')
  checks.push('Transient busy preserves verified connection display and defers automatic work until fresh status')
  mode = 'manual'; await advance(window, 7); await append(window, 'manual', 'Manual-only message', 7); await pause(800); assert.equal(charged.length, 5)
  await page(window, `document.querySelector('#manual [data-hellodog-voice="translation"] button').click()`)
  await until(() => charged.length === 6, 'manual action works')
  mode = 'new'; await advance(window, 8); await append(window, 'mode-history', 'History loaded at mode switch', 8); await pause(800); assert.equal(charged.length, 6)
  await advance(window, 9); await append(window, 'after-mode', 'Incoming after new baseline', 9); await until(() => charged.length === 7, 'new baseline after mode change')
  checks.push('Manual mode never auto charges; returning to new mode rebases existing content before later new SMS')
  const beforeNavigation = charged.length
  await page(window, `history.pushState({},'', '/u/0/messages?itemId=t.other');document.querySelector('gv-message-list').innerHTML=${JSON.stringify(message('other-history', 'Other conversation history', 9))}`)
  await pause(1000); assert.equal(charged.length, beforeNavigation)
  await advance(window, 10); await append(window, 'other-new', 'Other conversation live SMS', 10); await until(() => charged.length === beforeNavigation + 1, 'new conversation')
  checks.push('Conversation navigation retires the old baseline and never auto translates the new initial history')
  window.destroy(); mode = 'visible'; window = await newWindow()
  await until(() => charged.length === beforeNavigation + 2, 'visible history')
  const beforeOffscreen = charged.length
  await append(window, 'offscreen', 'Offscreen visible-mode history', 0, 'style="position:absolute;top:4000px"')
  await pause(700); assert.equal(charged.length, beforeOffscreen)
  await page(window, `document.querySelector('#offscreen').style.position='static';document.querySelector('#offscreen').style.top=''`)
  await until(() => charged.length === beforeOffscreen + 1, 'history becomes visible')
  checks.push('Visible-history mode translates only rendered messages intersecting the viewport')
  assert.deepEqual(errors, []); assert.equal(await page(window, 'sent'), 0); assert.equal(journal.records.length, 0)
  writeFileSync(join(output, 'fixture.json'), JSON.stringify({ runId, passed: true, checks, actualPreload: true, actualMainBridge: true, actualAdapter: true, simulatedProviderCalls: charged.length, uniqueRequests: new Set(charged.map(row => row.requestId)).size, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false, at: new Date().toISOString() }, null, 2))
  app.exit(0)
}).catch(async error => {
  console.error(error.stack)
  const state = await Promise.all(windows.filter(window => !window.isDestroyed()).map(window => page(window, 'document.body.innerText').catch(() => 'unavailable')))
  console.error(JSON.stringify({ calls: calls.map(call => ({ type: call.type, text: call.payload?.text })), charged: charged.map(row => row.text), state }))
  writeFileSync(join(output, 'fixture.json'), JSON.stringify({ runId, passed: false, checks, error: error.message }, null, 2)); app.exit(1)
})
