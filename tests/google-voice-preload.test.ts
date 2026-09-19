import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/preload/googleVoice.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(origin = 'https://voice.google.com', mainFrame = true, topFrame = true) {
  let installed: any
  const requests: any[] = [], listeners = new Map<string, Function>(), view: any = {}
  view.top = topFrame ? view : {}
  runInNewContext(code, {
    exports: {}, process: { isMainFrame: mainFrame }, window: view, location: { origin },
    get document() { throw new Error('Entry must not inspect authentication document') },
    require(name: string) {
      if (name === 'electron') return { ipcRenderer: {
        invoke: async (...args: any[]) => { requests.push(args); return { ok: true, result: { connected: true } } },
        on: (name: string, handler: Function) => listeners.set(name, handler),
        removeListener: (name: string, handler: Function) => { if (listeners.get(name) === handler) listeners.delete(name) }
      } }
      assert.equal(name, '../../integrations/google-voice-extension/content-runtime.js')
      return { installGoogleVoiceRuntime: (options: any) => { installed = options } }
    }
  })
  return { installed, requests, listeners, view }
}
test('Google Voice preload never starts on authentication pages, lookalikes, other ports or child frames', () => {
  for (const origin of ['https://accounts.google.com', 'https://voice.google.com.evil.invalid', 'https://voice.google.com:444', 'http://voice.google.com']) {
    const f = fixture(origin); assert.equal(f.installed, undefined); assert.equal(f.requests.length, 0)
  }
  assert.equal(fixture(undefined, false).installed, undefined)
  assert.equal(fixture(undefined, true, false).installed, undefined)
})
test('Google Voice preload keeps transport private and forwards the narrow request envelope only', async () => {
  const f = fixture(), value = { v: 1, type: 'voice.status' }
  await f.installed.sendRequest(value)
  assert.equal(f.requests[0][0], 'google-voice:translate-request')
  assert.equal(f.requests[0][1], value)
  assert.deepEqual(Object.keys(f.view), ['top'])
  assert.equal(source.includes('contextBridge'), false)
})
test('context invalidation subscription carries no host payload and detaches on runtime cleanup', () => {
  const f = fixture(), events: any[] = []
  const stop = f.installed.subscribe((value: any) => events.push(value))
  f.listeners.get('google-voice:context-changed')!({}, { secret: 'must-not-forward' })
  assert.equal(JSON.stringify(events), '[{"v":1,"type":"voice.connection-changed"}]')
  stop(); assert.equal(f.listeners.size, 0)
})
