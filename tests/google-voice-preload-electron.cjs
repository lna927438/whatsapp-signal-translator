const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const output = process.argv[2], profile = mkdtempSync('D:/UserAppData/Temp/hellodog-voice-preload-')
app.setPath('userData', profile)
const calls = [], checks = [], failures = [], windows = []
let deny = false, pendingAuthorize, delayAuthorize = false, delayTranslation = false, pendingTranslation, deferIncoming = false
const html = `<!doctype html><meta charset="utf-8"><style>gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}body{font:15px Arial;padding:20px}textarea{width:600px;height:90px}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><gv-thread-details><gv-message-list><gv-message-item><div class="full-container incoming"><div class="message-row"><gv-annotation class="content">A synthetic received SMS</gv-annotation></div><div class="status">2:36 AM</div><span class="cdk-visually-hidden">Message from Synthetic sender, A synthetic received SMS, Sunday, September 20 2026, 2:36 AM.</span></div></gv-message-item></gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea><gv-message-actions><button aria-label="Add image">Add image</button></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></gv-message-entry></gv-thread-details><script>window.sent=[];const input=document.querySelector('textarea'),button=document.querySelector('.send-button');input.addEventListener('input',()=>button.disabled=!input.value);button.addEventListener('click',()=>{window.sent.push(input.value);input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))});</script>`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50) } throw new Error('Timed out: ' + label) }
function page(window, script) { return window.webContents.executeJavaScript(script) }
function isolated(window, script) { return window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: script }]) }
function panel(window, text) { return isolated(window, `globalThis.__fixtureRoots.some(root=>root.host.isConnected && root.textContent.includes(${JSON.stringify(text)}))`) }
function click(window, label) { return isolated(window, `(()=>{const root=[...globalThis.__fixtureRoots].reverse().find(root=>root.host.isConnected);const button=[...root.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Missing fixture button');button.click()})()`) }
async function draft(window, value) { await page(window, `(()=>{const input=document.querySelector('textarea.message-input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`); }
async function newWindow(url) {
  const isolatedSession = session.fromPartition('fixture-' + randomUUID())
  // Every HTTPS request is answered by a synthetic local document.
  isolatedSession.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { session: isolatedSession, preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  windows.push(window)
  window.webContents.on('preload-error', (_e, _path, error) => failures.push(error.message))
  await window.loadURL(url); return window
}
ipcMain.handle('google-voice:translate-request', async (_event, request) => {
  calls.push(request)
  const payload = request.payload
  if (request.type === 'voice.status') return { ok: true, result: { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', historyMode: 'visible', receiveAutoTranslate: true, translationsVisible: true } }
  if (request.type === 'voice.outgoing-id') return { ok: true, result: { id: '12345678-1234-4123-8123-123456789012' } }
  if (request.type === 'voice.dispatch-status') return { ok: true, result: { state: 'clear' } }
  if (request.type === 'voice.translate') {
    if (payload.direction === 'incoming' && deferIncoming) return { ok: true, result: { enabled: false, manual: true } }
    if (payload.direction === 'outgoing' && delayTranslation) { delayTranslation = false; await new Promise(resolve => { pendingTranslation = resolve }) }
    return { ok: true, result: { enabled: true, text: payload.direction === 'incoming' ? '仅用于测试的接收译文' : 'Hello synthetic fixture', requestId: 'fixture-' + payload.id } }
  }
  if (request.type === 'voice.authorize') {
    if (delayAuthorize) { delayAuthorize = false; await new Promise(resolve => { pendingAuthorize = resolve }) }
    return deny ? { ok: false, error: '余额不足，原文已保留。', code: 'quota' } : { ok: true, result: { authorized: true, requestId: payload.requestId, attempt: 1 } }
  }
  throw new Error('Unexpected fixture operation')
})
app.whenReady().then(async () => {
  const authPages = await Promise.all(['accounts.google.com', 'accounts.google.co.th', 'accounts.google.co.uk'].map(host => newWindow('https://' + host + '/fixture')))
  await pause(1200)
  assert.equal(calls.length, 0)
  for (const auth of authPages) assert.equal(await page(auth, `document.querySelectorAll('[data-hellodog-voice]').length`), 0)
  checks.push('Global and regional Accounts origins cause no translation IPC or injected UI')
  const window = await newWindow('https://voice.google.com/u/0/messages?itemId=t.fixture-one')
  await until(async () => (await page(window, `document.querySelector('[data-hellodog-voice="translation"]')?.textContent`)) === '仅用于测试的接收译文', 'incoming translation')
  checks.push('Sandboxed isolated preload translates rendered incoming history through IPC')
  assert.equal(await page(window, `typeof require+':'+typeof ipcRenderer+':'+typeof realtimeTranslator+':'+typeof __fixtureRoots`), 'undefined:undefined:undefined:undefined')
  checks.push('Official page world cannot access IPC, Node or the isolated preload runtime')
  await draft(window, '你好'); await until(() => panel(window, '发送前预览'), 'preview')
  assert.equal(await page(window, 'sent.length'), 0)
  deny = true; await click(window, '确认发送'); await until(() => panel(window, '尚未完成'), 'quota error')
  assert.equal(await page(window, 'sent.length'), 0); assert.equal(await page(window, `document.querySelector('textarea').value`), '你好')
  checks.push('Preview is explicit and quota denial retains Chinese draft without dispatch')
  deny = false; await draft(window, '第二条'); await until(() => panel(window, '发送前预览'), 'second preview')
  await isolated(window, `globalThis.__oldConfirm=[...globalThis.__fixtureRoots].reverse().find(root=>root.host.isConnected).querySelector('.actions button')`)
  const before = calls.filter(call => call.type === 'voice.authorize').length
  window.webContents.send('google-voice:context-changed'); await pause(100)
  await isolated(window, '__oldConfirm.click()'); await pause(100)
  assert.equal(calls.filter(call => call.type === 'voice.authorize').length, before); assert.equal(await page(window, 'sent.length'), 0)
  checks.push('Context event invalidates even a retained stale confirmation button')
  await draft(window, '第三条'); await until(() => panel(window, '发送前预览'), 'third preview')
  delayAuthorize = true; await click(window, '确认发送'); await until(() => !!pendingAuthorize, 'authorization started')
  window.webContents.send('google-voice:context-changed'); await pause(80); pendingAuthorize(); pendingAuthorize = null; await pause(120)
  assert.equal(await page(window, 'sent.length'), 0); assert.equal(await page(window, `document.querySelector('textarea').value`), '第三条')
  checks.push('Context changes during authorization prevent replacement and dispatch')
  await draft(window, '第四条'); await until(() => panel(window, '发送前预览'), 'fourth preview')
  await click(window, '确认发送'); await until(async () => await page(window, 'sent.length') === 1, 'one synthetic send')
  assert.equal(await page(window, 'sent[0]'), 'Hello synthetic fixture')
  checks.push('Successful confirmation clicks the exact synthetic send button once')
  delayTranslation = true; await draft(window, '第五条'); await until(() => !!pendingTranslation, 'translation started')
  await page(window, `history.pushState({},'', '/u/1/messages?itemId=t.fixture-other')`)
  await pause(100); pendingTranslation(); pendingTranslation = null; await pause(300)
  assert.equal(await page(window, 'sent.length'), 1); assert.equal(await panel(window, '发送前预览'), false)
  checks.push('SPA account/navigation change discards delayed old translation and preview')
  await page(window, `dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`)
  await draft(window, '恢复页面草稿'); await until(() => panel(window, '发送前预览'), 'restored page guard')
  assert.equal(await page(window, 'sent.length'), 1)
  checks.push('Persisted page restoration reinstalls the guard and still blocks unconfirmed sends')
  await page(window, `dispatchEvent(new PageTransitionEvent('pagehide'))`)
  assert.equal(await page(window, `document.querySelectorAll('[data-hellodog-voice]').length`), 0)
  const afterDispose = calls.length; await pause(1300); assert.equal(calls.length, afterDispose)
  checks.push('Page disposal removes UI, subscriptions, observers and polling')
  deferIncoming = true
  const incomingCount = () => calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'incoming').length
  const beforeDeferred = incomingCount(), deferredWindow = await newWindow('https://voice.google.com/u/0/messages?itemId=t.fixture-deferred')
  await until(() => incomingCount() > beforeDeferred, 'normal deferred receipt')
  for (let i = 0; i < 3; i++) { await page(deferredWindow, `document.body.append(document.createElement('span'))`); await pause(300) }
  await pause(2300); assert.equal(incomingCount(), beforeDeferred + 1)
  assert.equal(await page(deferredWindow, `document.querySelector('[data-hellodog-voice="translation"]')?.textContent`), '翻译')
  assert.equal(await panel(deferredWindow, '尚未完成'), false)
  checks.push('Normal disabled/cache-miss receipt stays non-error and pauses automatic polling')
  deferIncoming = false
  await page(deferredWindow, `document.querySelector('[data-hellodog-voice="translation"] button').click()`)
  await until(async () => (await page(deferredWindow, `document.querySelector('[data-hellodog-voice="translation"]')?.textContent`)) === '仅用于测试的接收译文', 'manual resume')
  assert.equal(incomingCount(), beforeDeferred + 2)
  assert.equal(calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'incoming').at(-1).payload.manual, true)
  checks.push('Explicit manual translation resumes a deferred message once')
  assert.deepEqual(failures, [])
  writeFileSync(join(output, 'preload-fixture.json'), JSON.stringify({ at: new Date().toISOString(), electron: process.versions.electron, passed: true, checks, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false }, null, 2))
  app.exit(0)
}).catch(async error => {
  console.error(error.stack)
  const fixturePanels = await Promise.all(windows.filter(window => !window.isDestroyed()).map(window => isolated(window, `globalThis.__fixtureRoots.filter(root=>root.host.isConnected).map(root=>({text:root.textContent,value:root.querySelector('textarea')?.value}))`).catch(() => [])))
  console.error(JSON.stringify({ fixturePanels }))
  writeFileSync(join(output, 'preload-fixture.json'), JSON.stringify({ passed: false, checks, failure: error.message, preloadErrors: failures, fixturePanels }, null, 2)); app.exit(1)
})
