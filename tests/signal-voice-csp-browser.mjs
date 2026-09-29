import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Synthetic audio only. Exercise Signal's actual CSP with real Blob fetch and
// WebAudio decoding, without starting Signal or accessing an account profile.
const require = createRequire(import.meta.url)
const { _electron } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const checkoutArg = process.argv.find(value => value.startsWith('--checkout='))
assert.ok(checkoutArg, 'Pass the isolated Signal checkout explicitly')
const checkout = resolve(checkoutArg.slice('--checkout='.length))
const html = await readFile(join(checkout, 'background.html'), 'utf8')
const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1].replace(/\s+/g, ' ').trim()
assert.ok(csp)
assert.match(csp, /connect-src [^;]*blob:/)
assert.match(csp, /default-src 'none'/)
assert.match(csp, /frame-src 'none'/)
const source = await readFile(join(checkout, 'ts/hellodog/hellodog.voice-audio.std.ts'), 'utf8')
const exports = {}
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Uint8Array })
const { voiceAudioWav, validateVoiceWav } = exports
const directory = join(checkout, 'hellodog-verification/voice-csp')
await mkdir(directory, { recursive: true })
const original = csp.replace(/connect-src ([^;]+)/, (_, values) => 'connect-src ' + values.split(' ').filter(value => value !== 'blob:').join(' '))
for (const [name, policy] of [['without-blob', original], ['native-production', csp]]) {
  await writeFile(join(directory, name + '.html'), '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '"><body>Local synthetic Signal audio test</body>')
}
await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(__dirname,'without-blob.html'));});`)
const electron = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(directory, 'main.cjs')], env: { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }, timeout: 30000 })
const checks = []
try {
  const page = await electron.firstWindow(), requests = []
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
  for (const name of ['without-blob', 'native-production']) {
    await page.goto(pathToFileURL(join(directory, name + '.html')).href, { waitUntil: 'load' })
    await page.evaluate(() => {
      const samples = 3200, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer)
      for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
      view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true)
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * .09) * 12000), true)
      window.__voiceUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      window.__violations = []
      document.addEventListener('securitypolicyviolation', event => window.__violations.push({ directive: event.effectiveDirective, blockedUri: event.blockedURI }))
    })
    const result = await page.evaluate(`(async()=>{const decode=${voiceAudioWav.toString()};try{const decoded=await decode(window.__voiceUrl);return{success:true,bytes:Array.from(decoded),violations:window.__violations,nodeIntegration:typeof window.require}}catch(error){await new Promise(resolve=>setTimeout(resolve,25));return{success:false,error:error.message,violations:window.__violations,nodeIntegration:typeof window.require}}finally{URL.revokeObjectURL(window.__voiceUrl)}})()`)
    if (result.success) {
      const bytes = new Uint8Array(result.bytes)
      validateVoiceWav(bytes)
      delete result.bytes
      result.canonicalPcmValidated = true
      result.byteLength = bytes.length
    }
    checks.push({ name, ...result })
  }
  assert.equal(checks[0].success, false, 'Negative control must reproduce the CSP failure')
  assert.ok(checks[0].violations.some(value => value.directive === 'connect-src'))
  assert.equal(checks[1].success, true)
  assert.equal(checks[1].nodeIntegration, 'undefined')
  assert.deepEqual(requests, [])
  const result = { passed: true, at: new Date().toISOString(), checkout, nativeCsp: csp, checks, actualBlobFetch: true, actualWebAudioDecode: true, providerCalls: 0, realChatSends: 0 }
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await electron.close() }
