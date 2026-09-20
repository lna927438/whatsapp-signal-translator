const { app, BrowserWindow, ipcMain, session } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const output = process.argv[2], runId = process.argv[3]
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-unread-'))
app.on('window-all-closed', () => {})
const { GoogleVoiceWorkspace, googleVoiceEmbeddedPartition, accountUnreadSnapshot, updateAccountUnread, clearAccountUnread } = require(join(output, 'main-unread.cjs'))
const A = 'gv-10000000-0000-4000-8000-000000000001', B = 'gv-20000000-0000-4000-8000-000000000002'
const owner = 'synthetic-unread-owner-' + randomUUID()
const checks = [], reports = [], notifications = [], failures = [], pages = new Map(), activeEvents = new Map()
let workspace, shell, ownerCurrent = true, authRevision = 0
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) { for (let index = 0; index < 160; index++) { if (await check()) return; await pause(50) } throw new Error('Timed out: ' + label) }
const page = (contents, script) => contents.executeJavaScript(script)
const syntheticHtml = (count, collapsed = false) => `<!doctype html><meta charset="utf-8"><title>Voice - (${count}) Messages</title><style>body{margin:0}mat-nav-list{display:block}a{display:block;width:72px;height:48px}mat-icon,.mat-badge-content{display:inline-block;width:20px;height:20px;visibility:visible}.mat-badge-hidden .mat-badge-content{display:none}.collapsed{display:none}</style><mat-nav-list class="${collapsed ? 'collapsed' : ''}"><a role="tab" gv-test-id="sidenav-messages"><mat-icon class="mat-badge"><span class="mat-badge-content mat-badge-active">${count}</span></mat-icon></a></mat-nav-list><main>Only synthetic content</main>`
// Main handlers mirror the narrow production registration in src/main/ipc.ts;
// workspace ownership, actual Electron senderFrame checks, tracker, shared
// desktop count store and shell preload are all production code.
ipcMain.handle('google-voice:unread', (event, message) => {
  assert.deepEqual(Object.keys(message).sort(), ['count', 'documentId', 'sequence', 'source'])
  let accepted = false
  try { accepted = workspace.observeUnread(event, message) } catch { /* deliberately refused untrusted fixture */ }
  reports.push({ source: message.source, documentId: message.documentId, sequence: message.sequence, count: message.count, accepted, contentsId: event.sender.id })
  if (accepted) activeEvents.set(event.sender.id, event)
  return accepted
})
ipcMain.handle('google-voice:translate-request', (_event, request) => {
  assert.equal(request.type, 'voice.status', 'No synthetic message/provider operations are permitted')
  return { ok: true, result: { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: false, sendAutoTranslate: false, historyMode: 'manual' } }
})
ipcMain.handle('accounts:unread-snapshot', event => {
  assert.equal(event.sender, shell.webContents); assert.equal(event.senderFrame, shell.webContents.mainFrame)
  return accountUnreadSnapshot()
})
app.whenReady().then(async () => {
  // Independent partitions and protocol responses prevent any request from
  // reaching Google, a proxy, the billing service or a user profile.
  for (const [id, count, collapsed] of [[A, 1, false], [B, 3, true]]) {
    const ses = session.fromPartition(googleVoiceEmbeddedPartition(owner, id))
    ses.protocol.handle('https', () => new Response(syntheticHtml(count, collapsed), { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    ses.protocol.handle('http', () => new Response('', { status: 403 }))
  }
  shell = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: join(output, 'shell-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  shell.webContents.on('preload-error', (_e, _path, error) => failures.push(error.message))
  await shell.loadURL('data:text/html,<main>Isolated unread renderer</main>')
  await page(shell.webContents, `globalThis.received=[];globalThis.unread={};desktopAPI.onAccountUnread(event=>{received.push(event);unread[event.accountId]=Math.max(0,Number(event.count)||0)});true`)
  const records = [A, B].map(id => ({ id, owner, label: 'Synthetic', browser: 'chrome', notificationsEnabled: true, closed: false }))
  const storage = { get: async (who, id) => { const row = records.find(item => item.id === id && item.owner === who && !item.closed); if (!row) throw new Error('Unknown synthetic record'); return row }, proxyPassword: async () => '', update: async (who, id, patch) => Object.assign(await storage.get(who, id), patch) }
  workspace = new GoogleVoiceWorkspace(shell, storage, () => {
    if (!ownerCurrent) throw new Error('Synthetic owner logged out')
    const revision = authRevision
    return { owner, authorized: () => ownerCurrent && revision === authRevision }
  }, {
    preloadPath: join(output, 'voice-preload.cjs'),
    onPage: ({ accountId, webContents }) => { pages.set(accountId, webContents); webContents.setBackgroundThrottling(false); webContents.on('preload-error', (_e, _path, error) => failures.push(error.message)) },
    onUnread: (accountId, count) => { if (count === null) clearAccountUnread(accountId); else updateAccountUnread(accountId, count); shell.webContents.send('accounts:unread', { accountId, count: count ?? 0 }) },
    notify: (id, authorized) => notifications.push({ id, authorized })
  })
  workspace.setBounds({ x: 0, y: 0, width: 720, height: 650 })
  await workspace.focus(A)
  await until(() => accountUnreadSnapshot()[A] === 1, 'visible official badge through real child-view IPC')
  await until(async () => await page(shell.webContents, `unread[${JSON.stringify(A)}]`) === 1, 'shell receives unread event')
  assert.deepEqual(await page(shell.webContents, 'desktopAPI.getAccountUnread()'), { [A]: 1 })
  assert.equal(notifications.length, 0)
  checks.push('Actual sandboxed Voice preload crosses registered WebContentsView senderFrame authorization into desktop unread store and real shell preload event/snapshot; initial baseline is silent')

  const a = pages.get(A)
  assert.equal(await page(a, `typeof require+':'+typeof ipcRenderer+':'+typeof desktopAPI`), 'undefined:undefined:undefined')
  assert.ok(reports.every(report => report.source === 'sms-navigation' && (report.count === null || Number.isSafeInteger(report.count))))
  checks.push('Official synthetic page cannot access Node or either IPC bridge; report transport contains only numeric count and bounded lifecycle metadata')

  workspace.hide()
  await page(a, `document.querySelector('.mat-badge-content').textContent='2';document.title='Voice - (2) Messages'`)
  await until(() => accountUnreadSnapshot()[A] === 2, 'hidden account increase')
  await until(async () => await page(shell.webContents, `unread[${JSON.stringify(A)}]`) === 2, 'hidden account shell badge')
  assert.equal(notifications.length, 1); assert.equal(notifications[0].id, A); assert.equal(notifications[0].authorized(), true)
  checks.push('Switching away preserves hidden view reports and routes one authorized increase to that account rather than losing its shell badge')

  await workspace.focus(B)
  await until(() => accountUnreadSnapshot()[B] === 3, 'collapsed official Messages title through real IPC')
  await until(async () => await page(shell.webContents, `unread[${JSON.stringify(B)}]`) === 3, 'collapsed shell badge')
  assert.deepEqual(accountUnreadSnapshot(), { [A]: 2, [B]: 3 }); assert.equal(notifications.length, 1)
  checks.push('Collapsed navigation with strict official title contributes its unread count through the actual production preload and IPC without changing another account or announcing an initial baseline')

  const aEvent = activeEvents.get(a.id)
  await a.loadURL('https://accounts.google.com/fixture')
  assert.throws(() => workspace.observeUnread(aEvent, { source: 'sms-navigation', documentId: randomUUID(), sequence: 1, count: 99 }), /变化|主页面|打开/)
  const beforeAuth = reports.filter(report => report.contentsId === a.id).length
  await pause(900)
  assert.equal(reports.filter(report => report.contentsId === a.id).length, beforeAuth)
  checks.push('Navigating an actual registered child to Google Accounts invalidates prior sender authorization and the authentication page emits no new unread IPC')

  const rogueSession = session.fromPartition('fixture-unregistered-' + randomUUID())
  rogueSession.protocol.handle('https', () => new Response(syntheticHtml(9), { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const rogue = new BrowserWindow({ show: false, webPreferences: { session: rogueSession, preload: join(output, 'voice-preload.cjs'), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  await rogue.loadURL('https://voice.google.com/u/0/messages')
  await until(() => reports.some(report => report.contentsId === rogue.webContents.id), 'unregistered actual IPC refusal')
  assert.ok(reports.filter(report => report.contentsId === rogue.webContents.id).every(report => !report.accepted))
  assert.deepEqual(accountUnreadSnapshot(), { [A]: 2, [B]: 3 }); rogue.destroy()
  checks.push('An unregistered actual Voice-origin window cannot inject unread counts even with the same production preload')

  await workspace.close(A)
  await until(async () => await page(shell.webContents, `unread[${JSON.stringify(A)}]`) === 0, 'closed account badge cleared')
  assert.deepEqual(accountUnreadSnapshot(), { [B]: 3 }); assert.equal(notifications[0].authorized(), false)
  checks.push('Closing one account clears its shell badge and store entry, revokes its pending notification action and preserves the other account')

  const b = pages.get(B)
  await page(b, `document.title='Voice - Messages'`)
  await until(() => accountUnreadSnapshot()[B] === 0, 'collapsed zero through actual IPC')
  await until(async () => await page(shell.webContents, `unread[${JSON.stringify(B)}]`) === 0, 'zero clears collapsed badge')
  checks.push('Observed zero title in a collapsed layout clears that account count over the same real preload/IPC/renderer path')

  ownerCurrent = false; authRevision++; await workspace.detachAll()
  assert.deepEqual(accountUnreadSnapshot(), {})
  assert.deepEqual(failures, [])
  checks.push('Owner logout destroys isolated child views and clears all shared unread entries without any real messages, provider calls or billing')
  writeFileSync(join(output, 'unread-electron.json'), JSON.stringify({ runId, at: new Date().toISOString(), electron: process.versions.electron, passed: true, checks, realWorkspace: true, realEmbeddedViews: true, realVoicePreload: true, realShellPreload: true, productionIpcRegistrationMirrored: true, acceptedReports: reports.filter(report => report.accepted).length, notificationCallbacks: notifications.length, actualNativeToasts: false, realNetwork: false, realAccounts: false, realMessages: false, realCharges: false }, null, 2)); app.exit(0)
}).catch(async error => {
  console.error(error.stack)
  writeFileSync(join(output, 'unread-electron.json'), JSON.stringify({ runId, passed: false, checks, failure: error.message, preloadErrors: failures, reports, snapshot: accountUnreadSnapshot() }, null, 2))
  // Retire real child views even on an intentional baseline failure; otherwise
  // Chromium can retain their offscreen renderer until the runner's timeout.
  try { await workspace?.detachAll() } catch { /* retain original assertion */ }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  app.exit(1)
})
