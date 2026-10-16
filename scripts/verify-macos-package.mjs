import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { root, requireMacArm64, run, sha256 } from './macos-build-common.mjs'
requireMacArm64()
const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'))
const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar')
const output = join(root, 'release/macos-arm64'), application = join(output, 'mac-arm64/HelloDog.app'), resources = join(application, 'Contents/Resources')
const plist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(application, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(plist('CFBundleShortVersionString'), pkg.version)
assert.equal(plist('CFBundleIdentifier'), pkg.build.appId)
assert.ok(Number(plist('LSMinimumSystemVersion').split('.')[0]) >= 14, 'Mac bundle minimum OS is lower than the pinned native voice deployment target.')
const mainExecutable = join(application, 'Contents/MacOS', plist('CFBundleExecutable'))
assert.equal(execFileSync('lipo', ['-archs', mainExecutable], { encoding: 'utf8' }).trim(), 'arm64')
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', application])
const signing = spawnSync('codesign', ['--display', '--verbose=4', application], { encoding: 'utf8' })
assert.equal(signing.status, 0)
assert.match(signing.stderr, /Signature=adhoc/)
const archive = join(resources, 'app.asar'), bundled = JSON.parse(asar.extractFile(archive, 'package.json').toString())
assert.equal(bundled.version, pkg.version)
const main = asar.extractFile(archive, 'out/main/index.js').toString(), manifest = JSON.parse(await readFile(join(root, 'resources/voice/manifest.json'), 'utf8'))
assert.equal(manifest.platform, 'darwin'); assert.equal(manifest.arch, 'arm64'); assert.equal(manifest.executable, 'whisper-cli')
const voice = join(resources, 'voice')
assert.deepEqual((await readdir(voice)).sort(), Object.keys(manifest.files).sort())
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(await sha256(join(voice, name)), expected, `Packaged voice bytes changed: ${name}`)
  assert.ok(main.includes(expected), `Packaged main process is missing voice resource pin: ${name}`)
}
await run('codesign', ['--verify', '--strict', join(voice, manifest.executable)])
const signalApp = join(resources, 'signal-desktop/Signal.app'), signalArchive = join(signalApp, 'Contents/Resources/app.asar')
await run('codesign', ['--verify', '--deep', '--strict', signalApp])
assert.equal(execFileSync('lipo', ['-archs', join(signalApp, 'Contents/MacOS/Signal')], { encoding: 'utf8' }).trim(), 'arm64')
const nativeBindings = []
async function inspectBindings(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await inspectBindings(path)
    else if (entry.isFile() && entry.name.endsWith('.node')) {
      const architectures = execFileSync('lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/)
      assert.ok(architectures.includes('arm64'), `Signal native dependency lacks Apple Silicon code: ${entry.name}`)
      nativeBindings.push(path)
    }
  }
}
await inspectBindings(join(signalApp, 'Contents/Resources/app.asar.unpacked'))
for (const name of ['libsignal-client', 'sqlcipher', 'ringrtc']) assert.ok(nativeBindings.some(path => path.includes(name)), `Signal native dependency is missing: ${name}`)
assert.ok(asar.extractFile(signalArchive, 'bundles/main.js').toString().includes('HELLODOG_EMBEDDED'), 'Signal private bridge is missing.')
const signalRoot = join(root, 'integrations/signal-desktop')
for (const file of ['dist/v35.js', 'dist/v6.js', 'dist-node/v35.js', 'dist-node/v6.js']) assert.deepEqual(asar.extractFile(signalArchive, 'node_modules/uuid/' + file), await readFile(join(signalRoot, 'node_modules/uuid', file)), 'Packaged Signal UUID differs from verified maintained source.')
const rendererFiles = asar.listPackage(archive).filter(path => /^[/\\]out[/\\]renderer[/\\].+\.js$/.test(path))
const renderer = rendererFiles.map(path => asar.extractFile(archive, path.replace(/^[/\\]/, '')).toString()).join('\n')
for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
  const value = process.env[name]?.trim()
  assert.ok(value && renderer.includes(value), `Packaged public authentication configuration missing: ${name}`)
}
const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', application], { encoding: 'utf8' })
if (assessment.error) throw assessment.error
const artifacts = []
for (const name of (await readdir(output)).filter(name => /\.(dmg|zip)$/.test(name)).sort()) artifacts.push({ name, bytes: (await stat(join(output, name))).size, sha256: await sha256(join(output, name)) })
assert.equal(artifacts.filter(item => item.name.endsWith('.dmg')).length, 1)
assert.equal(artifacts.filter(item => item.name.endsWith('-preview.zip')).length, 1)
assert.equal(artifacts.filter(item => item.name.endsWith('-corresponding-source.zip')).length, 1)
const speechSmoke = JSON.parse(await readFile(join(output, 'WHISPER-SMOKE.json'), 'utf8'))
assert.equal(speechSmoke.passed, true); assert.equal(speechSmoke.expectedSpeechRecognized, true)
const report = { version: pkg.version, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), platform: 'darwin', arch: 'arm64', minimumSystemVersion: plist('LSMinimumSystemVersion'), acceptanceOnly: true, published: false, signing: 'ad-hoc', notarized: false, strictSignatureVerified: true, gatekeeperAccepted: assessment.status === 0, gatekeeperExitCode: assessment.status, gatekeeperAssessment: (assessment.stderr + assessment.stdout).slice(0, 4000), publicAuthEmbedded: true, voiceResourcesVerified: true, signalBridgeVerified: true, artifacts }
await writeFile(join(output, 'MAC-BUILD.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(output, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n')
console.log(JSON.stringify(report))
