import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import * as readline from 'readline'
import { app } from 'electron'
import { SignalRuntimeManager, type SignalRuntimeInfo, type SignalRuntimeStatus } from './signalRuntime'
import { diagnosticSummary } from '../../privacy'

interface LaunchPlan {
  command: string
  args: string[]
  shell: boolean
  cwd?: string
}

export class SignalCli extends EventEmitter {
  get running() { return Boolean(this.ready && this.child && !this.child.killed) }
  private ready = false
  private generation = 0
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private seq = 1
  private stderrTail = ''
  private lastStartFailed = false
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly runtime = new SignalRuntimeManager()
  private lateResults = new Map<number, { receive: (result: any) => void; timer: NodeJS.Timeout }>()

  constructor() {
    super()
    this.runtime.on('status', (status: SignalRuntimeStatus) => this.emit('runtime', status))
  }

  async runtimeStatus(): Promise<SignalRuntimeStatus> {
    return this.runtime.status()
  }

  async prepareRuntime(): Promise<SignalRuntimeStatus> {
    if (this.lastStartFailed) await this.runtime.repair()
    else await this.runtime.ensureReady()
    await this.start()
    const runtime = await this.runtime.status()
    this.lastStartFailed = false
    const status = { ...runtime, message: 'Signal 已启动，可以关联手机或开始聊天。', progress: 100 }
    this.emit('runtime', status)
    return status
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.running) return
    if (!this.starting) {
      this.starting = this.startInternal().finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  private async startInternal(): Promise<void> {
    const generation = this.generation
    let runtime = await this.runtime.ensureReady()
    if (generation !== this.generation) throw new Error('Signal 启动已取消。')
    try {
      await this.launch(runtime)
      this.lastStartFailed = false
      return
    } catch (firstError: any) {
      this.stop(false)
      if (generation !== this.generation) throw new Error('Signal 启动已取消。')
      if (runtime.source === 'managed') {
        this.emit('runtime', { state: 'checking', message: '正在修复 Signal 启动组件…' } satisfies SignalRuntimeStatus)
        try {
          runtime = await this.runtime.repair()
          if (generation !== this.generation) throw new Error('Signal 启动已取消。')
          await this.launch(runtime)
          this.lastStartFailed = false
          return
        } catch (repairError: any) {
          const message = formatError(repairError)
          this.lastStartFailed = true
          this.emit('runtime', { state: 'error', message: 'Signal 未能启动，请检查连接或重新准备。' } satisfies SignalRuntimeStatus)
          throw new Error(`Unable to start signal-cli after automatic repair: ${message}`)
        }
      }

      const message = formatError(firstError)
      this.lastStartFailed = true
      this.emit('runtime', { state: 'error', message: 'Signal 未能启动，请检查运行组件。' } satisfies SignalRuntimeStatus)
      throw new Error(`Unable to start signal-cli: ${message}`)
    }
  }

  private async launch(runtime: SignalRuntimeInfo): Promise<void> {
    const env = { ...process.env }
    if (runtime.javaHome) {
      env.JAVA_HOME = runtime.javaHome
      const javaBin = join(runtime.javaHome, 'bin')
      env.PATH = `${javaBin};${env.PATH || ''}`
    }

    const plan = createLaunchPlan(runtime)
    this.stderrTail = ''
    const child = spawn(plan.command, plan.args, {
      stdio: 'pipe',
      windowsHide: true,
      shell: plan.shell,
      cwd: plan.cwd,
      env
    })
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => { if (this.child === child) this.onLine(line) })
    child.stderr.on('data', (data: Buffer) => this.appendDiagnostic(data.toString('utf8')))
    child.on('error', (error) => {
      if (this.child !== child) return
      this.appendDiagnostic(error.message)
      this.rejectPending(new Error(this.exitMessage('signal-cli process error')))
      if (this.child === child) this.child = undefined
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.rejectPending(new Error(this.exitMessage(`signal-cli exited (${code})`)))
      if (this.child === child) this.child = undefined
      this.ready = false
      this.emit('exit', code)
    })

    try {
      await this.call('listAccounts', {}, 25000)
      this.ready = true
      this.emit('started')
    } catch (error) {
      this.stop(false)
      const diagnostic = this.stderrTail.trim()
      if (diagnostic) throw new Error(`${formatError(error)} — ${diagnostic}`)
      throw error
    }
  }

