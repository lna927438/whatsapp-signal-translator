// Run with the repository's bundled Node, optionally passing baseline or guarded.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const mode = process.argv[2] || 'baseline'
assert.ok(['baseline', 'guarded', 'ignored', 'injected-unguarded', 'injected-guarded'].includes(mode))
const output = join(root, 'verification', 'stdio-epipe-' + Date.now() + '-' + mode)
mkdirSync(output, { recursive: true })
if (mode === 'guarded' || mode === 'injected-guarded') {
  const ts = require('typescript')
  const code = ts.transpileModule(readFileSync(join(root, 'src/main/stdioGuard.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  writeFileSync(join(output, 'stdioGuard.cjs'), code)
}
const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'tests/stdio-epipe-electron.cjs'), output, mode], {
  cwd: root, windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' },
  stdio: mode === 'ignored' ? 'ignore' : ['ignore', 'pipe', 'pipe']
})
child.stdout?.resume(); child.stderr?.resume()
let ready = false, timedOut = false
const poll = setInterval(() => {
  if (ready || !existsSync(join(output, `${mode}-ready`))) return
  ready = true
  child.stdout?.destroy(); child.stderr?.destroy()
  setTimeout(() => writeFileSync(join(output, `${mode}-go`), ''), 100)
}, 20)
const timeout = setTimeout(() => { timedOut = true; child.kill() }, 20000)
const exitCode = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
clearInterval(poll); clearTimeout(timeout)
assert.equal(timedOut, false, 'The fixture must not hang')
assert.equal(ready, true, 'Electron loaded the local test renderer')
const result = JSON.parse(readFileSync(join(output, `${mode}-result.json`), 'utf8'))
writeFileSync(join(output, 'driver-result.json'), JSON.stringify({ mode, exitCode, passed: result.passed, ready, timedOut, output }, null, 2))
console.log(JSON.stringify({ ...result, exitCode, output }, null, 2))
if (mode.startsWith('injected-')) assert.equal(result.injectedWrites, 1, 'The controlled fault was exercised exactly once')
assert.equal(result.passed, true)
assert.equal(exitCode, 0)
