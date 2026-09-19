import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { win32 as path } from 'path'

export type NativeWindowIdentity = { hwnd: string; pid: number; startTicks: string }
export type NativeWindowAttachment = { parentHwnd: string; parentPid: number; child: NativeWindowIdentity; executable: string; profile: string }
export type NativeWindowBounds = { x: number; y: number; width: number; height: number }
export type NativeHostDependencies = { spawn: typeof spawn; timeoutMs: number }
const defaultDependencies: NativeHostDependencies = { spawn, timeoutMs: 8000 }
const handle = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 0x7fffffffffffffffn
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
const identity = (value: any): value is NativeWindowIdentity => value && handle(value.hwnd) && pid(value.pid) && handle(value.startTicks)
const messages: Record<string, string> = {
  dpi: '浏览器与客户端的显示缩放模式不兼容，Google Voice 已保留为独立窗口。',
  identity: '无法确认 Google Voice 专用窗口，请重新打开。',
  parent: '客户端窗口已经变化，请重新打开 Google Voice。'
}
function safePath(value: string): boolean { return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[\x00-\x1f"<>|?*]/.test(value) && !value.split(/[\\/]/).includes('..') && !value.slice(2).includes(':') }
function validatePaths(helper: string, executable: string, profile: string): void {
  if (![helper, executable, profile].every(safePath) || path.basename(helper).toLowerCase() !== 'googlevoicewindowhost.exe' || !['chrome.exe', 'msedge.exe'].includes(path.basename(executable).toLowerCase())) throw new Error('Google Voice 窗口配置无效。')
}
function startHelper(helper: string, args: string[], dependencies: NativeHostDependencies): ChildProcessWithoutNullStreams {
  return dependencies.spawn(helper, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
}

/** Read-only discovery; returns only windows of the exact dedicated app/profile. */
export async function discoverGoogleVoiceWindows(helper: string, executable: string, profile: string, overrides: Partial<NativeHostDependencies> = {}): Promise<NativeWindowIdentity[]> {
  validatePaths(helper, executable, profile)
  const dependencies = { ...defaultDependencies, ...overrides }
  return new Promise((resolve, reject) => {
    const child = startHelper(helper, ['discover', executable, profile], dependencies)
    let output = '', settled = false
    const finish = (error?: Error, result?: NativeWindowIdentity[]) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      error ? reject(error) : resolve(result || [])
    }
    const timer = setTimeout(() => {
      // This helper mode only reads process/window metadata, so terminating a
      // stuck discovery helper cannot affect browser windows or conversations.
      child.kill(); finish(new Error('查找 Google Voice 窗口超时，请重试。'))
    }, dependencies.timeoutMs)
    child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.length > 32768) { child.kill(); finish(new Error('Google Voice 窗口信息无效。')) }
    })
    child.stderr.on('data', () => {})
    child.once('error', () => finish(new Error('无法启动 Google Voice 窗口组件。')))
    child.once('close', code => {
      try {
        const result = JSON.parse(output.trim())
        if (code !== 0 || !Array.isArray(result.windows) || result.windows.length > 32 || !result.windows.every(identity)) throw new Error()
        finish(undefined, result.windows)
      } catch { finish(new Error('无法确认 Google Voice 专用窗口。')) }
    })
    child.stdin.end()
  })
}

