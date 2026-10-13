import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../integrations/hellodog-source/hellodog.voice.preload.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const answer = { text: 'Hello', englishTranslation: 'Hello', translation: '你好', targetLanguage: 'zh-CN', audioId: 'b'.repeat(64) }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const receiptId = (attachment: any) => createHash('sha256').update(JSON.stringify([
  0, attachment.clientUuid, attachment.plaintextHash, attachment.digest, attachment.path, attachment.size,
])).digest('hex')

function fixture(options: { ready?: boolean; pending?: boolean; missingSignature?: boolean; queueMode?: 'held' | 'error'; loadMode?: 'held'; oversized?: boolean; attachment?: Record<string, unknown> } = {}) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
  const window = dom.window as any, document = window.document
  let now = 100000, serial = 0, valid = true, deps: any, reads = 0, decodes = 0
  const jobs: any[] = [], invocations: any[] = [], revoked: string[] = []
  let finishLoad: (() => void) | undefined
  const timers = new Map<number, { at: number; callback: () => void }>()
  const attachment: any = { contentType: 'audio/ogg', size: options.oversized ? 21 * 1024 * 1024 : 100,
    clientUuid: 'attachment-a', ...(options.missingSignature ? {} : { digest: 'encrypted-digest-a' }),
    ...(options.ready ? { path: 'owned-audio' } : {}), ...(options.pending ? { pending: true } : {}), ...options.attachment }
  const attrs: any = { conversationId: 'conversation-a', received_at: 1, sent_at: 2, attachments: [attachment] }
  const message = { get: (key: string) => attrs[key] }
  window.MessageCache = { getById: (id: string) => id === 'message-a' ? message : undefined }
  window.reduxStore = { getState: () => ({}) }
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string, request: any) => {
    invocations.push({ channel, request }); return answer
  } })
  const exports: any = {}
  const timer = (callback: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id }
  const DateClock = class extends Date { static override now() { return now } }
  runInNewContext(compiled, {
    exports, window, document, Date: DateClock, Blob, Uint8Array,
    URL: { createObjectURL: () => 'blob:owned-synthetic', revokeObjectURL: (value: string) => revoked.push(value) },
    MutationObserver: window.MutationObserver,
    process: { env: { HELLODOG_EMBEDDED: '1', HELLODOG_BRIDGE_ACTIVE: '1' } },
    setTimeout: timer, clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval: () => {},
    require: (name: string) => {
      if (name === 'electron') return { ipcRenderer: ipc }
      if (name.startsWith('node:')) return require(name)
      if (name.includes('/migrations.')) return { loadAttachmentData: async (owned: any) => { reads++; assert.equal(owned, attrs.attachments[0]); if (options.loadMode === 'held') await new Promise<void>(resolve => { finishLoad = resolve }); return { ...owned, data: new Uint8Array([1, 2, 3]) } } }
      if (name.includes('/nav.')) return { getSelectedConversationId: () => 'conversation-a' }
      if (name.includes('/jobs/AttachmentDownloadManager.')) return { AttachmentDownloadManager: { addJob: (job: any) => {
        jobs.push(job)
        if (options.queueMode === 'held') return new Promise(() => {})
        if (options.queueMode === 'error') return Promise.reject(Error('private native failure'))
        return Promise.resolve(job.attachment)
      } } }
      if (name.includes('/types/AttachmentDownload.')) return { AttachmentDownloadUrgency: { IMMEDIATE: 'immediate' } }
      if (name.includes('/sql/Interface.')) return { AttachmentDownloadSource: { STANDARD: 'standard' } }
      if (name.includes('voice-audio')) return { voiceAudioWav: async () => { decodes++; return new Uint8Array([4, 5, 6]) } }
      if (name.includes('voice.dom')) return { createSignalVoiceUi: (value: any) => { deps = value; return { scan() {}, reset() {}, dispose() { valid = false } } } }
      throw Error('Unexpected import ' + name)
    },
  })
  exports.startHelloDogVoiceMessages()
  const item = deps.items('message-a')[0]
  const current = () => valid && deps.items('message-a').some((value: any) => value.attachmentId === item.attachmentId)
  const start = () => deps.translate(item, current) as Promise<typeof answer>
  async function advance(milliseconds: number) {
    const until = now + milliseconds
    await flush()
    for (;;) {
      const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, task] = next; timers.delete(id); now = task.at; task.callback(); await flush()
    }
    now = until; await flush()
  }
  return { attachment, attrs, item, jobs, invocations, revoked, start, advance, current,
    identities: () => deps.items('message-a'), ready: () => { attachment.path = 'new-owned-path'; attachment.plaintextHash ||= 'new-plaintext-hash'; attachment.digest ||= 'downloaded-digest'; attachment.pending = false; attachment.error = false },
    reads: () => reads, decodes: () => decodes, releaseLoad: () => finishLoad?.(), invalidate: () => { valid = false },
    close: () => { window.dispatchEvent(new window.Event('unload')); timers.clear(); dom.window.close() },
  }
}

test('Signal translate directly queues its exact native attachment and continues after download without a second click', async () => {
  const h = fixture()
  try {
    assert.equal(h.jobs.length, 0); assert.equal(h.reads(), 0)
    const run = h.start(); await flush()
    assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].attachment, h.attachment)
    assert.equal(h.jobs[0].messageId, 'message-a'); assert.equal(h.jobs[0].attachmentType, 'attachment')
    assert.equal(h.jobs[0].isManualDownload, true); assert.equal(h.jobs[0].urgency, 'immediate')
    assert.equal(h.reads(), 0)
    h.ready(); assert.equal(h.identities()[0].attachmentId, h.item.attachmentId)
    await h.advance(200); assert.equal(await run, answer)
    assert.equal(h.reads(), 1); assert.equal(h.decodes(), 1); assert.equal(h.invocations.length, 1)
    assert.equal(h.invocations[0].request.attachmentId, receiptId(h.attachment))
    assert.deepEqual(h.revoked, ['blob:owned-synthetic'])
  } finally { h.close() }
})

