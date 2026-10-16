import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { root, requireMacArm64 } from './macos-build-common.mjs'

// Version-specific decisions for install scripts in the frozen root/test locks.
// esbuild installs and verifies its matching platform executable. Windows
// installer tooling is present transitively but must not execute on the Mac.
export const rootBuildPolicy = {
  strictDepBuilds: true,
  allowBuilds: {
    'electron@44.3.0': true,
    'esbuild@0.25.12': true,
    'esbuild@0.28.2': true,
    'electron-winstaller@5.4.0': false
  }
}
export const testBuildPolicy = { strictDepBuilds: true, allowBuilds: { 'esbuild@0.25.12': true } }

export function signalMacBuildPolicy(input) {
  let text = input.replace(/\r\n/g, '\n')
  if (!/^strictDepBuilds: true$/m.test(text) || !/^allowBuilds:$/m.test(text)) throw new Error('Pinned Signal dependency policy changed; re-review required.')
  // Keep all upstream provenance, release-age, integrity and disabled-build
  // settings. Only update reviewed native dependencies to their locked versions.
  for (const [from, to] of [
    ["  '@indutny/mac-screen-share@1.0.13': true", "  '@indutny/mac-screen-share@1.2.5': true"],
    ["  '@indutny/simple-windows-notifications@2.0.16': true", "  '@indutny/simple-windows-notifications@2.0.21': false"],
    ["  '@signalapp/ringrtc@2.69.4': true", "  '@signalapp/ringrtc@2.71.0': true"],
    ["  'electron@43.0.0': true", "  'electron@43.5.0': true"]
  ]) {
    if (text.includes(to)) continue
    if (!text.includes(from)) throw new Error('Pinned Signal allowBuilds anchor changed; re-review required.')
    text = text.replace(from, to)
  }
  // The RingRTC installer verifies the prebuild archive against the package's
  // published SHA-256. Do not retain a package-wide future-version approval.
  text = text.replace(/^  '@signalapp\/ringrtc': true\n/m, '')
  return text
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireMacArm64()
  if (process.argv[2] === 'signal') {
    const file = join(root, 'integrations/signal-desktop/pnpm-workspace.yaml')
    await writeFile(file, signalMacBuildPolicy(await readFile(file, 'utf8')))
  } else if (!process.argv[2] || process.argv[2] === 'root') {
    // JSON is a YAML subset. These files only exist in the ephemeral Mac build
    // checkout; refuse to replace any existing project dependency policy.
    await writeFile(join(root, 'pnpm-workspace.yaml'), JSON.stringify(rootBuildPolicy, null, 2) + '\n', { flag: 'wx' })
    await writeFile(join(root, 'tests/pnpm-workspace.yaml'), JSON.stringify(testBuildPolicy, null, 2) + '\n', { flag: 'wx' })
  } else throw new Error('Unknown Mac dependency policy scope.')
  console.log('Applied version-scoped Mac install-script policy; strict dependency checks remain enabled.')
}
