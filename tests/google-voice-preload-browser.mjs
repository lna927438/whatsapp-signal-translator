import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/google-voice-preload-20260920')
await mkdir(output, { recursive: true })
// Test-only observation in the isolated world. The official page's world cannot
// see these roots, and production preload contains no fixture instrumentation.
const instrumentation = `globalThis.__fixtureRoots=[]; const originalAttach=Element.prototype.attachShadow; Element.prototype.attachShadow=function(options){const root=originalAttach.call(this,options);globalThis.__fixtureRoots.push(root);return root}; globalThis.__fixtureFrames={requested:0,completed:0}; const originalFrame=requestAnimationFrame.bind(globalThis);globalThis.requestAnimationFrame=function(callback){__fixtureFrames.requested++;return originalFrame(time=>{__fixtureFrames.completed++;callback(time)})};globalThis.__fixtureMediaSignals=0;globalThis.addEventListener('hellodog-voice-draft-ready',()=>__fixtureMediaSignals++);\n`
await esbuild.build({ entryPoints: [resolve(root, 'src/preload/googleVoice.ts')], outfile: resolve(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
const compiled = await readFile(resolve(output, 'preload.cjs'), 'utf8')
await writeFile(resolve(output, 'preload.cjs'), instrumentation + compiled)
await esbuild.build({ stdin: { contents: `export { GoogleVoiceEmbeddedTranslation } from './src/main/platforms/googleVoice/embeddedTranslation'; export { GoogleVoiceDispatchLedger } from './src/main/platforms/googleVoice/dispatchLedger'; export { createGoogleVoiceTranslator } from './src/main/platforms/googleVoice/translationBridge';`, resolveDir: root }, outfile: resolve(output, 'main-media-bridge.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const runId = randomUUID()
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/google-voice-preload-electron.cjs'), output, runId], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 60000)
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer); await writeFile(resolve(output, 'preload-fixture.log'), log)
const report = await readFile(resolve(output, 'preload-fixture.json'), 'utf8').then(JSON.parse).catch(() => null)
const passed = exit === 0 && report?.runId === runId && report.passed === true && report.checks?.length === 18
console.log(JSON.stringify({ exitCode: exit, passed, checks: report?.checks?.length, evidence: output })); if (!passed) console.log(log.slice(-6000))
process.exitCode = passed ? 0 : 1
