const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const output = process.argv[2], profile = mkdtempSync('D:/UserAppData/Temp/hellodog-voice-preload-')
const runId = process.argv[3]
app.setPath('userData', profile)
// Fixture windows are intentionally retired between groups; only the final
// explicit result may terminate this isolated test process.
app.on('window-all-closed', () => {})
const calls = [], checks = [], failures = [], windows = [], paintCounts = new Map()
const { GoogleVoiceEmbeddedTranslation, GoogleVoiceDispatchLedger, createGoogleVoiceTranslator } = require(join(output, 'main-media-bridge.cjs'))
const mediaWindows = new Map(), mediaReceipts = new Map()
let mediaDrafts = { records: {} }, mediaJournal = { records: [] }, mediaProviderCalls = 0, mediaCreditChecks = 0
const mediaLedger = new GoogleVoiceDispatchLedger({ read: async () => structuredClone(mediaJournal), write: async value => { mediaJournal = structuredClone(value) } })
const mediaTranslator = {
  history: async () => [...mediaReceipts.values()].map(receipt => structuredClone(receipt)),
  preserveOutgoingRequest: async request => request, preserveIncomingRequest: async request => request, prepareOutgoingRequest: async request => request,
  cached: async () => undefined, translateIncoming: async () => { throw new Error('Unexpected incoming media fixture call') },
  existingOutgoing: async (id, accountId, conversationId, text, translated) => {
    const receipt = mediaReceipts.get(id)
    if (!receipt || receipt.request.accountId !== accountId || receipt.request.conversationId !== conversationId || receipt.request.text !== text || receipt.translated !== translated) throw new Error('Synthetic receipt mismatch')
    return receipt.request
  },
  translate: async request => {
    if (!mediaReceipts.has(request.requestId)) {
      mediaProviderCalls++
      mediaReceipts.set(request.requestId, { owner: 'synthetic-owner', requestId: request.requestId, request: { ...request, text: request.text.trim() }, translated: 'Synthetic translated image caption', chargedCharacters: Array.from(request.text.trim()).length, state: 'charged' })
    }
    return mediaReceipts.get(request.requestId).translated
  }
}
const mediaHandler = createGoogleVoiceTranslator(mediaTranslator, { check: async () => { mediaCreditChecks++ } }, async () => ({ localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: false, sendAutoTranslate: true, blockChineseSend: true, historyMode: 'visible' }), mediaLedger)
const mediaBridge = new GoogleVoiceEmbeddedTranslation({ storage: { read: async () => structuredClone(mediaDrafts), write: async value => { mediaDrafts = structuredClone(value) } }, translate: mediaHandler, trustedPage: event => {
  const row = mediaWindows.get(event.sender.id)
  if (!row || event.senderFrame !== event.sender.mainFrame) throw new Error('Unregistered synthetic frame')
  const epoch = row.epoch, url = event.sender.getURL()
  return { owner: 'synthetic-owner', accountId: row.accountId, url, authorized: () => !event.sender.isDestroyed() && row.epoch === epoch && event.sender.getURL() === url }
} })
let deny = false, pendingAuthorize, delayAuthorize = false, delayTranslation = false, pendingTranslation, deferIncoming = false
const html = `<!doctype html><meta charset="utf-8"><style>gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}body{font:15px Arial;padding:20px}textarea{width:600px;height:90px}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><gv-thread-details><gv-message-list><gv-message-item><div class="full-container incoming"><div class="message-row"><gv-annotation class="content">A synthetic received SMS</gv-annotation></div><div class="status">2:36 AM</div><span class="cdk-visually-hidden">Message from Synthetic sender, A synthetic received SMS, Sunday, September 20 2026, 2:36 AM.</span></div></gv-message-item></gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea><gv-message-actions><button aria-label="Add image">Add image</button></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></gv-message-entry></gv-thread-details><script>window.sent=[];const input=document.querySelector('textarea'),button=document.querySelector('.send-button');input.addEventListener('input',()=>button.disabled=!input.value);button.addEventListener('click',()=>{window.sent.push(input.value);input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))});</script>`
// Official attachment structure observed read-only on 2026-09-20. All image
// bytes, captions and destinations below are exclusively synthetic fixtures.
const mediaHtml = `<!doctype html><meta charset="utf-8"><style>gv-thread-details,gv-message-entry,gv-send-attachment-list,gv-message-actions{display:block}body{font:15px Arial;padding:20px}textarea{width:600px;height:90px}[role=row]{display:flex;gap:8px}.item{position:relative}.content{width:100px;height:100px;background-size:contain;background-repeat:no-repeat}.close-icon-overlay{display:block;cursor:pointer}button{padding:8px}</style><gv-thread-details><gv-message-list></gv-message-list><gv-message-entry><div class="root"><gv-send-attachment-list><div class="container" role="grid"><div role="row"></div></div></gv-send-attachment-list><div class="container"><textarea class="message-input" aria-readonly="false" placeholder="Add a caption"></textarea><gv-message-actions><button aria-label="Add image">Add image</button><input type="file" accept="image/png,image/jpeg,image/gif,image/bmp" multiple hidden></gv-message-actions><button class="send-button" aria-label="Send message with an attachment" disabled>Send</button></div></div></gv-message-entry></gv-thread-details><script>
window.sent=[];window.fixtureSeeds=[];
const input=document.querySelector('textarea'),button=document.querySelector('.send-button'),fileInput=document.querySelector('input[type=file]'),row=document.querySelector('[role=row]');
window.fixtureBytes=seed=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII='),char=>char.charCodeAt(0));const result=new Uint8Array(bytes.length+1);result.set(bytes);result[bytes.length]=seed;return result};
window.fixtureUrl=seed=>'data:image/png;base64,'+btoa(String.fromCharCode(...fixtureBytes(seed)));
window.fixtureUpdate=()=>button.disabled=!input.value.trim()&&!fixtureSeeds.length;
window.fixtureRender=()=>{row.replaceChildren();fixtureSeeds.forEach((seed,index)=>{const item=document.createElement('div');item.className='item';item.setAttribute('role','gridcell');const content=document.createElement('div');content.className='content';content.style.backgroundImage='url("'+fixtureUrl(seed)+'")';const close=document.createElement('span');close.className='close-icon-overlay';close.setAttribute('role','button');close.setAttribute('aria-label','Remove the '+(index+1)+'st image');close.append(document.createElement('mat-icon'));close.addEventListener('click',()=>{fixtureSeeds.splice(index,1);fixtureRender()});item.append(content,close);row.append(item)});fixtureUpdate()};
window.fixtureSelect=(seeds,append=false)=>{const transfer=new DataTransfer();for(const seed of seeds)transfer.items.add(new File([fixtureBytes(seed)],'synthetic-'+seed+'.png',{type:'image/png'}));fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}));fixtureSeeds=append?fixtureSeeds.concat(seeds):seeds.slice();fixtureRender();fileInput.value=''};
window.fixtureSelectInvalid=()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0,1,2,3])],'synthetic-invalid.png',{type:'image/png'}));fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}));fixtureSeeds=[99];fixtureRender();row.querySelector('.content').style.backgroundImage='url("data:image/png;base64,AAECAw==")';fileInput.value=''};
input.addEventListener('input',fixtureUpdate);button.addEventListener('click',()=>{sent.push({text:input.value,count:fixtureSeeds.length});input.value='';fixtureSeeds=[];fixtureRender();input.dispatchEvent(new Event('input',{bubbles:true}))});
</script>`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50) } throw new Error('Timed out: ' + label) }
function page(window, script) { return window.webContents.executeJavaScript(script) }
function isolated(window, script) { return window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: script }]) }
function panel(window, text) { return isolated(window, `globalThis.__fixtureRoots.some(root=>root.host.isConnected && (root.textContent+' '+(root.querySelector('textarea')?.value||'')).includes(${JSON.stringify(text)}))`) }
function click(window, label) { return isolated(window, `(()=>{const root=[...globalThis.__fixtureRoots].reverse().find(root=>root.host.isConnected);const button=[...root.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Missing fixture button');button.click()})()`) }
async function draft(window, value) { await page(window, `(()=>{const input=document.querySelector('textarea.message-input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`); }
async function mediaReady(window) { await until(async () => await page(window, `document.querySelector('[data-hellodog-voice="toolbar"] button')?.disabled===false`), 'verified CSS attachment preview') }
async function mediaChange(window, script, signals = 2) {
  // File reading and CSS fingerprinting finish asynchronously. Waiting for the
  // prior toolbar's enabled state would race the new native file selection.
  const before = await isolated(window, '__fixtureMediaSignals')
  await page(window, script)
  await until(async () => await isolated(window, '__fixtureMediaSignals') >= before + signals, 'current CSS attachment verification signals')
  await mediaReady(window)
}
async function newWindow(url, media = false) {
  const isolatedSession = session.fromPartition('fixture-' + randomUUID())
  // Every HTTPS request is answered by a synthetic local document.
  isolatedSession.protocol.handle('https', () => new Response(media ? mediaHtml : html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  // Render real Chromium frames without showing test windows over the user's
  // work. Ordinary hidden windows can stop after the first requested frame.
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { session: isolatedSession, preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const contentsId = window.webContents.id
  paintCounts.set(contentsId, 0)
  window.webContents.on('paint', () => paintCounts.set(contentsId, paintCounts.get(contentsId) + 1))
  window.webContents.setFrameRate(60)
  window.webContents.startPainting()
  windows.push(window)
  if (media) {
    const row = { accountId: 'gv-' + randomUUID(), epoch: 0 }; mediaWindows.set(window.webContents.id, row)
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) row.epoch++ })
  }
  window.webContents.on('preload-error', (_e, _path, error) => failures.push(error.message))
  await window.loadURL(url); return window
}
ipcMain.handle('google-voice:translate-request', async (event, request) => {
  calls.push(request)
  if (mediaWindows.has(event.sender.id)) return mediaBridge.request(event, request)
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
  for (const auth of authPages) auth.destroy()
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
  window.destroy()
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
  deferredWindow.destroy()

  const mediaWindow = await newWindow('https://voice.google.com/u/0/messages?itemId=t.synthetic-image', true)
  await mediaChange(mediaWindow, 'fixtureSelect([11])')
  assert.equal(await page(mediaWindow, `document.querySelectorAll('gv-send-attachment-list img').length`), 0)
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '图片发送前预览'), 'CSS image-only preview')
  assert.equal(await page(mediaWindow, 'sent.length'), 0); assert.equal(mediaProviderCalls, 0); assert.equal(mediaCreditChecks, 0)
  assert.equal(mediaJournal.records.length, 0)
  await click(mediaWindow, '确认发送'); await until(async () => await page(mediaWindow, 'sent.length') === 1, 'CSS image-only dispatch')
  assert.deepEqual(await page(mediaWindow, 'sent[0]'), { text: '', count: 1 })
  assert.equal(mediaProviderCalls, 0); assert.equal(mediaCreditChecks, 0)
  assert.equal(mediaJournal.records.length, 1); assert.equal(mediaJournal.records[0].state, 'uncertain')
  checks.push('Observed CSS attachment grid with no img crosses isolated preload and actual main bridge; image-only confirmation reserves once with zero provider or credit calls')

  await mediaWindow.loadURL('https://voice.google.com/u/0/messages?itemId=t.synthetic-image')
  await mediaChange(mediaWindow, 'fixtureSelect([11])')
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '发送结果待核对'), 'CSS image uncertainty after full reload')
  assert.equal(await page(mediaWindow, 'sent.length'), 0); assert.equal(mediaProviderCalls, 0)
  assert.equal(mediaJournal.records.length, 1); assert.equal(mediaJournal.records[0].attempts, 1)
  await click(mediaWindow, '已核对：确认未发送'); await until(() => panel(mediaWindow, '已确认未发送'), 'explicit CSS image retry resolution')
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '图片发送前预览'), 'CSS image retry preview')
  await click(mediaWindow, '确认发送'); await until(async () => await page(mediaWindow, 'sent.length') === 1, 'CSS image manual retry')
  assert.equal(mediaJournal.records[0].attempts, 2); assert.equal(mediaProviderCalls, 0); assert.equal(mediaCreditChecks, 0)
  checks.push('Full document reload and identical file reselection preserve image uncertainty; only explicit not-sent permits one manual retry without translation charges')
  await mediaChange(mediaWindow, 'fixtureSelect([11])')
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '发送结果待核对'), 'synthetic retry result reconciliation')
  await click(mediaWindow, '已核对：确认已发送'); await until(() => panel(mediaWindow, '已确认发送'), 'synthetic sent result recorded')
  assert.equal(mediaJournal.records[0].state, 'sent')

  await mediaChange(mediaWindow, 'fixtureSelect([21])')
  await draft(mediaWindow, '合成图片说明'); await until(() => panel(mediaWindow, '图片发送前预览'), 'CSS caption preview')
  assert.equal(mediaProviderCalls, 1); assert.equal(await page(mediaWindow, 'sent.length'), 1)
  const beforeChangedImage = mediaJournal.records.length
  await mediaChange(mediaWindow, 'fixtureSelect([22])')
  await click(mediaWindow, '确认发送'); await until(() => panel(mediaWindow, '草稿已变化'), 'stale CSS image caption rejection')
  assert.equal(mediaJournal.records.length, beforeChangedImage); assert.equal(await page(mediaWindow, 'sent.length'), 1)
  assert.equal(await page(mediaWindow, `document.querySelector('textarea').value`), '合成图片说明')
  checks.push('Replacing CSS attachment bytes after a translated preview invalidates confirmation before reservation and keeps the Chinese caption')

  await draft(mediaWindow, '合成图片说明'); await until(() => panel(mediaWindow, '图片发送前预览'), 'replacement CSS caption preview')
  const replacementRequest = calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing' && call.payload.media).at(-1).payload.id
  assert.equal(mediaProviderCalls, 2)
  const beforeRepeatedPreview = calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing').length
  await draft(mediaWindow, '合成图片说明')
  await until(() => calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing').length > beforeRepeatedPreview, 'repeated caption crosses main bridge')
  await until(() => panel(mediaWindow, '图片发送前预览'), 'same caption preview reuse')
  assert.equal(calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing' && call.payload.media).at(-1).payload.id, replacementRequest)
  assert.equal(mediaProviderCalls, 2); assert.equal(mediaReceipts.size, 2)
  await click(mediaWindow, '确认发送'); await until(async () => await page(mediaWindow, 'sent.length') === 2, 'explicit CSS caption dispatch')
  assert.deepEqual(await page(mediaWindow, 'sent[1]'), { text: 'Synthetic translated image caption', count: 1 })
  assert.equal(mediaProviderCalls, 2)
  checks.push('Chinese CSS image caption reaches the synthetic native send only after explicit confirmation; repeated preview of the same image/caption reuses one paid receipt')

  await mediaChange(mediaWindow, 'fixtureSelect([31])')
  await mediaChange(mediaWindow, 'fixtureSelect([32],true)')
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '已核对 2 张图片'), 'appended CSS images')
  const beforeRemoval = mediaJournal.records.length
  await mediaChange(mediaWindow, `document.querySelector('.close-icon-overlay').click()`, 1)
  await click(mediaWindow, '确认发送'); await until(() => panel(mediaWindow, '草稿已变化'), 'removed CSS image rejects stale preview')
  assert.equal(mediaJournal.records.length, beforeRemoval); assert.equal(await page(mediaWindow, 'sent.length'), 2)
  await draft(mediaWindow, ''); await until(() => panel(mediaWindow, '已核对 1 张图片'), 'remaining CSS image preview')
  assert.equal(mediaProviderCalls, 2)
  const beforeTamper = mediaJournal.records.length
  await page(mediaWindow, `document.querySelector('gv-send-attachment-list .content').style.backgroundImage='url("'+fixtureUrl(99)+'")'`)
  await until(async () => await page(mediaWindow, `document.querySelector('[data-hellodog-voice="toolbar"] button')?.disabled===true`), 'unselected CSS image refused')
  await click(mediaWindow, '确认发送'); await until(() => panel(mediaWindow, '尚未完成'), 'unselected background prevents dispatch')
  assert.equal(mediaJournal.records.length, beforeTamper); assert.equal(await page(mediaWindow, 'sent.length'), 2); assert.equal(mediaProviderCalls, 2)
  checks.push('Successive native file selections append verified CSS previews; removing or changing a background invalidates old confirmation and unselected bytes cannot be sent')
  await page(mediaWindow, `document.querySelector('.close-icon-overlay').click()`); await mediaReady(mediaWindow)
  await page(mediaWindow, 'fixtureSelectInvalid()')
  await until(async () => await page(mediaWindow, `document.querySelector('[data-hellodog-voice="toolbar"]')?.textContent.includes('图片无法核实')`), 'invalid CSS image fails verification')
  await draft(mediaWindow, '附件移除后的合成纯文字'); await until(() => panel(mediaWindow, '图片无法核实'), 'invalid CSS image blocks Chinese caption')
  assert.equal(mediaJournal.records.length, beforeTamper); assert.equal(mediaProviderCalls, 2); assert.equal(await page(mediaWindow, 'sent.length'), 2)
  await page(mediaWindow, `document.querySelector('.close-icon-overlay').click()`); await mediaReady(mediaWindow)
  await draft(mediaWindow, '附件移除后的合成纯文字'); await until(() => panel(mediaWindow, '发送前预览'), 'text preview recovers after invalid attachment removal')
  assert.equal(mediaProviderCalls, 3); assert.equal(mediaJournal.records.length, beforeTamper); assert.equal(await page(mediaWindow, 'sent.length'), 2)
  assert.equal(calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing').at(-1).payload.media, undefined)
  checks.push('Invalid image bytes block caption translation and sending; removing the failed native preview restores a normal text-only preview without a stuck attachment or native click')
  assert.deepEqual(failures, [])
  const mediaFrames = await isolated(mediaWindow, '({...__fixtureFrames})')
  assert.ok(mediaFrames.completed >= 2, 'Changed caption must finish both production animation frames')
  const mediaPaints = paintCounts.get(mediaWindow.webContents.id)
  assert.ok(mediaPaints > 0, 'Offscreen Chromium must paint the synthetic media page')
  writeFileSync(join(output, 'preload-fixture.json'), JSON.stringify({ runId, at: new Date().toISOString(), electron: process.versions.electron, passed: true, checks, actualMediaBridge: true, cssAttachmentStructureObserved: true, offscreen: true, mediaFrames, mediaPaints, mediaProviderCalls, mediaChargedReceipts: mediaReceipts.size, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false }, null, 2))
  app.exit(0)
}).catch(async error => {
  console.error(error.stack)
  const fixturePanels = await Promise.all(windows.filter(window => !window.isDestroyed()).map(window => isolated(window, `({frames:__fixtureFrames,visibility:document.visibilityState,panels:globalThis.__fixtureRoots.filter(root=>root.host.isConnected).map(root=>({text:root.textContent,value:root.querySelector('textarea')?.value}))})`).catch(() => [])))
  console.error(JSON.stringify({ fixturePanels }))
  writeFileSync(join(output, 'preload-fixture.json'), JSON.stringify({ runId, passed: false, checks, failure: error.message, preloadErrors: failures, fixturePanels }, null, 2)); app.exit(1)
})
