import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/google-voice-page-state-20260921')
await mkdir(output, { recursive: true })
const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' }
await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/preload/googleVoice.ts')], outfile: resolve(output, 'voice-preload.cjs') })
await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(output, 'shell-preload.cjs') })
await esbuild.build({ ...common, stdin: { contents: `export { GoogleVoiceWorkspace } from './src/main/platforms/googleVoice/workspace'; export { googleVoiceEmbeddedPartition } from './src/main/platforms/googleVoice/embeddedViews'; export { GoogleVoiceEmbeddedTranslation } from './src/main/platforms/googleVoice/embeddedTranslation';`, resolveDir: root }, outfile: resolve(output, 'main-page-state.cjs') })
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const runId = randomUUID(), child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/google-voice-page-state-electron.cjs'), output, runId], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 55000)
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer); await writeFile(resolve(output, 'page-state-electron.log'), log)
const report = await readFile(resolve(output, 'page-state-electron.json'), 'utf8').then(JSON.parse).catch(() => null)
const passed = exit === 0 && report?.runId === runId && report.passed === true && report.checks?.length === 7
console.log(JSON.stringify({ exitCode: exit, passed, checks: report?.checks?.length, evidence: output }))
if (!passed) console.log(log.slice(-6000))
process.exitCode = passed ? 0 : 1
