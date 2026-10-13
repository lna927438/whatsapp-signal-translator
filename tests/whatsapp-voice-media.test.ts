import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { JSDOM } from 'jsdom'
import { mainHarness } from './main-harness.ts'

const modules = mainHarness()
const { whatsappVoiceMedia } = modules.load('src/main/platforms/whatsapp/inject/voiceMedia.ts')
after(() => { assert.match(relative(resolve(tmpdir()), resolve(modules.directory)), /^hellodog-test-[A-Za-z0-9]+$/); rmSync(modules.directory, { recursive: true, force: true }) })
const id = 'false_123@c.us_voice-a'
const opaque = '3EB0000000000000000001'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

function fixture(domId = id) {
  const dom = new JSDOM('<div id="row"><button aria-label="Play voice note"></button></div>', { url: 'https://web.whatsapp.com', runScripts: 'outside-only' })
  const w = dom.window as any, row = w.document.querySelector('#row')
  const blob = new w.Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' })
  const model: any = { id: { _serialized: id, id: domId === id ? 'voice-a' : domId }, type: 'ptt', filehash: 'content-hash', encFilehash: 'encrypted-hash', mediaKey: 'synthetic-key', mediaData: { mediaBlob: { forceToBlob: () => blob } } }
  const store = new Map<string, any>([[id, model]])
  const calls: string[] = [], getRequests: string[][] = []
  const available: Record<string, any> = { WAWebCollections: { Msg: { get: (key: string) => store.get(key), getMessagesById: async (keys: string[]) => { getRequests.push(keys); return { messages: keys.map(key => store.get(key)).filter(Boolean) } } } } }
  w.require = (name: string) => { calls.push(name); return available[name] }
  w.AbortSignal = AbortSignal
  let valid = true
  const read = w.eval('(' + whatsappVoiceMedia.toString() + ')')
  return { w, row, model, store, blob, calls, getRequests, available, read: () => read(row, domId, () => valid),
    invalidate: () => { valid = false }, bind: (value = model, node = row) => { Object.defineProperty(node, '__reactProps$owned', { value: { message: value }, configurable: true, enumerable: true }) }, close: () => dom.window.close() }
}

test('WA exact loaded message resolves its own cached blob without playback, broad store scans or native download', async () => {
  const h = fixture(); try {
    const result = await h.read(); assert.equal(result.blob, h.blob); assert.equal(result.current(), true)
    assert.deepEqual(h.calls, ['WAWebCollections']); assert.equal(h.getRequests.length, 0)
    h.invalidate(); assert.equal(result.current(), false)
  } finally { h.close() }
})

test('WA exact model in-memory media cache uses only that message filehash', async () => {
  const h = fixture(); try {
    h.model.mediaData = {}; const lookups: string[] = []
    h.available.WAWebMediaInMemoryBlobCache = { InMemoryMediaBlobCache: { get: (hash: string) => { lookups.push(hash); return h.blob } } }
    assert.equal((await h.read()).blob, h.blob); assert.deepEqual(lookups, ['content-hash'])
  } finally { h.close() }
})

test('WA missing local model fetches only the exact requested message identity', async () => {
  const h = fixture(); try {
    h.store.clear(); h.available.WAWebCollections.Msg.getMessagesById = async (keys: string[]) => { h.getRequests.push([...keys]); return { messages: [h.model] } }
    const result = await h.read(); assert.equal(result.blob, h.blob); assert.deepEqual(h.getRequests, [[id]])
  } finally { h.close() }
})

test('WA native lazy download requests only selected model and returns its resulting cached media', async () => {
  const h = fixture(); try {
    h.model.mediaData = {}; const calls: any[] = []
    h.model.downloadMedia = async (options: any) => { calls.push(options); h.model.mediaData.mediaBlob = { forceToBlob: () => h.blob } }
    assert.equal((await h.read()).blob, h.blob); assert.equal(calls.length, 1)
    assert.equal(calls[0].downloadEvenIfExpensive, true); assert.equal(calls[0].isUserInitiated, true)
  } finally { h.close() }
})

test('WA wrong model, non-audio, view-once, revoked and deleted models are rejected without media reads', async () => {
  for (const mutate of [
    (h: any) => { h.model.id._serialized = 'false_other@c.us_voice-a' },
    (h: any) => { h.model.type = 'video' },
    (h: any) => { h.model.isViewOnce = true },
    (h: any) => { h.model.mediaData.isViewOnce = true },
    (h: any) => { h.model.isRevoked = true },
    (h: any) => { h.model.isDeleted = true },
  ]) {
    const h = fixture(); try { let reads = 0; h.model.mediaData.mediaBlob.forceToBlob = () => { reads++; return h.blob }; mutate(h); await assert.rejects(h.read()); assert.equal(reads, 0) } finally { h.close() }
  }
})

