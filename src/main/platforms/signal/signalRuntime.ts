import { EventEmitter } from 'events'
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { basename, dirname, join, resolve } from 'path'

export type SignalRuntimeState =
  | 'missing'
  | 'checking'
  | 'downloading-signal'
  | 'downloading-java'
  | 'installing'
  | 'ready'
  | 'error'

export interface SignalRuntimeStatus {
  state: SignalRuntimeState
  message: string
  progress?: number
  source?: 'env' | 'bundled' | 'managed' | 'path'
  signalCliPath?: string
  javaHome?: string
}

export interface SignalRuntimeInfo {
  signalCliPath: string
  javaHome?: string
  source: 'env' | 'bundled' | 'managed' | 'path'
}

interface RuntimeManifest {
  signalCliPath: string
  javaHome: string
  signalVersion?: string
  javaVersion?: string
  installedAt: string
}

export class SignalRuntimeManager extends EventEmitter {
  private installing?: Promise<SignalRuntimeInfo>

  async status(): Promise<SignalRuntimeStatus> {
    this.emitStatus({ state: 'checking', message: 'Checking Signal runtime…' })
    const info = await this.locate()
    if (!info) return { state: 'missing', message: 'Signal runtime is not installed.' }
    return {
      state: 'ready',
      message: 'Signal runtime is ready.',
      source: info.source,
      signalCliPath: info.signalCliPath,
      javaHome: info.javaHome
    }
  }

  async ensureReady(): Promise<SignalRuntimeInfo> {
    const existing = await this.locate()
    if (existing) {
      this.emitStatus({
        state: 'ready',
        message: 'Signal runtime is ready.',
        source: existing.source,
        signalCliPath: existing.signalCliPath,
        javaHome: existing.javaHome
      })
      return existing
    }

    if (process.platform !== 'win32') {
      throw new Error('Automatic Signal runtime setup is currently supported on Windows only. Set SIGNAL_CLI_PATH or install signal-cli on PATH.')
    }

    if (!this.installing) {
      this.installing = this.installWindowsRuntime().finally(() => { this.installing = undefined })
    }
    return this.installing
  }

  async repair(): Promise<SignalRuntimeInfo> {
    if (process.platform !== 'win32') {
      throw new Error('Automatic Signal runtime repair is currently supported on Windows only.')
    }
    if (process.env.SIGNAL_CLI_PATH) {
      throw new Error('Signal is using SIGNAL_CLI_PATH. Remove or correct that override before using automatic repair.')
    }
    if (!this.installing) {
      this.installing = (async () => {
        this.emitStatus({ state: 'checking', message: 'Repairing Signal runtime…' })
        await rm(this.runtimeRoot(), { recursive: true, force: true })
        return this.installWindowsRuntime()
      })().finally(() => { this.installing = undefined })
    }
    return this.installing
  }

  private async locate(): Promise<SignalRuntimeInfo | undefined> {
    const envPath = process.env.SIGNAL_CLI_PATH
    if (envPath && (existsSync(envPath) || !isAbsoluteLike(envPath))) {
      return { signalCliPath: envPath, source: 'env', javaHome: process.env.JAVA_HOME }
    }

    const bundled = process.platform === 'win32'
      ? join(process.resourcesPath, 'signal', 'bin', 'signal-cli.bat')
      : join(process.resourcesPath, 'signal', 'bin', 'signal-cli')
    if (existsSync(bundled)) {
      const bundledJava = join(process.resourcesPath, 'signal', 'jre')
      return { signalCliPath: bundled, source: 'bundled', javaHome: existsSync(bundledJava) ? bundledJava : undefined }
    }

    if (!app.isPackaged) {
      const dev = process.platform === 'win32'
        ? join(process.cwd(), 'resources', 'signal', 'bin', 'signal-cli.bat')
        : join(process.cwd(), 'resources', 'signal', 'bin', 'signal-cli')
      if (existsSync(dev)) return { signalCliPath: dev, source: 'bundled', javaHome: process.env.JAVA_HOME }
    }

    const managed = await this.readManagedManifest()
    if (managed) return managed

    if (process.platform === 'win32') {
      const found = spawnSync('where.exe', ['signal-cli.bat'], { encoding: 'utf8', windowsHide: true })
      const first = found.status === 0 ? found.stdout.split(/\r?\n/).map((v) => v.trim()).find(Boolean) : undefined
      if (first) return { signalCliPath: first, source: 'path', javaHome: process.env.JAVA_HOME }
    } else {
      const found = spawnSync('which', ['signal-cli'], { encoding: 'utf8' })
      const first = found.status === 0 ? found.stdout.trim() : undefined
      if (first) return { signalCliPath: first, source: 'path', javaHome: process.env.JAVA_HOME }
    }
    return undefined
  }

  private runtimeRoot(): string {
    return join(app.getPath('userData'), 'signal-runtime')
  }

  private async readManagedManifest(): Promise<SignalRuntimeInfo | undefined> {
    try {
      const raw = await readFile(join(this.runtimeRoot(), 'runtime.json'), 'utf8')
      const manifest = JSON.parse(raw) as RuntimeManifest
      const javaExe = join(manifest.javaHome, 'bin', 'java.exe')
      const signalHome = dirname(dirname(manifest.signalCliPath))
      const signalLib = join(signalHome, 'lib')
      if (existsSync(manifest.signalCliPath) && existsSync(javaExe) && existsSync(signalLib)) {
        return {
          signalCliPath: manifest.signalCliPath,
          javaHome: manifest.javaHome,
          source: 'managed'
        }
      }
    } catch {
      // Missing or stale manifest: setup will repair it.
    }
    return undefined
  }

