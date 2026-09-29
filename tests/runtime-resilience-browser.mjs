import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/google-voice-runtime-resilience')
await mkdir(output, { recursive: true })
// Fault controls exist only in this isolated fixture world. The production
// runtime, adapter and health parser are imported without modifying their code.
const entry = `
import { ipcRenderer } from 'electron';
import { installGoogleVoiceRuntime } from './integrations/google-voice-extension/content-runtime.js';
import { GoogleVoiceDomAdapter } from './integrations/google-voice-extension/voice-adapter.mjs';
import { parseGoogleVoiceRuntimeHealth } from './src/shared/googleVoiceRuntimeHealth';
globalThis.__fixtureFault = new URL(location.href).searchParams.get('fault') || '';
const originalRefresh = GoogleVoiceDomAdapter.prototype.refresh;
GoogleVoiceDomAdapter.prototype.refresh = async function(...args) {
  if(globalThis.__fixtureFault === 'composer') throw Error('fixture private error +15555550123 https://synthetic.invalid/private');
  return originalRefresh.apply(this,args);
};
const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = function(algorithm,bytes) {
  if(globalThis.__fixtureFault === 'message-digest' && new TextDecoder().decode(bytes).includes('fixture private body')) return Promise.reject(Error('fixture private digest +15555550123'));
  return originalDigest(algorithm,bytes);
};
globalThis.__fixtureRuntime = installGoogleVoiceRuntime({
  sendRequest: request => ipcRenderer.invoke('fixture:request', request),
  subscribe: listener => {const change = () => listener({v:1,type:'voice.connection-changed'});ipcRenderer.on('fixture:context-changed', change);return()=>ipcRenderer.removeListener('fixture:context-changed', change)},
  onHealth: input => {const value = parseGoogleVoiceRuntimeHealth(input);if(!value)throw Error('Invalid health shape');return ipcRenderer.invoke('fixture:health',value)}
});
`
await esbuild.build({ stdin: { contents: entry, resolveDir: root }, outfile: resolve(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const runId = randomUUID()
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/runtime-resilience-electron.cjs'), output, runId], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 60000)
const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
clearTimeout(timer); await writeFile(resolve(output, 'fixture.log'), log)
const report = await readFile(resolve(output, 'fixture.json'), 'utf8').then(JSON.parse).catch(() => null)
const passed = exit === 0 && report?.runId === runId && report.passed === true && report.checks?.length === 12
console.log(JSON.stringify({ exitCode: exit, passed, checks: report?.checks?.length, evidence: output })); if (!passed) console.log(log.slice(-6000))
process.exitCode = passed ? 0 : 1