test('WA evicted blob uses the official native decryptor with only selected model metadata and a bounded signal', async () => {
  const h = fixture(); try {
    h.model.mediaData = {}; h.model.directPath = '/synthetic/owned-audio'; h.model.mediaKeyTimestamp = 42
    let downloads = 0; h.model.downloadMedia = async () => { downloads++ }
    const invocations: any[] = []
    h.available.WAWebDownloadManager = { downloadManager: { downloadAndMaybeDecrypt: async (options: any) => { invocations.push(options); return new h.w.Uint8Array([1, 2, 3]).buffer } } }
    assert.equal((await h.read()).blob.size, 3); assert.equal(downloads, 1); assert.equal(invocations.length, 1)
    const input = invocations[0]
    for (const key of ['directPath', 'filehash', 'encFilehash', 'mediaKey', 'mediaKeyTimestamp', 'type']) assert.equal(input[key], h.model[key])
    assert.equal(input.signal instanceof AbortSignal, true); assert.equal(input.signal.aborted, false)
  } finally { h.close() }
})

test('WA native decryptor results are rejected when model media changes while loading', async () => {
  const h = fixture(), gate = deferred(); try {
    h.model.mediaData = {}; h.model.directPath = '/synthetic/owned-audio'; h.model.downloadMedia = async () => {}
    h.available.WAWebDownloadManager = { downloadManager: { downloadAndMaybeDecrypt: async () => { await gate.promise; return new h.w.Uint8Array([1, 2, 3]) } } }
    const rejected = assert.rejects(h.read()); await flush(); h.model.filehash = 'replacement-hash'; gate.resolve(); await rejected
  } finally { h.close() }
})

test('WA model waits reject owner cancellation, store replacement, store deletion and changed media before decode', async () => {
  for (const change of ['owner', 'replacement', 'deletion', 'hash', 'key', 'revoked']) {
    const h = fixture(), gate = deferred(); try {
      h.model.mediaData = {}; h.model.downloadMedia = async () => { await gate.promise; h.model.mediaData.mediaBlob = { forceToBlob: () => h.blob } }
      const rejected = assert.rejects(h.read()); await flush()
      if (change === 'owner') h.invalidate()
      else if (change === 'replacement') h.store.set(id, { ...h.model })
      else if (change === 'deletion') h.store.delete(id)
      else if (change === 'hash') h.model.filehash = 'different-content'
      else if (change === 'key') h.model.mediaKey = 'different-synthetic-key'
      else h.model.isRevoked = true
      gate.resolve(); await rejected
    } finally { h.close() }
  }
})

test('WA opaque message resolves only its own row React model and never reads the global collection', async () => {
  const h = fixture(opaque); try {
    h.bind(); const result = await h.read(); assert.equal(result.blob, h.blob); assert.deepEqual(h.calls, [])
    Object.defineProperty(h.row, '__reactProps$owned', { value: { message: { ...h.model } }, configurable: true }); assert.equal(result.current(), false)
  } finally { h.close() }
})

test('WA opaque lookup rejects wrong or multiple row models, quoted models and parent fibers', async () => {
  for (const kind of ['wrong', 'multiple', 'quoted', 'parent']) {
    const h = fixture(opaque); try {
      if (kind === 'wrong') { h.model.id.id = 'different'; h.bind() }
      else if (kind === 'multiple') { h.bind(); const child = h.w.document.createElement('span'); h.row.append(child); h.bind({ ...h.model }, child) }
      else if (kind === 'quoted') { const child = h.w.document.createElement('span'); child.dataset.testid = 'quoted-message'; h.row.append(child); h.bind(h.model, child) }
      else Object.defineProperty(h.row, '__reactFiber$parent', { value: { return: { memoizedProps: { message: h.model } } } })
      await assert.rejects(h.read()); assert.deepEqual(h.calls, [])
    } finally { h.close() }
  }
})

test('WA unavailable, empty and oversized model blobs are rejected before any translation', async () => {
  for (const size of [-1, 0, 20 * 1024 * 1024 + 1]) {
    const h = fixture(); try { h.model.mediaData.mediaBlob.forceToBlob = () => size < 0 ? null : new h.w.Blob([new Uint8Array(size)]); await assert.rejects(h.read()) } finally { h.close() }
  }
})
