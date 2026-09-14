import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// This preflight never runs Signal, opens an account database, or installs tools.
const root = fileURLToPath(new URL('..', import.meta.url))
const lock = JSON.parse(readFileSync(join(root, 'integrations/signal-desktop.lock.json'), 'utf8'))
const source = join(root, 'integrations/signal-desktop')
const command = (file, args) => {
  const result = spawnSync(file, args, { cwd: source, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  return result.status === 0 ? result.stdout.trim() : ''
}
if (!existsSync(join(source, 'package.json'))) throw Error('Clone the pinned Signal Desktop tag into integrations/signal-desktop first.')
const upstream = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const commit = command('git', ['rev-parse', 'HEAD'])
if (commit !== lock.commit || upstream.version !== lock.tag.slice(1) || upstream.engines.node !== lock.node
  || upstream.packageManager !== lock.packageManager || upstream.devDependencies.electron !== lock.electron) throw Error('Signal Desktop source does not match the reviewed lock.')
for (const entry of Object.values(lock.featureEntryPoints)) if (!existsSync(join(source, entry))) throw Error('Missing feature entry: ' + entry)
const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
const visualStudio = process.platform === 'win32' && existsSync(vswhere)
  ? command(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']) : ''
const compilerOnPath = process.platform === 'win32' && command('where.exe', ['cl.exe'])
const blocks = []
if (process.versions.node !== lock.node) blocks.push('Build with the upstream-pinned Node.js ' + lock.node + '; current process is ' + process.versions.node + '.')
if (process.platform === 'win32' && !visualStudio && !compilerOnPath) blocks.push('Visual Studio C++ build tools were not found through the standard installer inventory or PATH.')
if (!existsSync(join(source, 'node_modules'))) blocks.push('Official native and JavaScript dependencies have not been installed in this checkout.')
const report = {
  checkedAt: new Date().toISOString(), repository: lock.repository, tag: lock.tag, commit, sourceVerified: true,
  license: lock.license, upstreamNode: lock.node, upstreamElectron: lock.electron,
  featureEntryPoints: lock.featureEntryPoints, nativeDependencies: lock.nativeDependencies,
  readyForBuild: blocks.length === 0, buildAttempted: false, blocks,
  bundleConfigured: lock.bundledInHelloDog === true, coreBinaryPresent: existsSync(join(source,'release/hellodog-core/win-unpacked/Signal.exe')), fullFeatureParityVerified: false, openedAccountData: false, networkMessagesSent: 0,
  nextIntegrationChecks: ['Official core isolated startup', 'Per-account encrypted data directories', 'Host window and focus integration', 'Translation hook preserving native send queue', 'Media, stickers, GIF and device permissions', 'Phone-linked real send, receive and calls', 'License notices and corresponding source distribution']
}
mkdirSync(join(root, 'verification'), { recursive: true })
writeFileSync(join(root, 'verification/signal-core-source-inventory.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ sourceVerified: true, tag: lock.tag, readyForBuild: report.readyForBuild, blocks, bundleConfigured: report.bundleConfigured, coreBinaryPresent: report.coreBinaryPresent }, null, 2))