  private async installWindowsRuntime(): Promise<SignalRuntimeInfo> {
    const root = this.runtimeRoot()
    const staging = join(root, '.staging')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })

    try {
      this.emitStatus({ state: 'checking', message: 'Finding the latest Signal runtime…' })
      const signalRelease = await fetchJson<any>('https://api.github.com/repos/AsamK/signal-cli/releases/latest', {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'WhatsApp-Signal-Translator'
      })
      const signalAsset = (signalRelease.assets || []).find((asset: any) => /^signal-cli-[0-9][0-9.]*\.tar\.gz$/i.test(asset.name))
      if (!signalAsset?.browser_download_url) throw new Error('Could not find the current signal-cli Windows-compatible distribution.')

      const javaAssets = await getTemurinJreAssets()
      const javaPackage = javaAssets?.[0]?.binary?.package
      if (!javaPackage?.link) throw new Error('Could not find a Java 25 runtime for Windows x64.')

      const signalArchive = join(staging, basename(signalAsset.name))
      const javaArchive = join(staging, 'temurin-jre25.zip')

      await downloadFile(signalAsset.browser_download_url, signalArchive, (progress) => {
        this.emitStatus({ state: 'downloading-signal', message: 'Downloading Signal core…', progress })
      })
      if (signalAsset.digest?.startsWith('sha256:')) {
        await verifySha256(signalArchive, signalAsset.digest.slice(7))
      }

      await downloadFile(javaPackage.link, javaArchive, (progress) => {
        this.emitStatus({ state: 'downloading-java', message: 'Downloading Java runtime…', progress })
      })
      if (javaPackage.checksum) await verifySha256(javaArchive, javaPackage.checksum)

      this.emitStatus({ state: 'installing', message: 'Installing Signal runtime…', progress: 0 })
      const signalDir = join(root, 'signal-cli')
      const javaDir = join(root, 'java')
      await rm(signalDir, { recursive: true, force: true })
      await rm(javaDir, { recursive: true, force: true })
      await mkdir(signalDir, { recursive: true })
      await mkdir(javaDir, { recursive: true })

      await runProcess('tar.exe', ['-xzf', signalArchive, '-C', signalDir])
      this.emitStatus({ state: 'installing', message: 'Installing Signal runtime…', progress: 55 })
      await runProcess('tar.exe', ['-xf', javaArchive, '-C', javaDir])

      const signalCliPath = await findByName(signalDir, 'signal-cli.bat')
      const javaExe = await findByName(javaDir, 'java.exe')
      if (!signalCliPath) throw new Error('Signal core was downloaded but signal-cli.bat was not found after extraction.')
      if (!javaExe) throw new Error('Java runtime was downloaded but java.exe was not found after extraction.')
      const javaHome = dirname(dirname(javaExe))
      const signalHome = dirname(dirname(signalCliPath))
      if (!existsSync(join(signalHome, 'lib'))) throw new Error('Signal core is incomplete: the lib directory is missing.')

      const manifest: RuntimeManifest = {
        signalCliPath: resolve(signalCliPath),
        javaHome: resolve(javaHome),
        signalVersion: signalRelease.tag_name,
        javaVersion: javaAssets?.[0]?.version?.semver,
        installedAt: new Date().toISOString()
      }
      await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest, null, 2), 'utf8')
      await rm(staging, { recursive: true, force: true })

      const result: SignalRuntimeInfo = {
        signalCliPath: manifest.signalCliPath,
        javaHome: manifest.javaHome,
        source: 'managed'
      }
      this.emitStatus({
        state: 'ready',
        message: 'Signal runtime is ready.',
        progress: 100,
        source: 'managed',
        signalCliPath: result.signalCliPath,
        javaHome: result.javaHome
      })
      return result
    } catch (error: any) {
      const message = String(error?.message || error)
      this.emitStatus({ state: 'error', message })
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`Signal runtime setup failed: ${message}`)
    }
  }

  private emitStatus(status: SignalRuntimeStatus): void {
    this.emit('status', status)
  }
}

async function getTemurinJreAssets(): Promise<any[]> {
  const base = 'https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jre&os=windows'
  try {
    const withVendor = await fetchJson<any[]>(base + '&vendor=eclipse')
    if (Array.isArray(withVendor) && withVendor.length) return withVendor
  } catch {
    // Retry without vendor below.
  }
  const generic = await fetchJson<any[]>(base)
  return Array.isArray(generic) ? generic : []
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status} while requesting ${url}`)
  return response.json() as Promise<T>
}

async function downloadFile(url: string, destination: string, onProgress: (value: number) => void): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length') || 0)
  let received = 0
  const source = Readable.fromWeb(response.body as any)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)))
  })
  await mkdir(dirname(destination), { recursive: true })
  await pipeline(source, createWriteStream(destination))
  onProgress(100)
}

async function verifySha256(file: string, expected: string): Promise<void> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  const actual = hash.digest('hex').toLowerCase()
  if (actual !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${basename(file)}`)
}

async function findByName(root: string, wanted: string, depth = 0): Promise<string | undefined> {
  if (depth > 6) return undefined
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findByName(join(root, entry.name), wanted, depth + 1)
    if (found) return found
  }
  return undefined
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)))
  })
}

function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}
