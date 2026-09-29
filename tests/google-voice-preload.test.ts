import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parseGoogleVoiceRuntimeHealth } from '../src/shared/googleVoiceRuntimeHealth.ts'

const source = readFileSync(new URL('../src/preload/googleVoice.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(origin = 'https://voice.google.com', mainFrame = true, topFrame = true, failure?: 'unread' | 'runtime') {
  let installed: any, unreadInstalled: any, audioInstalled:any, audioInstalls=0, audioStops=0
  const requests: any[] = [], listeners = new Map<string, Set<Function>>(), view: any = {}, windowListeners=new Map<string,Function>()
  const isolatedDocument = Object.freeze({ synthetic: true })
  view.top = topFrame ? view : {}
  Object.defineProperty(view,'addEventListener',{value:(name:string,listener:Function)=>windowListeners.set(name,listener)})
  runInNewContext(code, {
    exports: {}, process: { isMainFrame: mainFrame }, window: view, location: { origin },
    get document() {
      if (origin !== 'https://voice.google.com' || !mainFrame || !topFrame) throw new Error('Entry must not inspect authentication or child-frame document')
      return isolatedDocument
    },
    require(name: string) {
      if (name === 'electron') return { ipcRenderer: {
        invoke: async (...args: any[]) => { requests.push(args); return { ok: true, result: { connected: true } } },
        on: (name: string, handler: Function) => {const group=listeners.get(name)||new Set();group.add(handler);listeners.set(name,group)},
        removeListener: (name: string, handler: Function) => { const group=listeners.get(name);group?.delete(handler);if(!group?.size)listeners.delete(name) }
      } }
      if (name === '../shared/googleVoiceRuntimeHealth') return { parseGoogleVoiceRuntimeHealth }
      if (name === './googleVoiceAudio') return {installGoogleVoiceAudio:(document:unknown,options:any)=>{assert.equal(document,isolatedDocument);audioInstalled=options;audioInstalls++;return()=>{audioStops++}}}
      if (name === '../../integrations/google-voice-extension/content-runtime.js') return { installGoogleVoiceRuntime: (options: any) => { if (failure === 'runtime') throw new Error('synthetic private error detail'); installed = options } }
      assert.equal(name, './googleVoiceUnread')
      return { installGoogleVoiceUnread: (document: unknown, report: Function) => { if (failure === 'unread') throw new Error('synthetic observer error'); assert.equal(document, isolatedDocument); unreadInstalled = { report } } }
    }
  })
  return { installed, unreadInstalled, audioInstalled, requests, listeners, view, windowListeners, audioCounts:()=>({installs:audioInstalls,stops:audioStops}),emit:(name:string,...args:any[])=>{for(const listener of [...(listeners.get(name)||[])])listener(...args)} }
}
test('Google Voice preload never starts on authentication pages, lookalikes, other ports or child frames', () => {
  for (const origin of ['https://accounts.google.com', 'https://voice.google.com.evil.invalid', 'https://voice.google.com:444', 'http://voice.google.com']) {
    const f = fixture(origin); assert.equal(f.installed, undefined); assert.equal(f.unreadInstalled, undefined); assert.equal(f.audioInstalled,undefined); assert.equal(f.requests.length, 0)
  }
  for (const f of [fixture(undefined, false), fixture(undefined, true, false)]) {
    assert.equal(f.installed, undefined); assert.equal(f.unreadInstalled, undefined); assert.equal(f.audioInstalled,undefined); assert.equal(f.requests.length, 0)
  }
})
test('Google Voice preload keeps transport private and forwards the narrow request envelope only', async () => {
  const f = fixture(), value = { v: 1, type: 'voice.status' }
  await f.installed.sendRequest(value)
  assert.equal(f.requests[0][0], 'google-voice:translate-request')
  assert.equal(f.requests[0][1], value)
  assert.deepEqual(Object.keys(f.view), ['top'])
  assert.equal(source.includes('contextBridge'), false)
})
test('Google Voice unread installs only in the trusted isolated document and uses its separate private IPC channel', async () => {
  const f = fixture(), value = { source: 'sms-navigation', documentId: '10000000-0000-4000-8000-000000000001', sequence: 1, count: 2 }
  assert.ok(f.unreadInstalled)
  await f.unreadInstalled.report(value)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0][0], 'google-voice:unread')
  assert.equal(f.requests[0][1], value)
  assert.deepEqual(Object.keys(f.view), ['top'])
})

test('Google Voice audio sends only PCM bytes over its own trusted-page IPC without an account or URL',async()=>{
 const f=fixture(),bytes=new Uint8Array([1,2,3]);assert.ok(f.audioInstalled)
 await f.audioInstalled.translateAudio(bytes)
 assert.deepEqual(f.requests,[['google-voice:voice-audio',bytes]])
 assert.deepEqual(Object.keys(f.view),['top'])
})
test('context invalidation subscription carries no host payload and detaches on runtime cleanup', () => {
  const f = fixture(), events: any[] = []
  const stop = f.installed.subscribe((value: any) => events.push(value))
  f.emit('google-voice:context-changed',{}, { secret: 'must-not-forward' })
  assert.equal(JSON.stringify(events), '[{"v":1,"type":"voice.connection-changed"}]')
  stop(); assert.equal(f.listeners.get('google-voice:context-changed')?.size, 1)
  f.windowListeners.get('unload')!();assert.equal(f.listeners.size,0)
})

test('audio owner/context changes dispose old work and preload unload removes its own listener',()=>{
 const f=fixture();assert.deepEqual(f.audioCounts(),{installs:1,stops:0})
 f.emit('google-voice:context-changed',{}, {owner:'not-forwarded'});assert.deepEqual(f.audioCounts(),{installs:2,stops:1})
 f.windowListeners.get('unload')!();assert.deepEqual(f.audioCounts(),{installs:2,stops:2});assert.equal(f.listeners.size,0)
})

test('preload health sends only bounded status and unread setup failure cannot suppress translation', () => {
  const f = fixture(undefined, true, true, 'unread')
  assert.ok(f.installed); assert.equal(f.unreadInstalled, undefined)
  f.installed.onHealth({ phase: 'ready', code: 'manual-mode', messageCount: 4 })
  assert.deepEqual(f.requests, [['google-voice:runtime-health', { phase: 'ready', code: 'manual-mode', messageCount: 4 }]])
  for (const value of [null, { phase: 'ready', code: 'ready', messageCount: -1 }, { phase: 'ready', code: 'ready', messageCount: 10001 },
    { phase: 'ready', code: 'ready', messageCount: 1, text: 'must-not-forward' }, { phase: 'error', code: 'private error details', messageCount: 0 }]) f.installed.onHealth(value)
  assert.equal(f.requests.length, 1)
})

test('runtime initialization failure reports a fixed code without the raw exception or a page bridge', () => {
  const f = fixture(undefined, true, true, 'runtime')
  assert.ok(f.unreadInstalled); assert.equal(f.installed, undefined)
  assert.deepEqual(f.requests, [['google-voice:runtime-health', { phase: 'error', code: 'preload-failed', messageCount: 0 }]])
  assert.deepEqual(Object.keys(f.view), ['top'])
})