test('Signal legacy plaintext-only download can add digest and path without changing the pending action, and restarts reuse the final receipt identity', async () => {
  const h = fixture({ attachment: { digest: undefined, clientUuid: undefined, plaintextHash: 'legacy-plaintext' } })
  let restarted: ReturnType<typeof fixture> | undefined
  try {
    const run = h.start(); await flush()
    assert.equal(h.jobs.length, 1)
    h.ready()
    assert.equal(h.identities()[0].attachmentId, h.item.attachmentId)
    assert.equal(h.attachment.plaintextHash, 'legacy-plaintext')
    assert.equal(h.attachment.digest, 'downloaded-digest')
    await h.advance(200); assert.equal(await run, answer)
    const finalId = h.invocations[0].request.attachmentId
    assert.equal(finalId, receiptId(h.attachment))
    assert.notEqual(finalId, h.item.attachmentId)
    restarted = fixture({ attachment: { ...h.attachment } })
    assert.equal(await restarted.start(), answer)
    assert.equal(restarted.jobs.length, 0)
    assert.equal(restarted.invocations[0].request.attachmentId, finalId)
  } finally { restarted?.close(); h.close() }
})

test('Signal ready attachments preserve the .22 receipt identity rather than migrating every paid voice', async () => {
  const h = fixture({ ready: true, attachment: { plaintextHash: 'already-downloaded-plaintext' } })
  try {
    const originalId = receiptId(h.attachment)
    assert.equal(await h.start(), answer)
    assert.equal(h.jobs.length, 0)
    assert.equal(h.invocations[0].request.attachmentId, originalId)
    assert.equal(h.invocations[0].request.id, 'message-a')
    assert.equal(h.invocations[0].request.conversationId, 'conversation-a')
  } finally { h.close() }
})

test('Signal preserves existing signature anchors but refuses real plaintext or newly observed digest replacement', async () => {
  for (const change of ['legacy-plaintext', 'known-plaintext', 'added-digest']) {
    const h = fixture({ attachment: { plaintextHash: 'original-plaintext', ...(change !== 'known-plaintext' ? { digest: undefined } : {}) } })
    try {
      const rejected = assert.rejects(h.start()); await flush()
      if (change === 'added-digest') {
        h.attachment.digest = 'first-added-digest'
        assert.equal(h.identities()[0].attachmentId, h.item.attachmentId)
        h.attachment.digest = 'replaced-digest'
      } else h.attachment.plaintextHash = 'replaced-plaintext'
      h.ready(); await h.advance(200); await rejected
      assert.equal(h.reads(), 0); assert.equal(h.invocations.length, 0)
      assert.notEqual(h.identities()[0].attachmentId, h.item.attachmentId)
    } finally { h.close() }
  }
})

test('Signal already-loaded and already-loading attachments do not start redundant native downloads', async () => {
  for (const ready of [false, true]) {
    const h = fixture({ ready, pending: !ready })
    try { const run = h.start(); await flush(); assert.equal(h.jobs.length, 0)
      if (!ready) { h.ready(); await h.advance(200) }
      assert.equal(await run, answer); assert.equal(h.reads(), 1)
    } finally { h.close() }
  }
})

test('Signal direct-load rejects deletion, expiry, view-once, replacement, disposal and conversation cancellation before reading audio', async () => {
  for (const change of ['delete', 'expire', 'view-once', 'replace', 'dispose', 'conversation']) {
    const h = fixture()
    try {
      const rejected = assert.rejects(h.start())
      await flush()
      if (change === 'delete') h.attrs.deletedForEveryone = true
      else if (change === 'expire') { h.attrs.expirationStartTimestamp = 1; h.attrs.expireTimer = 1 }
      else if (change === 'view-once') h.attrs.isViewOnce = true
      else if (change === 'replace') h.attachment.digest = 'different-content'
      else h.invalidate()
      h.ready(); await h.advance(200); await rejected
      assert.equal(h.reads(), 0); assert.equal(h.invocations.length, 0)
    } finally { h.close() }
  }
})

test('Signal direct-load bounds stalled native download, rejected queue, oversize and unidentifiable audio without billing', async () => {
  for (const options of [{ queueMode: 'held' as const }, { queueMode: 'error' as const }, { oversized: true }, { missingSignature: true }]) {
    const h = fixture(options)
    try {
      const rejected = assert.rejects(h.start()); await h.advance(45200); await rejected
      assert.equal(h.reads(), 0); assert.equal(h.invocations.length, 0)
      if (options.oversized || options.missingSignature) assert.equal(h.jobs.length, 0)
    } finally { h.close() }
  }
})

test('Signal stalled local attachment reads time out and a late read does not decode or bill', async () => {
  const h = fixture({ ready: true, loadMode: 'held' })
  try {
    const rejected = assert.rejects(h.start(), /reading timeout/)
    await h.advance(45000); await rejected
    assert.equal(h.reads(), 1); assert.equal(h.decodes(), 0); assert.equal(h.invocations.length, 0)
    h.releaseLoad(); await flush()
    assert.equal(h.decodes(), 0); assert.equal(h.invocations.length, 0)
  } finally { h.close() }
})
