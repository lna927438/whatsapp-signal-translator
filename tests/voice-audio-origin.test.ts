import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function decoder(origin = 'https://voice.google.com') {
  const requests: Array<{ url: string; options: any }> = [], exports: any = {}
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/voiceAudio.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, URL, AbortSignal, Uint8Array, DataView, setTimeout, clearTimeout, location: { origin }, fetch: async (url: string, options: any) => { requests.push({ url, options }); return new Response(new Uint8Array([1])) }, AudioContext: class { async decodeAudioData() { return { duration: .1 } } async close() {} }, OfflineAudioContext: class { destination = {}; createBufferSource() { return { connect() {}, start() {} } } async startRendering() { return { getChannelData: () => new Float32Array(1600).fill(.2) } } } })
  return { decode: exports.voiceAudioWav, requests }
}
test('voice decoder fetches proven same-origin HTTPS media without following redirects', async () => {
  const h = decoder(); const bytes = await h.decode('https://voice.google.com/media/voice', 'https://voice.google.com')
  assert.equal(bytes.length, 3244); assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].options.redirect, 'error'); assert.equal(h.requests[0].options.credentials, 'same-origin')
})
test('voice decoder refuses unproven or mismatched remote URLs before any request', async () => {
  for (const [url, allowed] of [['https://voice.google.com/media', undefined], ['https://other.example/media', 'https://voice.google.com'], ['https://user:password@voice.google.com/media', 'https://voice.google.com'], ['http://voice.google.com/media', 'http://voice.google.com'], ['file:///D:/secret', 'https://voice.google.com'], ['https://other.example/media', 'https://other.example']]) {
    const h = decoder(); await assert.rejects(h.decode(url, allowed), /未能读取/); assert.equal(h.requests.length, 0)
  }
})
test('voice decoder continues to accept per-renderer local blob media', async () => {
  const h = decoder(); await h.decode('blob:https://voice.google.com/owned'); assert.equal(h.requests.length, 1)
})
