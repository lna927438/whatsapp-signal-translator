const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const output = process.argv[2], runId = process.argv[3]
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-runtime-resilience-'))
app.on('window-all-closed', () => {})
const checks = [], failures = [], windows = [], scenarios = new Map(), health = []
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(check, label) { for (let index = 0; index < 100; index++) { if (await check()) return; await pause(40) } throw Error('Timed out: ' + label) }
const page = (window, code) => window.webContents.executeJavaScript(code)
const isolated = (window, code) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }])
const translated = window => page(window, `[...document.querySelectorAll('[data-hellodog-voice="translation"]')].filter(node=>node.textContent==='合成测试译文').length`)
const controls = window => page(window, `document.querySelectorAll('[data-hellodog-voice="translation"]').length`)
const append = (window, id) => page(window, `fixtureAppend(${JSON.stringify(id)})`)
const message = id => `<gv-message-item id="${id}"><div class="full-container incoming"><div class="message-row"><gv-annotation class="content">fixture private body ${id}</gv-annotation></div><div class="status">2:36 AM</div><span class="cdk-visually-hidden">Message from synthetic +15555550123, fixture private body ${id}, Thursday, September 24 2026, 2:36 AM.</span></div></gv-message-item>`
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic runtime resilience</title><style>body{font:15px Arial}gv-thread-details,gv-message-list,gv-message-entry,gv-message-item{display:block}gv-message-item{min-height:48px}textarea{width:600px;height:70px}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><gv-thread-details><gv-message-list>${message('first')}</gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea><gv-message-actions><button aria-label="Add image">Add image</button></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></gv-message-entry></gv-thread-details><script>window.nativeSends=[];window.fixtureAppend=id=>document.querySelector('gv-message-list').insertAdjacentHTML('beforeend',(${message.toString()})(id));const input=document.querySelector('textarea'),button=document.querySelector('.send-button');input.addEventListener('input',()=>button.disabled=!input.value);button.addEventListener('click',()=>nativeSends.push(input.value));</script>`
const status = (overrides = {}) => ({ ok: true, result: { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', historyMode: 'visible', receiveAutoTranslate: true, translationsVisible: true, ...overrides } })
const translation = request => ({ ok: true, result: { enabled: true, text: '合成测试译文', requestId: 'fixture-' + request.payload.id } })
ipcMain.handle('fixture:health', (event, value) => { health.push({ contentsId: event.sender.id, value }); return true })
ipcMain.handle('fixture:request', async (event, request) => {
  const scenario = scenarios.get(event.sender.id)
  scenario.calls.push(request)
  if (request.type === 'voice.status') {
    if (scenario.delayStatus) { scenario.delayStatus = false; return new Promise(done => { scenario.resolveStatus = done }) }
    if (scenario.failStatus) return { ok: false, error: 'fixture private status failure +15555550123', code: 'unavailable' }
    return status(scenario.newOnly ? { historyMode: 'new', newMessageTracking: true } : {})
  }
  if (request.type === 'voice.translate') {
    if (request.payload.direction !== 'incoming') throw Error('Outgoing translation must not occur in these fixtures')
    if (scenario.delayTranslation) { scenario.delayTranslation = false; return new Promise(done => { scenario.resolveTranslation = () => done(translation(request)) }) }
    return translation(request)
  }
  if (request.type === 'voice.history-baseline') {
    const result = { ok: true, result: { token: randomUUID(), startedAt: Date.now(), expiresAt: Date.now() + 60000, anchorId: request.payload.ids.at(-1) } }
    if (scenario.delayBaseline) { scenario.delayBaseline = false; return new Promise(done => { scenario.resolveBaseline = () => done(result) }) }
    return result
  }
  throw Error('Unexpected fixture request ' + request.type)
})
async function newWindow(options = {}) {
  const partition = session.fromPartition('runtime-resilience-' + randomUUID())
  partition.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  partition.protocol.handle('http', () => new Response('', { status: 403 }))
  partition.webRequest.onBeforeRequest({ urls: ['ws://*/*', 'wss://*/*'] }, (_detail, callback) => callback({ cancel: true }))
  const window = new BrowserWindow({ show: false, width: 1050, height: 900, webPreferences: { session: partition, preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.on('paint', () => {}); window.webContents.setFrameRate(30); window.webContents.startPainting()
  window.webContents.on('preload-error', (_event, _path, error) => failures.push(error.message))
  scenarios.set(window.webContents.id, { calls: [], ...options }); windows.push(window)
  await window.loadURL('https://voice.google.com/u/0/messages?itemId=t.synthetic&fault=' + (options.fault || ''))
  return window
}
const hasHealth = (window, code) => health.some(row => row.contentsId === window.webContents.id && row.value.code === code)
app.whenReady().then(async () => {
  const slow = await newWindow({ delayStatus: true }), slowScenario = scenarios.get(slow.webContents.id)
  await until(() => !!slowScenario.resolveStatus && controls(slow).then(count => count === 1), 'manual control while status pending')
  assert.equal(slowScenario.calls.filter(call => call.type === 'voice.translate').length, 0)
  await append(slow, 'second')
  await until(async () => await controls(slow) === 2, 'new message discovery while status pending')
  checks.push('A pending status request keeps both initial and subsequently rendered message controls available without automatic translation')
  await page(slow, `document.querySelector('[data-hellodog-voice="translation"] button').click()`)
  await until(async () => await translated(slow) === 1, 'manual translation before status resolves')
  assert.equal(slowScenario.calls.find(call => call.type === 'voice.translate').payload.manual, true)
  slowScenario.resolveStatus(status())
  await until(async () => await translated(slow) === 2, 'automatic translation after status recovery')
  checks.push('Explicit manual translation remains usable during status delay; automatic work resumes after verified status arrives')
  slow.destroy()

  const composer = await newWindow({ fault: 'composer' }), composerScenario = scenarios.get(composer.webContents.id)
  await until(async () => await translated(composer) === 1, 'read-only translation despite composer fault')
  assert.equal(hasHealth(composer, 'editor-unrecognized'), true)
  assert.equal(await page(composer, `document.querySelector('[data-hellodog-voice="toolbar"] button').disabled`), true)
  await page(composer, `(()=>{const input=document.querySelector('textarea');input.value='合成草稿';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.send-button').click()})()`)
  await pause(300)
  assert.deepEqual(await page(composer, 'nativeSends'), [])
  assert.equal(await page(composer, `document.querySelector('textarea').value`), '合成草稿')
  assert.ok(composerScenario.calls.every(call => call.type === 'voice.status' || call.type === 'voice.translate' && call.payload.direction === 'incoming'))
  checks.push('Composer exceptions preserve readable message translation while disabling preview and preventing native sending without changing the draft')
  composer.destroy()

  const digest = await newWindow({ fault: 'message-digest' })
  await until(() => hasHealth(digest, 'scan-failed'), 'message digest fault health')
  assert.equal(await page(digest, `!!document.querySelector('[data-hellodog-voice="toolbar"]')`), true)
  assert.equal(await page(digest, `document.querySelector('[data-hellodog-voice="toolbar"] button').disabled`), true)
  assert.equal(await controls(digest), 0)
  checks.push('A real message-signature digest rejection reports scan-failed and retains a disabled toolbar')
  await isolated(digest, `globalThis.__fixtureFault='';document.body.append(document.createElement('span'))`)
  await until(async () => await translated(digest) === 1 && hasHealth(digest, 'ready'), 'healthy digest recovery')
  assert.equal(await page(digest, `document.querySelector('[data-hellodog-voice="toolbar"] button').disabled`), false)
  checks.push('The same document recovers translation controls and healthy status after the digest fault clears')
  digest.destroy()

  const unavailable = await newWindow({ failStatus: true }), unavailableScenario = scenarios.get(unavailable.webContents.id)
  await until(async () => await controls(unavailable) === 1 && hasHealth(unavailable, 'status-unavailable'), 'failed status leaves control')
  unavailableScenario.failStatus = false; unavailable.webContents.send('fixture:context-changed')
  await until(async () => await translated(unavailable) === 1 && hasHealth(unavailable, 'ready'), 'status retry recovery')
  checks.push('A failed status request leaves a manual control and recovers after connection settings change')
  unavailable.destroy()

  const slowTranslation = await newWindow({ delayTranslation: true }), translationScenario = scenarios.get(slowTranslation.webContents.id)
  await until(() => !!translationScenario.resolveTranslation, 'first automatic translation pending')
  await append(slowTranslation, 'after-pending')
  await until(async () => await controls(slowTranslation) === 2, 'new control while automatic translation pending')
  assert.equal(translationScenario.calls.filter(call => call.type === 'voice.translate').length, 1)
  translationScenario.resolveTranslation()
  await until(async () => await translated(slowTranslation) === 2, 'queued message after delayed translation')
  checks.push('A pending automatic translation does not freeze DOM discovery; the next message starts once the first operation settles')
  slowTranslation.destroy()

  const navigation = await newWindow({ delayStatus: true }), navigationScenario = scenarios.get(navigation.webContents.id)
  await until(() => !!navigationScenario.resolveStatus, 'old status pending')
  await page(navigation, `history.pushState({},'', '/u/0/messages?itemId=t.synthetic-next');document.body.append(document.createElement('span'))`)
  await until(async () => navigationScenario.calls.filter(call => call.type === 'voice.status').length === 2 && await translated(navigation) === 1, 'new route status before old response')
  navigationScenario.resolveStatus(status({ receiveAutoTranslate: false, translationsVisible: false }))
  await pause(300); await append(navigation, 'after-stale-status')
  await until(async () => await translated(navigation) === 2, 'old disabled response does not overwrite current route')
  checks.push('Navigation retires an old status flight immediately and ignores its later disabled response')
  navigation.destroy()

  const translationNavigation = await newWindow({ delayTranslation: true }), navigationTranslationScenario = scenarios.get(translationNavigation.webContents.id)
  await until(() => !!navigationTranslationScenario.resolveTranslation, 'old conversation translation pending')
  const resolveOldTranslation = navigationTranslationScenario.resolveTranslation
  navigationTranslationScenario.delayTranslation = true
  navigationTranslationScenario.resolveTranslation = undefined
  await page(translationNavigation, `history.pushState({},'', '/u/0/messages?itemId=t.synthetic-next-translation');document.body.append(document.createElement('span'))`)
  await until(() => navigationTranslationScenario.calls.filter(call => call.type === 'voice.status').length === 2 && !!navigationTranslationScenario.resolveTranslation, 'new conversation status and translation before old work settles')
  assert.equal(navigationTranslationScenario.calls.filter(call => call.type === 'voice.translate').length, 2)
  resolveOldTranslation(); await pause(300)
  assert.equal(await translated(translationNavigation), 0)
  await append(translationNavigation, 'while-new-translation-pending')
  await until(async () => await controls(translationNavigation) === 2, 'new control while replacement flight pending')
  assert.equal(navigationTranslationScenario.calls.filter(call => call.type === 'voice.translate').length, 2)
  navigationTranslationScenario.resolveTranslation()
  await until(async () => await translated(translationNavigation) === 2, 'new conversation resumes without stale automatic-flight overwrite')
  checks.push('Navigation retires the old automatic translation; its late completion cannot paint stale text or clear the newer flight')
  translationNavigation.destroy()

  const baseline = await newWindow({ newOnly: true, delayBaseline: true }), baselineScenario = scenarios.get(baseline.webContents.id)
  await until(() => !!baselineScenario.resolveBaseline, 'history baseline pending')
  await append(baseline, 'during-baseline')
  await until(async () => await controls(baseline) === 2, 'new controls during history baseline request')
  assert.equal(baselineScenario.calls.filter(call => call.type === 'voice.translate').length, 0)
  await page(baseline, `history.pushState({},'', '/u/0/messages?itemId=t.synthetic-next-baseline');document.body.append(document.createElement('span'))`)
  await until(() => baselineScenario.calls.filter(call => call.type === 'voice.history-baseline').length === 2, 'new route establishes independent baseline without old response')
  baselineScenario.resolveBaseline(); await pause(400)
  assert.equal(await controls(baseline), 2)
  assert.equal(baselineScenario.calls.filter(call => call.type === 'voice.translate').length, 0)
  checks.push('Delayed new-message baseline leaves DOM discovery responsive; navigation can establish a new baseline and stale completion cannot bill history')
  await append(baseline, 'live-one')
  await until(() => baselineScenario.calls.filter(call => call.type === 'voice.translate').length === 1, 'first genuine new message after baseline')
  await append(baseline, 'live-two')
  await until(() => baselineScenario.calls.filter(call => call.type === 'voice.translate').length === 2, 'second genuine new message after baseline')
  await page(baseline, `(()=>{const item=document.getElementById('live-one');item.querySelector('gv-annotation').textContent='fixture private body recycled';item.querySelector('.cdk-visually-hidden').textContent='Message from synthetic +15555550123, fixture private body recycled, Thursday, September 24 2026, 2:37 AM.';item.querySelector('.status').textContent='2:37 AM';document.querySelector('gv-message-list').append(item)})()`)
  await pause(800)
  assert.equal(baselineScenario.calls.filter(call => call.type === 'voice.translate').length, 2)
  assert.equal(await page(baseline, `document.getElementById('live-one').querySelector('[data-hellodog-voice="translation"] button')?.textContent`), '翻译')
  checks.push('Moving a recycled non-anchor/non-tail message node after the tail does not classify its replacement text as a new billable message')
  baseline.destroy()

  assert.ok(health.length > 0)
  for (const { value } of health) {
    assert.deepEqual(Object.keys(value).sort(), ['code', 'messageCount', 'phase'])
    assert.ok(['waiting', 'ready', 'error'].includes(value.phase))
    assert.ok(Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 && value.messageCount <= 500)
    assert.doesNotMatch(JSON.stringify(value), /private|15555550123|https:|voice\.google|synthetic/i)
  }
  assert.deepEqual(failures, [])
  checks.push('Health diagnostics contain only bounded phase/code/count fields and never synthetic body, phone, URL or raw exception text')
  writeFileSync(join(output, 'fixture.json'), JSON.stringify({ runId, passed: true, checks, healthReports: health.length, productionRuntimeAndAdapter: true, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false }, null, 2))
  app.exit(0)
}).catch(error => {
  console.error(error.stack)
  writeFileSync(join(output, 'fixture.json'), JSON.stringify({ runId, passed: false, checks, failure: error.message, failures, health }, null, 2)); app.exit(1)
})
