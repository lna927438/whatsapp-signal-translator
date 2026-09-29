import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'))
const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar')
const argument = process.argv.find(value => value.startsWith('--checkout='))
assert.ok(argument, 'Pass the isolated Signal checkout explicitly')
const checkout = resolve(argument.slice('--checkout='.length))
const upstreamRequire = createRequire(join(checkout, 'package.json'))
const { getCurrentFuseWire, FuseV1Options } = upstreamRequire('@electron/fuses')
const output = join(checkout, 'release/hellodog-security-core/win-unpacked')
const archive = join(output, 'resources/app.asar')
const packaged = file => asar.extractFile(archive, join(...file.split('/'))).toString()
const main = packaged('bundles/main.js'), preload = packaged('bundles/preload/main.js'), html = packaged('background.html')
for (const marker of ['hellodog:voice', 'voice-result', 'senderFrame', 'Signal 语音窗口已断开。']) assert.ok(main.includes(marker), 'Missing main bridge ' + marker)
for (const marker of ['hellodog:voice', '转为中文', 'data-hellodog-voice', 'message changed', 'audioBase64']) assert.ok(preload.includes(marker), 'Missing preload feature ' + marker)
assert.match(html, /connect-src [^;]*blob:/)
assert.match(html, /default-src 'none'/)
const sourcePolicy = (await readFile(join(checkout, 'background.html'), 'utf8')).match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
assert.equal(html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1], sourcePolicy)
const fuses = await getCurrentFuseWire(join(output, 'Signal.exe')), verifiedFuses = {}
for (const [name, value] of [['RunAsNode', 48], ['EnableCookieEncryption', 49], ['EnableNodeOptionsEnvironmentVariable', 48], ['EnableNodeCliInspectArguments', 48], ['EnableEmbeddedAsarIntegrityValidation', 49], ['OnlyLoadAppFromAsar', 49]]) {
  assert.equal(fuses[FuseV1Options[name]], value, name)
  verifiedFuses[name] = value === 49
}
execFileSync('git', ['-C', checkout, 'apply', '--reverse', '--check', join(root, 'security/vendor-patches/signal-dependencies.patch')], { stdio: 'pipe' })
const security = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/verify-signal-security.mjs'), '--checkout=' + checkout], { encoding: 'utf8' }).trim())
assert.equal(security.passed, true)
const hashes = {}
for (const name of ['Signal.exe', 'resources/app.asar']) hashes[name] = createHash('sha256').update(await readFile(join(output, name))).digest('hex')
const result = { passed: true, at: new Date().toISOString(), checkout, output, nativeVoiceBridge: true, nativeVoiceButton: true, localBlobCsp: true, fuses: verifiedFuses, security, dependencyPatchRetained: true, hashes }
await writeFile(join(checkout, 'hellodog-verification/package-verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