  stop(cancelStart = true): void {
    if (cancelStart) this.generation += 1
    this.ready = false
    const child = this.child
    this.child = undefined
    this.rejectPending(new Error('Signal core stopped; any in-flight send result must be checked.'))
    if (child && !child.killed) child.kill()
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000, onLateResult?: (result: any) => void): Promise<any> {
    if (!this.child || this.child.killed) throw new Error('signal-cli is not running')
    const child = this.child
    const id = this.seq++
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (onLateResult) {
          const expiry = setTimeout(() => this.lateResults.delete(id), 10 * 60000)
          expiry.unref?.()
          this.lateResults.set(id, { receive: onLateResult, timer: expiry })
        }
        reject(new Error(`Signal RPC timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(payload, error => {
        if (!error || !this.pending.has(id)) return
        clearTimeout(timer); this.pending.delete(id)
        reject(new Error('Signal 连接已断开，发送结果请在记录与恢复中处理。'))
      })
    })
  }

  private appendDiagnostic(text: string): void {
    const cleaned = diagnosticSummary(stripAnsi(text))
    if (!cleaned) return
    this.stderrTail = `${this.stderrTail}\n${cleaned}`.trim().slice(-12000)
    this.emit('stderr', cleaned)
  }

  private exitMessage(prefix: string): string {
    const diagnostic = this.stderrTail.trim()
    return diagnostic ? `${prefix}: ${diagnostic}` : prefix
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const value of this.lateResults.values()) clearTimeout(value.timer)
    this.lateResults.clear()
  }

  private onLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(diagnosticSummary(msg.error.message)))
      else pending.resolve(msg.result)
      return
    }

    if (msg.method === 'receive') this.emit('receive', msg.params)
    if (typeof msg.id === 'number' && this.lateResults.has(msg.id)) {
      const late = this.lateResults.get(msg.id)!
      clearTimeout(late.timer); this.lateResults.delete(msg.id)
      if (!msg.error) late.receive(msg.result)
    }
  }
}

export function signalDataDirectory(): string {
  const local = join(app.getPath('userData'), 'signal-data')
  // The test profile must never open the real user's Signal keys or sessions.
  if (!app.isPackaged && process.env.HELLODOG_TEST_USER_DATA) return local
  const legacy = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'signal-cli')
    : join(app.getPath('home'), '.local', 'share', 'signal-cli')
  return existsSync(join(legacy, 'data', 'accounts.json')) ? legacy : local
}

export function createLaunchPlan(runtime: SignalRuntimeInfo): LaunchPlan {
  const rpcArgs = ['--scrub-log', '--data-dir', signalDataDirectory(), 'jsonRpc', '--receive-mode=manual']
  if (process.platform === 'win32' && runtime.javaHome) {
    const javaExe = join(runtime.javaHome, 'bin', 'java.exe')
    const signalHome = dirname(dirname(runtime.signalCliPath))
    const libDir = join(signalHome, 'lib')
    if (existsSync(javaExe) && existsSync(libDir)) {
      return {
        command: javaExe,
        args: [
          '-Dfile.encoding=UTF-8',
          '-Dsun.stdout.encoding=UTF-8',
          '-Dsun.stderr.encoding=UTF-8',
          '--enable-native-access=ALL-UNNAMED',
          '-cp', join(libDir, '*'),
          'org.asamk.signal.Main',
          ...rpcArgs
        ],
        shell: false,
        cwd: signalHome
      }
    }
  }

  return {
    command: runtime.signalCliPath,
    args: rpcArgs,
    shell: process.platform === 'win32' && runtime.signalCliPath.toLowerCase().endsWith('.bat'),
    cwd: dirname(runtime.signalCliPath)
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function formatError(error: any): string {
  return String(error?.message || error)
}
