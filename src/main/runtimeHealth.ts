import { app, powerMonitor } from 'electron'
import type { BrowserWindow } from 'electron'
import { performance } from 'perf_hooks'
import { PerformanceSamples } from './performanceSamples'
const samples = new PerformanceSamples()
const externalMetrics = new Map<string,{memoryMiB:number;cpuPercent:number;processCount:number;at:number}>()
export function setExternalMetrics(id:string,value?:{memoryMiB:number;cpuPercent:number;processCount:number}) {
  if(!value) { externalMetrics.delete(id); return }
  if(Object.values(value).every(item=>Number.isFinite(item)&&item>=0)) externalMetrics.set(id,{...value,at:Date.now()})
}
const started = performance.now()
let readyMs: number | null = null
let lastSwitchMs: number | null = null
let powerState = 'active'
const accountStates = new Map<string, { state: string; checkedAt: number }>()
export function markReady() { readyMs = Math.round(performance.now() - started) }
export function markSwitch(ms: number) { lastSwitchMs = Math.round(ms); samples.switch(ms) }
export function setAccountState(id: string, state: string) { accountStates.set(id, { state, checkedAt: Date.now() }) }
export function getAccountStates() { return Object.fromEntries(accountStates) }
export function runtimeSnapshot() {
  const metrics = app.getAppMetrics()
  const external=[...externalMetrics.values()].filter(item=>Date.now()-item.at<30000)
  const cpuPercent=Number((metrics.reduce((sum,item)=>sum+item.cpu.percentCPUUsage,0)+external.reduce((sum,item)=>sum+item.cpuPercent,0)).toFixed(2))
  const memoryMiB=Number((metrics.reduce((sum,item)=>sum+item.memory.workingSetSize,0)/1024+external.reduce((sum,item)=>sum+item.memoryMiB,0)).toFixed(1))
  const count=[...accountStates.values()].filter(item=>!['closed','paused'].includes(item.state)).length
  return { startupMs: readyMs, switchMs: lastSwitchMs, cpuPercent, memoryMiB,
    processCount: metrics.length+external.reduce((sum,item)=>sum+item.processCount,0), signalProcessesIncluded:external.length,
    history:samples.record(memoryMiB,cpuPercent,count), powerState, sampledAt: Date.now() }
}
export function watchPower(window: BrowserWindow, recover: () => Promise<unknown>) {
  const events: NodeJS.EventEmitter = powerMonitor
  const handlers = new Map<string, () => void>()
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) {
    const handler = () => {
      powerState = event
      if (!window.isDestroyed()) window.webContents.send('runtime:changed', { event, at: Date.now() })
      if (event === 'resume' || event === 'unlock-screen') void recover().catch(() => undefined)
    }
    handlers.set(event, handler); events.on(event, handler)
  }
  window.on('closed', () => { for (const [event, handler] of handlers) events.removeListener(event, handler) })
}
