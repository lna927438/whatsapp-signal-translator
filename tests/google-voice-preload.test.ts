import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/preload/googleVoice.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(origin = 'https://voice.google.com', mainFrame = true, topFrame = true) {
  let installed: any, unreadInstalled: any
  const requests: any[] = [], listeners = new Map<string, Function>(), view: any = {}
  const isolatedDocument = Object.freeze({ synthetic: true })
  view.top = topFrame ? view : {}
  runInNewContext(code, {
    exports: {}, process: { isMainFrame: mainFrame }, window: view, location: { origin },
    get document() {
      if (origin !== 'https://voice.google.com' || !mainFrame || !topFrame) throw new Error('Entry must not inspect authentication or child-frame document')
      return isolatedDocument
    },
    require(name: string) {
      if (name === 'electron') return { ipcRenderer: {
        invoke: async (...args: any[]) => { requests.push(args); return { ok: true, result: { connected: true } } },
        on: (name: string, handler: Function) => listeners.set(name, handler),
        removeListener: (name: string, handler: Function) => { if (listeners.get(name) === handler) listeners.delete(name) }
      } }
      if (name === '../../integrations/google-voice-extension/content-runtime.js') return { installGoogleVoiceRuntime: (options: any) => { installed = options } }
      assert.equal(name, './googleVoiceUnread')
      return { installGoogleVoiceUnread: (document: unknown, report: Function) => { assert.equal(document, isolatedDocument); unreadInstalled = { report } } }
    }
  })
  return { installed, unreadInstalled, requests, listeners, view }
}
test('Google Voice preload never starts on authentication pages, lookalikes, other ports or child frames', () => {
  for (const origin of ['https://accounts.google.com', 'https://voice.google.com.evil.invalid', 'https://voice.google.com:444', 'http://voice.google.com']) {
    const f = fixture(origin); assert.equal(f.installed, undefined); assert.equal(f.unreadInstalled, undefined); assert.equal(f.requests.length, 0)
  }
  for (const f of [fixture(undefined, false), fixture(undefined, true, false)]) {
    assert.equal(f.installed, undefined); assert.equal(f.unreadInstalled, undefined); assert.equal(f.requests.length, 0)
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
test('context invalidation subscription carries no host payload and detaches on runtime cleanup', () => {
  const f = fixture(), events: any[] = []
  const stop = f.installed.subscribe((value: any) => events.push(value))
  f.listeners.get('google-voice:context-changed')!({}, { secret: 'must-not-forward' })
  assert.equal(JSON.stringify(events), '[{"v":1,"type":"voice.connection-changed"}]')
  stop(); assert.equal(f.listeners.size, 0)
})
