import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const checkout = await realpath(resolve(root, 'integrations/signal-desktop'))
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar')
const expected = JSON.parse(await readFile(resolve(root, 'security/vendor-patches/signal-uuid.json'), 'utf8'))
const patch = await readFile(resolve(root, 'security/vendor-patches/uuid@13.0.0.patch'))
assert.equal(createHash('sha256').update(patch).digest('hex'), expected.patchSha256, 'Maintained patch changed without review')
assert.deepEqual(await readFile(resolve(checkout, 'patches/uuid@13.0.0.patch')), patch, 'Signal dependency patch is missing')
const uuidRoot = resolve(checkout, 'node_modules/uuid')
const { v3, v5, v6 } = await import(pathToFileURL(resolve(uuidRoot, 'dist/index.js')).href)
const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
for (const fn of [v3, v5]) {
  for (const [size, offset] of [[15, 0], [16, -1], [16, 1]]) assert.throws(() => fn('local-check', namespace, new Uint8Array(size), offset), RangeError)
  assert.equal(fn('local-check', namespace, new Uint8Array(16)).length, 16)
}
for (const [size, offset] of [[15, 0], [16, -1], [16, 1]]) assert.throws(() => v6({}, new Uint8Array(size), offset), RangeError)
assert.equal(v6({}, new Uint8Array(16)).length, 16)
if (!process.argv.includes('--source-only')) {
  const archive = resolve(checkout, 'release/hellodog-security-core/win-unpacked/resources/app.asar')
  for (const file of ['dist/v35.js', 'dist/v6.js', 'dist-node/v35.js', 'dist-node/v6.js']) {
    const packaged = asar.extractFile(archive, join('node_modules', 'uuid', ...file.split('/')))
    assert.deepEqual(packaged, await readFile(resolve(uuidRoot, file)), 'Packaged UUID differs from tested dependency: ' + file)
    assert.ok(packaged.toString().includes(expected.upstreamCommit), 'Security backport absent from package')
  }
}
console.log(JSON.stringify({ passed: true, package: expected.package, upstreamCommit: expected.upstreamCommit, packaged: !process.argv.includes('--source-only') }))
