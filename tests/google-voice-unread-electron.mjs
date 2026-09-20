import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const baselineRef = process.argv.find(value => value.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length)
if (baselineRef && !/^[a-f0-9]{40}$/.test(baselineRef)) throw new Error('Baseline must be a full commit ID')
const output = resolve(root, 'verification/google-voice-unread-electron-20260920' + (baselineRef ? '-baseline-' + baselineRef.slice(0, 12) : ''))
await mkdir(output, { recursive: true })
const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' }
// Optional red/green proof changes only the fixture bundle's parser; source,
// real profiles and other components are untouched.
const plugins = baselineRef ? [{ name: 'historical-unread-parser', setup(build) { build.onLoad({ filter: /[\\/]src[\\/]preload[\\/]googleVoiceUnread\.ts$/ }, () => ({ contents: execFileSync('git', ['show', baselineRef + ':src/preload/googleVoiceUnread.ts'], { cwd: root, encoding: 'utf8' }), loader: 'ts' })) } }] : []
await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/preload/googleVoice.ts')], outfile: resolve(output, 'voice-preload.cjs'), plugins })
await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(output, 'shell-preload.cjs') })
await esbuild.build({ ...common, stdin: { contents: `export { GoogleVoiceWorkspace } from './src/main/platforms/googleVoice/workspace'; export { googleVoiceEmbeddedPartition } from './src/main/platforms/googleVoice/embeddedViews'; export { accountUnreadSnapshot, updateAccountUnread, clearAccountUnread } from './src/main/desktopRuntime';`, resolveDir: root }, outfile: resolve(output, 'main-unread.cjs') })
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const runId = randomUUID(), child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/google-voice-unread-electron.cjs'), output, runId], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 75000)
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer); await writeFile(resolve(output, 'unread-electron.log'), log)
const report = await readFile(resolve(output, 'unread-electron.json'), 'utf8').then(JSON.parse).catch(() => null)
const passed = exit === 0 && report?.runId === runId && report.passed === true && report.checks?.length === 9
console.log(JSON.stringify({ exitCode: exit, passed, checks: report?.checks?.length, evidence: output }))
if (!passed) console.log(log.slice(-6000))
process.exitCode = passed ? 0 : 1
