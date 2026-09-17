import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { mkdir, stat } from 'fs/promises'
import { win32 as path } from 'path'
import { performance } from 'perf_hooks'

export type GoogleVoiceBrowser = 'chrome' | 'edge'
export type GoogleVoiceLaunchResult = { browser: GoogleVoiceBrowser; launched: true }

/** Main-process dependencies only; none of these are accepted over IPC. */
export interface GoogleVoiceLauncherDependencies {
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
  isFile: (file: string) => Promise<boolean>
  createDirectory: (directory: string) => Promise<void>
  spawn: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  now: () => number
  launchTimeoutMs: number
  operationTimeoutMs: number
}

type BrowserCandidate = { browser: GoogleVoiceBrowser; executable: string }
const OFFICIAL_URL = 'https://voice.google.com/'
const CLICK_COOLDOWN_MS = 2500

const defaults: GoogleVoiceLauncherDependencies = {
  platform: process.platform,
  environment: process.env,
  isFile: async file => {
    try { return (await stat(file)).isFile() } catch { return false }
  },
  createDirectory: async directory => { await mkdir(directory, { recursive: true }) },
  spawn,
  now: () => performance.now(),
  launchTimeoutMs: 5000,
  operationTimeoutMs: 10000
}

function localAbsoluteDirectory(value: string): string | undefined {
  if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f"<>|?*]/.test(value) || value.slice(2).includes(':')) return
  if (value.split(/[\\/]/).includes('..')) return
  return path.normalize(value)
}

function candidates(environment: NodeJS.ProcessEnv): BrowserCandidate[] {
  // Resolve only conventional installation locations. Never search PATH, execute a
  // shell command, or accept renderer-controlled browser paths or switches.
  const roots = [environment.ProgramW6432, environment.ProgramFiles, environment['ProgramFiles(x86)'], environment.LOCALAPPDATA]
    .map(value => value ? localAbsoluteDirectory(value) : undefined)
    .filter((value): value is string => !!value)
  const seen = new Set<string>()
  const result: BrowserCandidate[] = []
  for (const browser of ['chrome', 'edge'] as const) {
    const relative = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe']
    for (const root of roots) {
      const executable = path.join(root, ...relative)
      if (seen.has(executable.toLowerCase())) continue
      seen.add(executable.toLowerCase())
      result.push({ browser, executable })
    }
  }
  return result
}

function requireAuthorized(authorized: () => boolean): void {
  let allowed = false
  try { allowed = authorized() } catch { /* Identity lookup failure must fail closed. */ }
  if (!allowed) throw new Error('HelloDog 登录状态已变化，请重新点击打开 Google Voice。')
}

class BrowserStartFailure extends Error {}
class BrowserStartUnconfirmed extends Error {}

function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserStartUnconfirmed('Google Voice 打开超时，请稍后重试。')), Math.max(1, deadline - performance.now()))
    void operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * Opens the unmodified Google Voice site in an installed browser. The supplied
 * root is already scoped to one HelloDog owner by the main-process caller.
 * Profiles are owned by HelloDog, are never copied from another browser profile,
 * and keep Chrome and Edge data separate. No web contents or cookies are read.
 */
export class GoogleVoiceOfficialWindow {
  private readonly dependencies: GoogleVoiceLauncherDependencies
  private readonly profileRoot: string
  private selected?: BrowserCandidate
  private inFlight?: Promise<GoogleVoiceLaunchResult>
  private lastLaunch?: { result: GoogleVoiceLaunchResult; at: number }

  constructor(userData: string, dependencies: Partial<GoogleVoiceLauncherDependencies> = {}) {
    const root = localAbsoluteDirectory(userData)
    if (!root) throw new Error('Google Voice 数据目录无效，请检查 HelloDog 的储存设置。')
    this.profileRoot = path.join(root, 'official-browser')
    this.dependencies = { ...defaults, ...dependencies }
  }

