import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import * as readline from 'readline'

export class SignalCli extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private seq = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return
    const executable = resolveSignalCliPath()
    this.child = spawn(executable, ['jsonRpc'], { stdio: 'pipe', windowsHide: true, shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.bat') })
    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()))
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`signal-cli exited (${code})`)) }
      this.pending.clear()
      this.child = undefined
      this.emit('exit', code)
    })
    await this.call('listAccounts', {}, 15000).catch((e) => {
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Signal RPC timeout: ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(payload)
    })
  }

  private onLine(line: string): void {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'Signal RPC error'))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'receive') this.emit('receive', msg.params)
  }
}

function resolveSignalCliPath(): string {
  if (process.env.SIGNAL_CLI_PATH) return process.env.SIGNAL_CLI_PATH
  const win = join(process.resourcesPath, 'signal', 'bin', 'signal-cli.bat')
  const unix = join(process.resourcesPath, 'signal', 'bin', 'signal-cli')
  if (process.platform === 'win32' && existsSync(win)) return win
  if (existsSync(unix)) return unix
  if (!app.isPackaged) {
    const devWin = join(process.cwd(), 'resources', 'signal', 'bin', 'signal-cli.bat')
    const devUnix = join(process.cwd(), 'resources', 'signal', 'bin', 'signal-cli')
    if (process.platform === 'win32' && existsSync(devWin)) return devWin
    if (existsSync(devUnix)) return devUnix
  }
  return process.platform === 'win32' ? 'signal-cli.bat' : 'signal-cli'
}
