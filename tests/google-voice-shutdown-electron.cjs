// Real Electron lifecycle regression, using only synthetic local page responses.
// Run: electron tests/google-voice-shutdown-electron.cjs <results.json> [close|destroy|quit] [empty]
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs')
const { resolve, dirname, join } = require('node:path')
const { createRequire } = require('node:module')
const root = resolve(__dirname, '..'), localRequire = createRequire(join(root, 'package.json')), ts = localRequire('typescript')
const output = process.argv[2], mode = process.argv[3] || 'close', empty = process.argv[4] === 'empty'
const profile = mkdtempSync('D:/UserAppData/Temp/hellodog-shutdown-'), modules = new Map(), errors = [], pages = [], checks = []
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
app.on('window-all-closed', () => {})
app.on('session-created', ses => {
  ses.protocol.handle('https', () => new Response('<!doctype html><title>Synthetic shutdown fixture</title><body>Local page only</body>', { headers: { 'content-type': 'text/html' } }))
})
function load(file) {
  const path = resolve(root, file.endsWith('.ts') ? file : file + '.ts')
  if (modules.has(path)) return modules.get(path)
  const exports = {}; modules.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'exports', '__dirname', code)(name => name.startsWith('.') ? load(resolve(dirname(path), name)) : localRequire(name), exports, dirname(path))
  return exports
}
function recordError(error) { errors.push({ message: String(error), stack: error?.stack }) }
function report(passed) {
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({ passed, mode, empty, electron: process.versions.electron, profile, checks, errors }, null, 2))
}
process.on('uncaughtException', recordError)
process.on('unhandledRejection', recordError)
const watchdog = setTimeout(() => { recordError(new Error('Shutdown fixture timed out')); report(false); app.exit(1) }, 15000)
app.whenReady().then(async () => {
  const { GoogleVoiceWorkspace } = load('src/main/platforms/googleVoice/workspace.ts')
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const contents = window.webContents
  let closed = false, getterThrows = false
  window.once('closed', () => { closed = true; try { void window.webContents } catch { getterThrows = true } })
  const rows = [1, 2].map(value => ({ id: `gv-${value}0000000-0000-4000-8000-00000000000${value}`, label: 'Synthetic ' + value, closed: false }))
  const workspace = new GoogleVoiceWorkspace(window, { get: async (_owner, id) => rows.find(row => row.id === id) }, () => ({ owner: 'synthetic-shutdown-owner', authorized: () => true }), { onPage: ({ webContents }) => pages.push(webContents) })
  if (!empty) { for (const row of rows) await workspace.focus(row.id); assert.equal(pages.length, 2) }
  const verify = () => {
    assert.equal(closed, true)
    assert.equal(getterThrows, true, 'Real Electron must exercise the destroyed BrowserWindow getter')
    assert.equal(contents.listenerCount('zoom-changed'), 0, 'Workspace zoom listener is removed without accessing the destroyed parent')
    assert.ok(pages.every(page => page.isDestroyed()), 'Every embedded WebContents is destroyed')
    assert.ok(rows.every(row => !row.closed), 'Closing the application preserves account records')
    assert.deepEqual(errors, [], 'No uncaught main-process exception or rejected cleanup')
    checks.push('Destroyed BrowserWindow getter exercised; listeners removed; child contents released; account records preserved')
  }
  if (mode === 'quit') {
    // Keep this fixture's process alive only to observe the asynchronous native
    // WebContents destruction, which can finish after the will-quit event.
    app.once('will-quit', event => {
      event.preventDefault()
      void (async () => {
        const deadline = Date.now() + 3000
        while (!pages.every(page => page.isDestroyed()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        verify(); clearTimeout(watchdog); report(true); app.exit(0)
      })().catch(error => { recordError(error); clearTimeout(watchdog); report(false); app.exit(1) })
    })
    app.quit()
  } else {
    try { if (mode === 'destroy') window.destroy(); else window.close() } catch (error) { recordError(error) }
    await new Promise(resolve => setTimeout(resolve, 100))
    verify(); clearTimeout(watchdog); report(true); app.exit(0)
  }
}).catch(error => { recordError(error); clearTimeout(watchdog); report(false); app.exit(1) })
