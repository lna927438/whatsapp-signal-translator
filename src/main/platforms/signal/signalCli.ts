import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import * as readline from 'readline'
import { SignalRuntimeManager, type SignalRuntimeInfo, type SignalRuntimeStatus } from './signalRuntime'

interface LaunchPlan {
  command: string
  args: string[]
  shell: boolean
  cwd?: string
}

export class SignalCli extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private seq = 1
  private stderrTail = ''
  private lastStartFailed = false
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly runtime = new SignalRuntimeManager()

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
    return { ...runtime, message: 'Signal runtime is ready and verified.', progress: 100 }
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return
    if (!this.starting) {
      this.starting = this.startInternal().finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  private async startInternal(): Promise<void> {
    let runtime = await this.runtime.ensureReady()
    try {
      await this.launch(runtime)
      this.lastStartFailed = false
      return
    } catch (firstError: any) {
      this.stop()
      if (runtime.source === 'managed') {
        this.emit('runtime', { state: 'checking', message: 'Signal core failed to start. Repairing automatically…' } satisfies SignalRuntimeStatus)
        try {
          runtime = await this.runtime.repair()
          await this.launch(runtime)
          this.lastStartFailed = false
          return
        } catch (repairError: any) {
          const message = formatError(repairError)
          this.lastStartFailed = true
          this.emit('runtime', { state: 'error', message: 'Signal core could not start. Use Repair Signal Core and try again.' } satisfies SignalRuntimeStatus)
          throw new Error(`Unable to start signal-cli after automatic repair: ${message}`)
        }
      }

      const message = formatError(firstError)
      this.lastStartFailed = true
      this.emit('runtime', { state: 'error', message: 'Signal core could not start. Check the runtime configuration.' } satisfies SignalRuntimeStatus)
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
    rl.on('line', (line) => this.onLine(line))
    child.stderr.on('data', (data: Buffer) => this.appendDiagnostic(data.toString('utf8')))
    child.on('error', (error) => {
      this.appendDiagnostic(error.message)
      this.rejectPending(new Error(this.exitMessage('signal-cli process error')))
      if (this.child === child) this.child = undefined
    })
    child.on('exit', (code) => {
      this.rejectPending(new Error(this.exitMessage(`signal-cli exited (${code})`)))
      if (this.child === child) this.child = undefined
      this.emit('exit', code)
    })

    try {
      await this.call('listAccounts', {}, 25000)
    } catch (error) {
      this.stop()
      const diagnostic = this.stderrTail.trim()
      if (diagnostic) throw new Error(`${formatError(error)} — ${diagnostic}`)
      throw error
    }
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    if (child && !child.killed) child.kill()
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    if (!this.child || this.child.killed) throw new Error('signal-cli is not running')
    const id = this.seq++
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Signal RPC timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(payload)
    })
  }

  private appendDiagnostic(text: string): void {
    const cleaned = stripAnsi(text).trim()
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
      if (msg.error) pending.reject(new Error(msg.error.message || 'Signal RPC error'))
      else pending.resolve(msg.result)
      return
    }

    if (msg.method === 'receive') this.emit('receive', msg.params)
  }
}

function createLaunchPlan(runtime: SignalRuntimeInfo): LaunchPlan {
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
          'jsonRpc'
        ],
        shell: false,
        cwd: signalHome
      }
    }
  }

  return {
    command: runtime.signalCliPath,
    args: ['jsonRpc'],
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
