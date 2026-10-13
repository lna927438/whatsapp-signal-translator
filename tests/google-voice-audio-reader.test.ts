import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('../src/preload/googleVoiceAudioReader.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture() {
  const dom = new JSDOM('<gv-audio-player><button aria-label="Play audio"></button></gv-audio-player>', { url: 'https://voice.google.com/u/0/voicemail/a' })
  const view = dom.window, player = view.document.querySelector<HTMLElement>('gv-audio-player')!, control = player.querySelector('button')!
  let now = 100000, serial = 0, current = true
  const exports: any = {}, timers = new Map<number, { at: number; run: () => void }>(), executions: Array<{ script: string; resolve: (value: unknown) => void; reject: (reason: Error) => void }> = []
  view.setTimeout = ((run: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, run }); return id }) as any
  view.clearTimeout = (id?: number) => { if (id !== undefined) timers.delete(id) }
  const DateClock = class extends Date { static override now() { return now } }
  runInNewContext(compiled, { exports, Date: DateClock, Uint8Array, require: (name: string) => name.includes('voicePlayer') ? { acquireVoicePlayer: function fixtureAcquire() {} } : { voiceAudioWav: function fixtureDecode() {}, VOICE_MAX_BYTES: 9600044 } })
  const start = () => exports.readGoogleVoicePlayer((script: string) => new Promise((resolve, reject) => executions.push({ script, resolve, reject })), player, control, 'message-a', () => current)
  const advance = async (milliseconds: number) => { const until = now + milliseconds; await flush(); for (;;) { const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].run(); await flush() } now = until; await flush() }
  return { start, advance, executions, player, control, timers, invalidate: () => { current = false }, restore: () => { current = true }, close: () => dom.window.close() }
}

test('Google Voice pending main-world reads lose their exact markers on same-page identity cancellation', async () => {
  const h = fixture()
  try {
    const rejected = assert.rejects(h.start(), /voice-context/)
    assert.ok(h.player.hasAttribute('data-hellodog-audio-request'))
    h.invalidate(); await h.advance(80); await rejected
    assert.equal(h.player.hasAttribute('data-hellodog-audio-request'), false)
    assert.equal(h.control.hasAttribute('data-hellodog-audio-control'), false)
    assert.equal(h.timers.size, 0)
  } finally { h.close() }
})

test('Google Voice hung cross-world execution times out, removes markers and permits a fresh attempt', async () => {
  const h = fixture()
  try {
    const rejected = assert.rejects(h.start(), /voice-context/)
    const oldToken = h.player.getAttribute('data-hellodog-audio-request')
    await h.advance(45000); await rejected
    assert.equal(h.player.hasAttribute('data-hellodog-audio-request'), false)
    const retry = h.start(), newToken = h.player.getAttribute('data-hellodog-audio-request')
    assert.ok(newToken); assert.notEqual(newToken, oldToken)
    h.executions[0].resolve(new Uint8Array(3244).buffer); await flush()
    assert.equal(h.player.getAttribute('data-hellodog-audio-request'), newToken, 'late old completion cannot revoke a newer request')
    h.executions[1].resolve(new Uint8Array(3244).buffer)
    assert.equal((await retry).byteLength, 3244)
    assert.equal(h.player.hasAttribute('data-hellodog-audio-request'), false); assert.equal(h.timers.size, 0)
  } finally { h.close() }
})

test('Google Voice main-world failure preserves its error and clears both token markers', async () => {
  const h = fixture()
  try {
    const failure = Error('decoder rejected')
    const rejected = assert.rejects(h.start(), error => error === failure)
    h.executions[0].reject(failure); await rejected
    assert.equal(h.player.hasAttribute('data-hellodog-audio-request'), false)
    assert.equal(h.control.hasAttribute('data-hellodog-audio-control'), false)
    assert.equal(h.timers.size, 0)
  } finally { h.close() }
})
