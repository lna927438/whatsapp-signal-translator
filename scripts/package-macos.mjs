import { access, copyFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root, requireMacArm64, run } from './macos-build-common.mjs'
requireMacArm64()
const output = join(root, 'release/macos-arm64')
if (await access(output).then(() => true, () => false) && (await readdir(output)).length) throw new Error('Mac acceptance output must be new or empty; previous artifacts are preserved.')
await run(process.execPath, ['scripts/release-gate.mjs', '--local'])
await run('pnpm', ['typecheck'])
// The existing Vite public-auth guard rejects missing and privileged credentials.
await run('pnpm', ['build'])
await run('pnpm', ['exec', 'electron-builder', '--config', 'scripts/macos-builder.cjs', '--mac', '--arm64', '--publish', 'never'], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
await run('python3', ['scripts/export-signal-source.py'])
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
await copyFile(join(root, 'release', `HelloDog-${version}-corresponding-source.zip`), join(output, `HelloDog-${version}-mac-arm64-preview-corresponding-source.zip`))
await copyFile(join(root, 'verification/macos-resources/WHISPER-SMOKE.json'), join(output, 'WHISPER-SMOKE.json'))
await run(process.execPath, ['scripts/verify-macos-package.mjs'])
