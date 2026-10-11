import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mainHarness } from './main-harness.ts'

const request = { text: 'Please confirm the revised proposal.', sourceLanguage: 'auto', targetLanguage: 'zh-CN', accountId: 'a', conversationId: 'wa:peer', messageId: 'msg-a', cacheUserId: 'owner', context: [{ role: 'user', text: 'Earlier context.' }] }
const encrypted = (value: unknown) => 'hellodog-encrypted-v1:' + Buffer.from(JSON.stringify(value)).toString('base64')

function fixture() {
  let reads = 0, decrypts = 0, writes = 0, rejectDecrypt = false
  const h = mainHarness({ safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => { writes++; return Buffer.from(value) },
    decryptString: (value: Buffer) => { decrypts++; if (rejectDecrypt) throw new Error('decrypt unavailable'); return value.toString() }
  } }, undefined, { fs: { promises: { ...fs, readFile: async (...args: any[]) => { reads++; return (fs.readFile as any)(...args) } } } })
  return { ...h, counts: () => ({ reads, decrypts, writes }), reset: () => { reads = 0; decrypts = 0; writes = 0 }, decryptFailure: (value: boolean) => { rejectDecrypt = value } }
}

test('immutable snapshot detects other instances, external edits, deletion, damage and failed decryption', async () => {
  const h = fixture()
  try {
    const { JsonStore } = h.load('src/main/storage/jsonStore.ts')
    const store = new JsonStore('message-requests-v1.json', {}, true), writer = new JsonStore('message-requests-v1.json', {}, true)
    const path = join(h.directory, 'message-requests-v1.json')
    await writer.write({ owner: { message: { text: 'saved' } } })
    const first = await store.readSnapshot()
    assert.throws(() => { first.owner.message.text = 'caller mutation' }, TypeError)
    assert.equal((await store.readSnapshot()).owner.message.text, 'saved')
    await writer.write({ owner: { message: { text: 'another writer' } } })
    assert.equal((await store.readSnapshot()).owner.message.text, 'another writer')
    writeFileSync(path, encrypted({ owner: { message: { text: 'external replacement' } } }))
    assert.equal((await store.readSnapshot()).owner.message.text, 'external replacement')
    writeFileSync(path, 'damaged encrypted ledger')
    await assert.rejects(store.readSnapshot(), /无法读取/)
    await assert.rejects(store.readSnapshot(), /无法读取/)
    writeFileSync(path, encrypted({ owner: { message: { text: 'recover after damage' } } }))
    h.decryptFailure(true)
    await assert.rejects(store.readSnapshot(), /无法读取/)
    h.decryptFailure(false)
    assert.equal((await store.readSnapshot()).owner.message.text, 'recover after damage')
    unlinkSync(path)
    assert.equal(Object.keys(await store.readSnapshot()).length, 0)
    await writer.write({ otherOwner: { message: { text: 'new account' } } })
    assert.equal((await store.readSnapshot()).owner, undefined)
    assert.equal((await store.readSnapshot()).otherOwner.message.text, 'new account')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('snapshot waits for atomic pending writes and concurrent readers share one decrypt', async () => {
  const h = fixture()
  try {
    const { JsonStore } = h.load('src/main/storage/jsonStore.ts')
    const a = new JsonStore('translation-cache.json', {}), b = new JsonStore('translation-cache.json', {})
    await a.write({ version: 1 })
    await b.readSnapshot()
    h.reset()
    const writing = a.write({ version: 2, nested: [1, 2, 3] })
    const results = await Promise.all(Array.from({ length: 32 }, () => b.readSnapshot()))
    await writing
    assert.ok(results.every(value => value.version === 2))
    assert.equal(h.counts().reads, 1)
    assert.equal(h.counts().decrypts, 1)
    assert.ok(results.every(value => value === results[0]))
    assert.throws(() => results[0].nested.push(4), /not extensible|read only/)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('history lookups decrypt two large stores once across 80 lookups and preserve identity isolation', async context => {
  const h = fixture()
  try {
    const { JsonStore } = h.load('src/main/storage/jsonStore.ts')
    const { MessageRequests } = h.load('src/main/translation/messageRequests.ts')
    const { TranslationCache } = h.load('src/main/translation/cache.ts')
    const messages = new MessageRequests(), cache = new TranslationCache()
    const saved = await messages.prepare(request)
    await cache.set('openai', saved, '请确认修订后的方案。')
    const messageStore = new JsonStore('message-requests-v1.json', {}, true)
    const cacheStore = new JsonStore('translation-cache.json', {})
    const history = await messageStore.read(), cached = await cacheStore.read()
    for (let i = 0; i < 3000; i++) {
      history['fixture-' + i] = { ...request, messageId: 'unrelated-' + i, requestId: 'stored-unrelated-' + i }
      cached['fixture-' + i] = { translated: '历史译文 ' + i, textHash: 'fixture', updatedAt: i }
    }
    await messageStore.write(history); await cacheStore.write(cached)
    // Exercise the former full-read path against the exact same fixture. Use
    // I/O counts as the assertion; wall time is diagnostic, not a flaky gate.
    h.reset()
    const baselineStart = performance.now()
    for (let i = 0; i < 40; i++) {
      assert.ok(Object.values(await messageStore.read()).find((item: any) => item.messageId === request.messageId))
      assert.ok(Object.keys(await cacheStore.read()).length > 3000)
    }
    const baselineMs = performance.now() - baselineStart
    assert.equal(h.counts().reads, 80)
    assert.equal(h.counts().decrypts, 80)
    const coldMessages = new MessageRequests(), coldCache = new TranslationCache()
    h.reset()
    const before = performance.now()
    for (let i = 0; i < 40; i++) {
      assert.equal((await coldMessages.lookup(request)).requestId, saved.requestId)
      assert.equal(await coldCache.get('openai', saved), '请确认修订后的方案。')
    }
    const elapsed = performance.now() - before
    assert.equal(h.counts().reads, 2)
    assert.equal(h.counts().decrypts, 2)
    context.diagnostic(`3,001 stored messages, 80 sequential lookups: full-read baseline ${baselineMs.toFixed(1)} ms / 80 reads/decrypts; optimized ${elapsed.toFixed(1)} ms / 2 reads/decrypts.`)
    const copy = await coldMessages.lookup(request)
    copy.context[0].text = 'caller changes context'; copy.text = 'caller changes text'
    assert.equal((await coldMessages.lookup(request)).text, request.text)
    assert.equal((await coldMessages.lookup(request)).context[0].text, request.context[0].text)
    assert.equal(await coldMessages.lookup({ ...request, messageId: 'new-identity' }), undefined)
    assert.equal(await coldCache.get('openai', { ...saved, messageId: 'new-identity' }), undefined)
    assert.equal(await coldMessages.lookup({ ...request, cacheUserId: 'other-owner' }), undefined)
    assert.equal(await coldCache.get('openai', { ...saved, cacheUserId: 'other-owner' }), undefined)
    const emoji = await coldMessages.lookup({ ...request, text: request.text + ' 😀' })
    assert.equal(emoji.requestId, saved.requestId)
    h.reset()
    await coldMessages.prepare(request)
    await coldCache.set('openai', saved, '请确认修订后的方案。')
    assert.equal(h.counts().writes, 0, 'repainting a completed message must not rewrite either store')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('clearing and expiring a cached result invalidates every instance without affecting another owner', async () => {
  const h = fixture()
  try {
    const { MessageRequests } = h.load('src/main/translation/messageRequests.ts')
    const { TranslationCache } = h.load('src/main/translation/cache.ts')
    const messages = new MessageRequests(), secondMessages = new MessageRequests(), cache = new TranslationCache(), secondCache = new TranslationCache()
    const saved = await messages.prepare(request), other = { ...saved, cacheUserId: 'other-owner' }
    await cache.set('openai', saved, '原始译文'); await cache.set('openai', other, '另一账号')
    assert.equal((await secondMessages.lookup(request)).requestId, saved.requestId)
    assert.equal(await secondCache.get('openai', saved), '原始译文')
    await messages.expireMessage('owner', 'a', 'wa:peer', 'msg-a')
    assert.equal(await secondMessages.lookup(request), undefined)
    await cache.expire('owner', 'a', 'msg-a')
    assert.equal(await secondCache.get('openai', saved), undefined)
    assert.equal(await secondCache.get('openai', other), '另一账号')
    await cache.clear('other-owner')
    assert.equal(await secondCache.get('openai', other), undefined)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})
