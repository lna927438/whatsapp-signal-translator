import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const root = fileURLToPath(new URL('../', import.meta.url))
export function requireMacArm64() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This acceptance build requires a native Apple Silicon macOS runner.')
}
export function run(command, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options })
    child.once('error', fail)
    child.once('exit', (code, signal) => code === 0 ? ok() : fail(new Error(`${command} failed (${code ?? signal})`)))
  })
}
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function inside(parent, path) {
  const absolute = resolve(path), base = resolve(parent)
  if (absolute === base || !absolute.startsWith(base + '/')) throw new Error('Build path must remain inside the expected output directory.')
  return absolute
}
