import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/google-voice-preload-20260920')
await mkdir(output, { recursive: true })
// Test-only observation in the isolated world. The official page's world cannot
// see these roots, and production preload contains no fixture instrumentation.
const instrumentation = `globalThis.__fixtureRoots=[]; const originalAttach=Element.prototype.attachShadow; Element.prototype.attachShadow=function(options){const root=originalAttach.call(this,options);globalThis.__fixtureRoots.push(root);return root};\n`
await esbuild.build({ entryPoints: [resolve(root, 'src/preload/googleVoice.ts')], outfile: resolve(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
const compiled = await readFile(resolve(output, 'preload.cjs'), 'utf8')
await writeFile(resolve(output, 'preload.cjs'), instrumentation + compiled)
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/google-voice-preload-electron.cjs'), output], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 60000)
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer); await writeFile(resolve(output, 'preload-fixture.log'), log)
console.log(JSON.stringify({ exitCode: exit, evidence: output })); if (exit !== 0) console.log(log.slice(-6000))
process.exitCode = exit ?? 1