  open(authorized: () => boolean = () => true): Promise<GoogleVoiceLaunchResult> {
    try { requireAuthorized(authorized) } catch (error) { return Promise.reject(error) }
    if (this.inFlight) return this.inFlight
    if (this.lastLaunch && this.dependencies.now() - this.lastLaunch.at < CLICK_COOLDOWN_MS) {
      return Promise.resolve(this.lastLaunch.result)
    }
    const operation = this.launch(authorized)
    this.inFlight = operation
    // Use both handlers rather than an ignored finally() promise, which could
    // produce an unhandled rejection on a failed browser launch.
    void operation.then(() => { this.inFlight = undefined }, () => { this.inFlight = undefined })
    return operation
  }

  private async launch(authorized: () => boolean): Promise<GoogleVoiceLaunchResult> {
    if (this.dependencies.platform !== 'win32') throw new Error('Google Voice 独立窗口目前仅支持 Windows。')
    const deadline = performance.now() + this.dependencies.operationTimeoutMs
    const choices = this.selected ? [this.selected] : candidates(this.dependencies.environment)
    let installed = false
    for (const candidate of choices) {
      const exists = await beforeDeadline(this.dependencies.isFile(candidate.executable), deadline)
      requireAuthorized(authorized)
      if (!exists) continue
      installed = true
      const profile = path.join(this.profileRoot, candidate.browser)
      try {
        await beforeDeadline(this.dependencies.createDirectory(profile), deadline)
      } catch (error) {
        if (error instanceof BrowserStartUnconfirmed) throw error
        throw new Error('无法创建 Google Voice 数据目录，请检查磁盘空间和目录权限。')
      }
      // The owner may have changed while discovery or directory creation awaited.
      // Keep this check immediately adjacent to the synchronous spawn call.
      requireAuthorized(authorized)
      if (performance.now() >= deadline) throw new BrowserStartUnconfirmed('Google Voice 打开超时，请稍后重试。')
      try {
        await this.start(candidate.executable, profile, Math.min(this.dependencies.launchTimeoutMs, deadline - performance.now()))
      } catch (error) {
        if (error instanceof BrowserStartUnconfirmed) {
          // A timed-out process may still start. Keep subsequent attempts on the
          // same browser/profile instead of risking a second browser session.
          this.selected = candidate
          throw error
        }
        if (error instanceof BrowserStartFailure) continue
        throw error
      }
      // A successful spawn confirms process creation only, never login/call state.
      this.selected = candidate
      const result: GoogleVoiceLaunchResult = { browser: candidate.browser, launched: true }
      this.lastLaunch = { result, at: this.dependencies.now() }
      return result
    }
    if (this.selected) throw new Error('暂时无法打开 Google Voice，请确认之前使用的浏览器仍已安装并可正常启动。')
    if (installed) throw new Error('无法启动 Google Voice，请检查 Chrome 或 Edge 是否可以正常打开后重试。')
    throw new Error('未找到已安装的 Chrome 或 Edge，请先安装其中一个浏览器，再打开 Google Voice。')
  }

  private start(executable: string, profile: string, timeoutMs: number): Promise<void> {
    let child: ChildProcess
    try {
      // Chromium's app and user-data-dir switches preserve the official site and
      // keep its persistent login separate without weakening browser security.
      child = this.dependencies.spawn(executable, [
        `--app=${OFFICIAL_URL}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check'
      ], { shell: false, detached: true, windowsHide: false, stdio: 'ignore' })
    } catch {
      return Promise.reject(new BrowserStartFailure())
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        child.off('spawn', onSpawn)
        child.off('error', onError)
        child.off('close', onClose)
      }
      const onSpawn = () => {
        clearTimeout(timer)
        child.unref()
        if (settled) return
        settled = true
        resolve()
      }
      const onError = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new BrowserStartFailure())
      }
      const onClose = () => {
        cleanup()
        if (settled) return
        settled = true
        reject(new BrowserStartFailure())
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // The outcome is unknown. Do not start another browser or kill a process
        // that may already own the profile. Retain bounded listeners until close.
        child.unref()
        reject(new BrowserStartUnconfirmed('浏览器启动尚未确认，请先检查是否已出现 Google Voice 窗口，再重试。'))
      }, timeoutMs)
      child.once('spawn', onSpawn)
      child.on('error', onError)
      child.once('close', onClose)
    })
  }
}
