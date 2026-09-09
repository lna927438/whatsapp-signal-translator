import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import * as readline from 'readline'
import { SignalRuntimeManager, type SignalRuntimeStatus } from './signalRuntime'

export class SignalCli extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private seq = 1
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
    const info = await this.runtime.ensureReady()
    return {
      state: 'ready',
      message: 'Signal runtime is ready.',
      progress: 100,
      source: info.source,
      signalCliPath: info.signalCliPath,
      javaHome: info.javaHome
    }
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return

    const runtime = await this.runtime.ensureReady()
    const env = { ...process.env }
    if (runtime.javaHome) {
      env.JAVA_HOME = runtime.javaHome
      const javaBin = `${runtime.javaHome}\\bin`
      env.PATH = `${javaBin};${env.PATH || ''}`
    }

    const executable = runtime.signalCliPath
    this.child = spawn(executable, ['jsonRpc'], {
      stdio: 'pipe',
      windowsHide: true,
      shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.bat'),
      env
    })

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()))
    this.child.on('error', (error) => this.emit('stderr', error.message))
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`signal-cli exited (${code})`))
      }
      this.pending.clear()
      this.child = undefined
      this.emit('exit', code)
    })

    await this.call('listAccounts', {}, 20000).catch((e) => {
      this.stop()
      throw new Error(`Unable to start signal-cli: ${e.message}`)
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
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
