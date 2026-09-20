const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const output = process.argv[2], runId = process.argv[3]
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-page-state-'))
app.on('window-all-closed', () => {})
const { GoogleVoiceWorkspace, googleVoiceEmbeddedPartition, GoogleVoiceEmbeddedTranslation } = require(join(output, 'main-page-state.cjs'))
const id = 'gv-10000000-0000-4000-8000-000000000001', owner = 'synthetic-page-state-' + randomUUID()
const sms = 'https://voice.google.com/u/0/messages?itemId=t.fixture', restricted = 'https://support.google.com/accounts/answer/40039?p=grandcentral'
const checks = [], calls = [], ipc = [], failures = [], pages = []
let workspace, bridge, shell
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) { for (let index = 0; index < 160; index++) { if (await check()) return; await pause(50) } throw new Error('Timed out: ' + label) }
const execute = (wc, code) => wc.executeJavaScript(code)
ipcMain.handle('google-voice:translate-request', async (event, request) => {
  const response = await bridge.request(event, request)
  ipc.push({ event, request, response }); return response
})
ipcMain.handle('google-voice:unread', () => false)
const translation = { v: 1, type: 'voice.translate', payload: { direction: 'incoming', manual: true, id: randomUUID(), conversationId: 'gv_' + createHash('sha256').update(JSON.stringify(['/u/0/messages', 't.fixture'])).digest('hex'), text: 'Synthetic incoming text' } }
async function state() { return execute(shell.webContents, 'received.at(-1)') }
app.whenReady().then(async () => {
  const ses = session.fromPartition(googleVoiceEmbeddedPartition(owner, id))
  ses.protocol.handle('https', () => new Response('<!doctype html><meta charset="utf-8"><main>Only synthetic page-state content</main>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  ses.protocol.handle('http', () => new Response('', { status: 403 }))
  shell = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: join(output, 'shell-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  await shell.loadURL('data:text/html,<main>Isolated page-state renderer</main>')
  await execute(shell.webContents, 'globalThis.received=[];desktopAPI.onGoogleVoiceState(value=>received.push(value));true')
  const row = { id, owner, label: 'Synthetic', browser: 'chrome', notificationsEnabled: false, closed: false }
  const storage = { get: async (who, windowId) => { assert.equal(who, owner); assert.equal(windowId, id); return row }, proxyPassword: async () => '' }
  workspace = new GoogleVoiceWorkspace(shell, storage, () => ({ owner, authorized: () => true }), {
    preloadPath: join(output, 'voice-preload.cjs'),
    onPage: ({ webContents }) => { pages.push(webContents); webContents.setBackgroundThrottling(false); webContents.on('preload-error', (_event, _path, error) => failures.push(error.message)) }
  })
  bridge = new GoogleVoiceEmbeddedTranslation({ trustedPage: event => workspace.trustedPage(event), storage: { read: async () => ({ records: {} }), write: async () => { throw new Error('Unexpected draft write') } }, translate: async (_owner, _id, operation, payload, authorized) => {
    assert.equal(authorized(), true); calls.push(operation)
    if (operation === 'status') return { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: false, sendAutoTranslate: true, historyMode: 'manual' }
    assert.equal(operation, 'translate'); assert.equal(payload.direction, 'incoming')
    return { enabled: true, text: '合成测试译文', requestId: 'synthetic-request', targetLanguage: 'zh-CN' }
  } })
  workspace.setBounds({ x: 0, y: 0, width: 720, height: 650 })
  await workspace.focus(id)
  const wc = pages[0]
  await until(async () => (await state())?.state === 'ready', 'initial embedded network setup and page')
  await wc.loadURL(sms)
  await until(async () => (await state())?.page === 'messages' && ipc.some(value => value.response.ok), 'actual SMS page classification and preload IPC')
  let current = ipc.filter(value => value.response.ok).at(-1).event
  assert.equal((await bridge.request(current, translation)).ok, true)
  assert.equal(calls.filter(value => value === 'translate').length, 1)
  checks.push('Real registered child-view preload and senderFrame permit a synthetic text translation on the normal SMS route')

  const old = workspace.trustedPage(current)
  await wc.loadURL(restricted)
  await until(async () => (await state())?.page === 'access-help', 'restriction guidance delivered through real shell preload')
  assert.equal((await state()).state, 'ready'); assert.equal(old.authorized(), false)
  assert.equal((await workspace.focus(id)).page, 'access-help')
  const before = calls.length, beforeIpc = ipc.length
  for (const request of [translation, { v: 1, type: 'voice.status' }, { v: 1, type: 'voice.authorize', payload: translation.payload }]) assert.equal((await bridge.request(current, request)).ok, false)
  await pause(650)
  assert.equal(calls.length, before); assert.equal(ipc.length, beforeIpc)
  checks.push('Official access-help remains viewable while stale text/status/authorize requests are refused before translation or billing callbacks; no Voice preload traffic originates there')

  await wc.loadURL('https://support.google.com/voice/answer/115116')
  await until(async () => (await state())?.page === 'help', 'ordinary support page')
  assert.equal(calls.length, before)
  checks.push('An unrelated official support article reports help only, never inferred suspension or translation readiness')
  await wc.loadURL('https://accounts.google.com/ServiceLogin?synthetic=private')
  await until(async () => (await state())?.page === 'sign-in', 'official login page')
  assert.equal(calls.length, before)
  assert.ok(!JSON.stringify(await execute(shell.webContents, 'received')).includes('synthetic=private'))
  checks.push('Google sign-in reports its own finite state without full URLs, credentials, translation requests or billable work')

  await wc.loadURL(sms)
  await until(async () => (await state())?.page === 'messages' && ipc.length > beforeIpc && ipc.at(-1).response.ok, 'SMS page recovery')
  current = ipc.at(-1).event
  assert.equal((await bridge.request(current, translation)).ok, true)
  const recovered = workspace.trustedPage(current)
  checks.push('Returning to a supported SMS page restores fresh authorized synthetic translation without reusing an old page grant')

  await execute(wc, `window.open(${JSON.stringify(restricted)}, '_blank');true`)
  await until(async () => pages.length === 2 && (await state())?.page === 'access-help', 'official in-client help popup')
  const popupBefore = calls.length
  assert.equal(recovered.authorized(), false)
  assert.equal((await bridge.request(current, translation)).ok, false)
  assert.equal(calls.length, popupBefore)
  checks.push('An official popup covers and revokes the old Voice document, rejecting its IPC without a provider or character debit')
  await workspace.back(id)
  await until(async () => (await state())?.page === 'messages', 'return from help popup')
  assert.equal(recovered.authorized(), false)
  assert.deepEqual(failures, [])
  checks.push('Closing the popup restores page classification but never revives the prior in-flight authorization; no preload errors')
  await workspace.detachAll(); shell.destroy()
  writeFileSync(join(output, 'page-state-electron.json'), JSON.stringify({ runId, at: new Date().toISOString(), passed: true, checks, electron: process.versions.electron, realWorkspace: true, realEmbeddedViews: true, realVoicePreload: true, realShellPreload: true, realEmbeddedTranslation: true, syntheticTranslationCalls: calls.filter(value => value === 'translate').length, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false }, null, 2))
  app.exit(0)
}).catch(async error => {
  console.error(error.stack)
  writeFileSync(join(output, 'page-state-electron.json'), JSON.stringify({ runId, passed: false, checks, failure: error.message, failures, calls }, null, 2))
  try { await workspace?.detachAll(); if (shell && !shell.isDestroyed()) shell.destroy() } catch {}
  app.exit(1)
})
