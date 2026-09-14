import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, readFile, writeFile, readdir, cp, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(repo, 'verification', 'signal-bundle-downloads')
const bundle = join(repo, 'resources', 'signal')
const artifacts = [
  { name: 'signal-cli-0.14.7.tar.gz', version: '0.14.7', size: 120235141, sha256: '0e1eefdf4a2109edf7c899c9d1667167c54ac12c3ec824f27db7c1dac4fa7506', url: 'https://github.com/AsamK/signal-cli/releases/download/v0.14.7/signal-cli-0.14.7.tar.gz' },
  { name: 'temurin-jre25.zip', version: '25.0.4.1+1', size: 58475080, sha256: '4c95451cea98556def2c54f7782933f52a26d4a36bd85e1d59f0364464828b07', url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip' }
]
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function download(item) {
  const file = join(cache, item.name)
  if (await stat(file).catch(() => false)) {
    if (await sha256(file) === item.sha256) return file
    throw new Error(`Existing archive has the wrong checksum: ${item.name}`)
  }
  const partial = file + '.partial'
  for (let attempt = 0; attempt < 5; attempt++) {
    let received = (await stat(partial).catch(() => ({ size: 0 }))).size
    if (received === item.size) break
    const controller = new AbortController()
    let idle = setTimeout(() => controller.abort(), 45000)
    let previous = -1
    try {
      const response = await fetch(item.url, { headers: received ? { Range: `bytes=${received}-` } : {}, signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${item.name}`)
      if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new Error('Incorrect download range')
      if (response.status === 200) received = 0
      const stream = Readable.fromWeb(response.body)
      stream.on('data', chunk => {
        received += chunk.length
        clearTimeout(idle); idle = setTimeout(() => controller.abort(), 45000)
        const percent = Math.floor(received / item.size * 10) * 10
        if (percent !== previous) { previous = percent; process.stdout.write(`${item.name}: ${percent}%\n`) }
      })
      await pipeline(stream, createWriteStream(partial, { flags: response.status === 206 ? 'a' : 'w' }))
      break
    } catch (error) { if (attempt === 4) throw error }
    finally { clearTimeout(idle) }
  }
  if ((await stat(partial)).size !== item.size || await sha256(partial) !== item.sha256) throw new Error(`Archive verification failed: ${item.name}`)
  await rename(partial, file)
  return file
}
async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000) })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command}: ${error}`)))
  })
}
async function find(root, filename) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === filename) return path
    if (entry.isDirectory()) { const match = await find(path, filename); if (match) return match }
  }
}
await mkdir(cache, { recursive: true })
const files = await Promise.all(artifacts.map(download))
const staging = join(cache, 'extracted')
await mkdir(staging, { recursive: true })
for (const file of files) await run('tar.exe', ['-xf', file, '-C', staging])
const cli = await find(staging, 'signal-cli.bat'), java = await find(staging, 'java.exe')
if (!cli || !java) throw new Error('Required Windows runtime files are missing')
await mkdir(bundle, { recursive: true })
for (const name of ['bin', 'lib']) await cp(join(dirname(dirname(cli)), name), join(bundle, name), { recursive: true })
await cp(dirname(dirname(java)), join(bundle, 'jre'), { recursive: true })
await writeFile(join(bundle, 'runtime-bundle.json'), JSON.stringify({ artifacts, verifiedAt: new Date().toISOString() }, null, 2))
const license = await readFile(join(bundle, 'signal-cli-LICENSE.txt'), 'utf8')
if (!license.includes('GNU GENERAL PUBLIC LICENSE')) throw new Error('Signal license notice is missing')
await writeFile(join(bundle, 'SOURCE.txt'), 'signal-cli 0.14.7, GPL-3.0\nSource: https://github.com/AsamK/signal-cli/tree/v0.14.7\nSource archive: https://github.com/AsamK/signal-cli/archive/refs/tags/v0.14.7.tar.gz\nJava: Eclipse Temurin 25.0.4.1+1; notices and license files included in jre/legal.\nNo Signal account keys or chat data are included.\n')
if (!relative(cache, staging).startsWith('..')) await rm(staging, { recursive: true, force: true })
process.stdout.write('Verified Signal and Java components prepared for offline installation.\n')