/** One helper per verified browser HWND. Never closes or kills the browser. */
export class GoogleVoiceNativeWindowHost {
  private readonly dependencies: NativeHostDependencies
  private child?: ChildProcessWithoutNullStreams
  private attached = false
  private verifiedDetached = false
  private ended = false
  private detaching?: Promise<void>
  private finishDetach?: (error?: Error) => void
  private disconnected = new Set<(error?: Error) => void>()
  private lastBounds = ''
  private lastVisible?: boolean
  constructor(private readonly helperPath: string, dependencies: Partial<NativeHostDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }
  onDisconnected(callback: (error?: Error) => void): () => void { this.disconnected.add(callback); return () => { this.disconnected.delete(callback) } }
  async attach(configuration: NativeWindowAttachment, authorized: () => boolean = () => true): Promise<void> {
    validatePaths(this.helperPath, configuration.executable, configuration.profile)
    if (!handle(configuration.parentHwnd) || !pid(configuration.parentPid) || !identity(configuration.child) || configuration.parentPid === configuration.child.pid || this.child) throw new Error('Google Voice 窗口配置无效。')
    if (!authorized()) throw new Error('HelloDog 登录状态已变化，请重新打开 Google Voice。')
    const child = startHelper(this.helperPath, ['attach', configuration.parentHwnd, String(configuration.parentPid), configuration.child.hwnd, String(configuration.child.pid), configuration.child.startTicks, configuration.executable, configuration.profile], this.dependencies)
    this.child = child
    return new Promise<void>((resolve, reject) => {
      let buffer = '', finished = false, spawned = false
      const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve() }
      const timer = setTimeout(() => {
        finish(new Error('Google Voice 窗口接入超时，正在恢复独立窗口。'))
        void this.detach().catch(() => {})
      }, this.dependencies.timeoutMs)
      child.stdin.on('error', () => { this.finishDetach?.(new Error('无法确认 Google Voice 窗口已恢复，请暂时保留客户端。')) })
      child.once('spawn', () => { spawned = true })
      child.stderr.on('data', () => {})
      child.stdout.on('data', chunk => {
        buffer += String(chunk)
        if (buffer.length > 32768) { finish(new Error('Google Voice 窗口组件响应无效。')); child.stdin.end('detach\n'); return }
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line)
            if (event.event === 'attached') {
              this.attached = true
              if (!authorized() || finished) { finish(new Error('HelloDog 登录状态已变化，请重新打开 Google Voice。')); void this.detach().catch(() => {}); continue }
              finish()
            } else if (event.event === 'detached') {
              this.attached = false; this.verifiedDetached = event.verified === true
              const error = this.verifiedDetached ? undefined : new Error('未能确认 Google Voice 窗口已恢复，请暂时保留客户端。')
              this.finishDetach?.(error)
              finish(error || new Error('Google Voice 窗口已关闭或恢复为独立窗口。'))
              for (const callback of this.disconnected) callback(error)
            } else if (event.event === 'error') {
              finish(new Error(messages[event.reason] || 'Google Voice 窗口接入失败，正在恢复独立窗口。'))
            }
          } catch { finish(new Error('Google Voice 窗口组件响应无效。')); child.stdin.end('detach\n') }
        }
      })
      child.once('error', () => {
        this.ended = true
        // Node emits `spawn` before any helper output. If process creation
        // itself failed, no HWND could have been touched; do not trap normal
        // app shutdown waiting for an acknowledgment from a nonexistent helper.
        if (!spawned) this.verifiedDetached = true
        finish(new Error('无法启动 Google Voice 窗口组件。'))
        this.finishDetach?.(this.verifiedDetached ? undefined : new Error('窗口恢复尚未确认。'))
      })
      child.once('close', () => {
        this.ended = true
        const error = this.verifiedDetached ? undefined : new Error('Google Voice 窗口组件已断开，窗口恢复尚未确认。')
        finish(error || new Error('Google Voice 窗口已关闭。')); this.finishDetach?.(error)
        if (!this.verifiedDetached) for (const callback of this.disconnected) callback(error)
      })
    })
  }
  private command(value: string): boolean { if (this.attached && !this.ended && !this.detaching && this.child?.stdin.writable) { this.child.stdin.write(value + '\n'); return true } return false }
  setBounds(bounds: NativeWindowBounds): void {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || [bounds.x, bounds.y, bounds.width, bounds.height].some(value => value > 64000)) throw new Error('Google Voice 窗口尺寸无效。')
    const value = `bounds ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`
    if (value !== this.lastBounds && this.command(value)) this.lastBounds = value
  }
  setVisible(visible: boolean): void { if (visible !== this.lastVisible && this.command(visible ? 'show' : 'hide')) this.lastVisible = visible }
  focus(host = false): void { this.command(host ? 'focus-host' : 'focus') }
  detach(): Promise<void> {
    if (!this.child || this.verifiedDetached) return Promise.resolve()
    if (this.detaching) return this.detaching
    if (this.ended) return Promise.reject(new Error('Google Voice 窗口恢复尚未确认，请暂时保留客户端。'))
    const operation = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); if (this.finishDetach === finish) this.finishDetach = undefined; error ? reject(error) : resolve() }
      const timer = setTimeout(() => finish(new Error('Google Voice 窗口恢复超时，请暂时保留客户端并重试。')), this.dependencies.timeoutMs)
      this.finishDetach = finish
      // EOF is also a recovery command; never kill an attached helper/process.
      if (this.child?.stdin.writable) this.child.stdin.end('detach\n')
      else finish(new Error('Google Voice 窗口恢复尚未确认，请暂时保留客户端。'))
    })
    this.detaching = operation
    void operation.then(() => { this.detaching = undefined }, () => { this.detaching = undefined })
    return operation
  }
}
