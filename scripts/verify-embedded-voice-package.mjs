import assert from 'node:assert/strict'
import { readFile, readdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = process.argv[2]
if (!output) throw new Error('Provide the directory containing win-unpacked.')
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const builder = createRequire(require.resolve('electron-builder'))
const runtime = createRequire(builder.resolve('app-builder-lib'))
const asar = runtime('@electron/asar'), fuses = runtime('@electron/fuses')
const resources = resolve(output, 'win-unpacked/resources'), archive = join(resources, 'app.asar')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, pkg.version)
let matchingFiles = 0
async function compare(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await compare(path)
    else {
      assert.equal(digest(asar.extractFile(archive, relative(root, path))), digest(await readFile(path)), relative(root, path))
      matchingFiles++
    }
  }
}
await compare(join(root, 'out'))
const preload = asar.extractFile(archive, join('out', 'preload', 'googleVoice.js')).toString()
assert.ok(preload.includes('google-voice:translate-request'))
assert.equal(digest(await readFile(join(resources, 'native/SignalWindowHost.exe'))), digest(await readFile(join(root, 'resources/native/SignalWindowHost.exe'))))
for (const retired of ['native/GoogleVoiceWindowHost.exe', 'native/GoogleVoiceMessagingHost.exe', 'google-voice-extension']) {
  await assert.rejects(access(join(resources, retired)), error => error.code === 'ENOENT', retired)
}
const wire = await fuses.getCurrentFuseWire(resolve(output, 'win-unpacked/HelloDog.exe'))
for (const key of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) assert.equal(wire[fuses.FuseV1Options[key]], 48, key)
for (const key of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) assert.equal(wire[fuses.FuseV1Options[key]], 49, key)
assert.ok((await readFile(join(resources, 'signal-source-notices/SOURCE.txt'), 'utf8')).includes('HelloDog ' + pkg.version))
console.log(JSON.stringify({ passed: true, version: pkg.version, matchingFiles, builtInVoicePreload: true, retiredExternalHostsAbsent: true, signalHostPreserved: true, securityFusesVerified: true, at: new Date().toISOString() }))
