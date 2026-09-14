import { readFile, copyFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const checkout = await realpath(resolve(root, 'integrations/signal-desktop'))
const base = resolve(root, 'security/vendor-patches')
const metadata = JSON.parse(await readFile(resolve(base, 'signal-uuid.json'), 'utf8'))
const git = args => execFileSync('git', args, { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] })
if (git(['rev-parse', 'HEAD']).toString().trim() !== metadata.signalCommit) throw new Error('Re-review dependency patch for this Signal revision')
for (const [file, expected] of [['uuid@13.0.0.patch', metadata.patchSha256], ['signal-dependencies.patch', metadata.dependencyPatchSha256]]) {
  const hash = createHash('sha256').update(await readFile(resolve(base, file))).digest('hex')
  if (hash !== expected) throw new Error('Maintained security patch hash mismatch: ' + file)
}
const diff = resolve(base, 'signal-dependencies.patch')
let alreadyApplied = false
try { git(['apply', '--reverse', '--check', diff]); alreadyApplied = true } catch {}
if (!alreadyApplied) { git(['apply', '--check', diff]); git(['apply', diff]) }
await copyFile(resolve(base, 'uuid@13.0.0.patch'), resolve(checkout, 'patches/uuid@13.0.0.patch'))
console.log('Pinned Signal security dependencies prepared; provenance enforcement unchanged.')
