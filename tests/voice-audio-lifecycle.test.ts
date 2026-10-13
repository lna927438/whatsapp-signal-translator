import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/shared/voiceAudio.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(hang: string[] = [], failure?: Error, cleanupThrows = false) {
  let now = 100000, serial = 0, reads = 0, renders = 0, closes = 0, cancels = 0
  const timers = new Map<number, { at: number; run: () => void }>(), held = new Map<string, () => void>(), exports: any = {}
  const pause = async (stage: string) => { if (hang.includes(stage)) await new Promise<void>(resolve => held.set(stage, resolve)) }
  const DateClock = class extends Date { static override now() { return now } }
  const stream = {
    read: async () => { await pause('read'); return reads++ === 0 ? { done: false, value: new Uint8Array([1, 2, 3]) } : { done: true } },
    cancel: async () => { cancels++; await pause('cancel'); if (cleanupThrows) throw Error('cleanup failure') },
  }
  runInNewContext(code, {
    exports, URL, AbortSignal, Uint8Array, DataView, Date: DateClock,
    setTimeout: (run: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, run }); return id },
    clearTimeout: (id: number) => timers.delete(id), location: { origin: 'https://voice.google.com' },
    fetch: async () => { await pause('fetch'); return { ok: true, headers: { get: () => null }, body: { getReader: () => stream } } },
    AudioContext: class {
      async decodeAudioData() { await pause('decode'); if (failure) throw failure; return { duration: .1 } }
      async close() { closes++; await pause('close'); if (cleanupThrows) throw Error('cleanup failure') }
    },
    OfflineAudioContext: class {
      destination = {}; createBufferSource() { return { connect() {}, start() {} } }
      async startRendering() { renders++; await pause('render'); return { getChannelData: () => new Float32Array(1600).fill(.2) } }
    },
  })
  const advance = async (milliseconds: number) => {
    const until = now + milliseconds; await flush()
    for (;;) { const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].run(); await flush() }
    now = until; await flush()
  }
  return { start: () => exports.voiceAudioWav('blob:https://voice.google.com/owned'), advance, release: async (stage: string) => { held.get(stage)?.(); await flush() }, stats: () => ({ renders, closes, cancels, timers: timers.size }) }
}

test('voice fetch, body, decode and offline rendering each stop at the total deadline', async () => {
  for (const phase of ['fetch', 'read', 'decode', 'render']) {
    const h = fixture([phase, 'close', 'cancel'])
    let settled = false
    const run = h.start(); void run.then(() => { settled = true }, () => { settled = true })
    const rejected = assert.rejects(run, /超时/)
    await h.advance(44999); assert.equal(settled, false, phase)
    await h.advance(1); await rejected
    assert.equal(h.stats().timers, 0, phase)
    if (phase === 'decode' || phase === 'render') assert.equal(h.stats().closes, 1)
    if (phase === 'read') assert.equal(h.stats().cancels, 1)
    await h.release(phase)
    if (phase === 'decode') assert.equal(h.stats().renders, 0, 'late decode must not restart rendering after timeout')
  }
})

test('voice deadline is shared across decode and render rather than restarting per phase', async () => {
  const h = fixture(['decode', 'render'])
  const rejected = assert.rejects(h.start(), /超时/)
  await h.advance(30000); await h.release('decode')
  assert.equal(h.stats().renders, 1)
  await h.advance(15000); await rejected
  assert.equal(h.stats().closes, 1); assert.equal(h.stats().timers, 0)
})

test('stalled stream cancellation and decoder close do not block successful PCM output', async () => {
  const h = fixture(['close', 'cancel'])
  const result = await h.start()
  assert.equal(result.byteLength, 3244)
  assert.deepEqual(h.stats(), { renders: 1, closes: 1, cancels: 1, timers: 0 })
})

test('cleanup rejection does not hide the original decoder failure', async () => {
  const failure = Error('specific unsupported audio')
  const h = fixture([], failure, true)
  await assert.rejects(h.start(), error => error === failure)
  assert.deepEqual(h.stats(), { renders: 0, closes: 1, cancels: 1, timers: 0 })
})
