// Real Electron regression: IPC rejection logging after the launcher pipe closes.
// All pages are local and the profile belongs only to this fixture.
const { join, resolve } = require('node:path')
const { existsSync, mkdtempSync, writeFileSync } = require('node:fs')
const output = resolve(process.argv[2]), mode = process.argv[3] || 'baseline'
const injected = mode.startsWith('injected-')
let injectedWrites = 0
if (injected) {
  const stream = process.stderr, originalWrite = stream.write
  stream.write = function(chunk, ...args) {
    if (!String(chunk).includes('fixture:expected-rejection')) return originalWrite.call(this, chunk, ...args)
    injectedWrites++
    // Deliberately inject an asynchronous pipe error after console removes its
    // temporary listener. This models the reported failure, not a kernel repro.
    const error = Object.assign(new Error('write EPIPE: broken pipe'), { code: 'EPIPE', syscall: 'write' })
    queueMicrotask(() => stream.emit('error', error))
    return true
  }
}
if (mode.endsWith('guarded') && !mode.endsWith('unguarded')) require(join(output, 'stdioGuard.cjs'))
const { app, BrowserWindow, ipcMain } = require('electron')
const failures = [], checks = [], observed = []
let finished = false, window
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-stdio-fixture-'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
app.on('window-all-closed', () => {})
const report = passed => {
  if (finished) return
  finished = true
  writeFileSync(join(output, `${mode}-result.json`), JSON.stringify({ passed, mode, injectedWrites, electron: process.versions.electron, node: process.versions.node, consoleIgnoreErrors: console._ignoreErrors, stdoutType: process.stdout.constructor.name, stderrType: process.stderr.constructor.name, stderrDestroyed: process.stderr.destroyed, stderrErrorCode: process.stderr.errored?.code, failures, checks, observed, realNetwork: false, realAccounts: false, realMessages: false }, null, 2))
  app.exit(passed ? 0 : 1)
}
// Fixture only: capture the native popup error without displaying a blocking dialog.
process.on('uncaughtException', error => {
  failures.push({ code: String(error.code || ''), syscall: String(error.syscall || ''), replyWithError: String(error.stack).includes('replyWithError'), consoleError: String(error.stack).includes('console.error'), brokenPipe: String(error.message).includes('broken pipe') })
  setTimeout(() => report(mode === 'injected-unguarded' && failures.some(value => value.code === 'EPIPE' && value.replyWithError && value.consoleError)), 200)
})
process.on('unhandledRejection', error => {
  failures.push({ rejection: true, code: String(error?.code || '') })
  report(false)
})
setTimeout(() => { failures.push({ timeout: true }); report(false) }, 12000)
ipcMain.handle('fixture:expected-rejection', () => { throw Error('Synthetic expected IPC rejection') })
ipcMain.handle('fixture:subsequent-success', () => ({ ok: true }))
ipcMain.on('fixture:rejection-observed', (_event, value) => {
  observed.push(value)
  checks.push('The renderer received the original synthetic IPC rejection and a subsequent successful IPC result')
  setTimeout(() => report(mode !== 'injected-unguarded' && failures.length === 0 && value.expectedRejection === true && value.subsequentSuccess === true), 250)
})
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'stdio-epipe-preload.cjs') } })
  window.webContents.on('preload-error', () => { failures.push({ preloadError: true }); report(false) })
  await window.loadURL('data:text/html;charset=utf-8,%3Ctitle%3ESynthetic%20IPC%20fixture%3C%2Ftitle%3E')
  writeFileSync(join(output, `${mode}-ready`), '')
  if (mode === 'inherited') await new Promise(done => setTimeout(done, 3000))
  const poll = setInterval(() => {
    if (!existsSync(join(output, `${mode}-go`))) return
    clearInterval(poll)
    checks.push(mode === 'inherited' ? 'The launching PowerShell process exited before the rejected IPC request' : mode === 'ignored' ? 'The child started with ignored stdio and no launcher pipe dependency' : injected ? 'The fixture injected an asynchronous EPIPE when Electron logged the rejected IPC request' : 'The driver closed stdout and stderr before initiating a rejected IPC request')
    window.webContents.send('fixture:go')
  }, 20)
}).catch(() => { failures.push({ setupError: true }); report(false) })
