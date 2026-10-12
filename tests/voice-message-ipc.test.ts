import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { mainHarness } from './main-harness.ts'

function wav() {
  const bytes = new Uint8Array(6444), view = new DataView(bytes.buffer)
  for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
  for (const [at, value] of [[4, bytes.length - 8], [16, 16], [24, 16000], [28, 32000], [40, bytes.length - 44]]) view.setUint32(at, value, true)
  for (const [at, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(at, value, true)
  for (let i = 44; i < bytes.length; i += 2) view.setInt16(i, Math.round(Math.sin(i / 11) * 10000), true)
  return bytes
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()) }
const appUrl = pathToFileURL(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))).href
function event(sender = 1, url = appUrl, subframe = false) {
  const mainFrame = { url }; let destroyed = false
  return { sender: { id: sender, mainFrame, isDestroyed: () => destroyed }, senderFrame: subframe ? { url } : mainFrame, destroy: () => { destroyed = true } }
}
function fixture(options: { recognize?: () => Promise<string>; runtime?: () => Promise<void>; translate?: () => Promise<string>; dispose?: () => Promise<void>; busy?: () => boolean } = {}) {
  const h = mainHarness(), { createSecureIpc } = h.load('src/main/secureIpc.ts'), { normalizeSignalPeer } = h.load('src/shared/signalProtocol.ts')
  const { VoiceTranslationService } = h.load('src/main/translation/voiceTranslation.ts')
  const handlers = new Map<string, Function>(), closed: Function[] = [], recognitions: unknown[] = [], prepared: any[] = [], translated: any[] = [], runtimes: any[] = [], tracked: any[] = [], preferences: string[] = []
  const records: any[] = [{ id: 'wa', platform: 'whatsapp' }, { id: 'telegram', platform: 'telegram' }, { id: 'signal', platform: 'signal' }, { id: 'native', platform: 'signal', signalEngine: 'desktop' }, { id: 'paused', platform: 'signal', signalEngine: 'desktop', runtimeMode: 'paused' }]
  let owner = 'owner', revision = 0, ownsWa = true, ownsTelegram = true, gvCurrent = true, gvProvider = 'openai'
  let disposed = 0, quits = 0
  const app = Object.assign(new EventEmitter(), { quit: () => { quits++ } })
  const mainWindow = { webContents: { id: 1 }, once: (name: string, fn: Function) => { assert.equal(name, 'closed'); closed.push(fn) } }
  const whatsapp = { ownsSender: (id: string, sender: number) => ownsWa && id === 'wa' && sender === 7 }
  const telegram = { ownsSender: (id: string, sender: number) => ownsTelegram && id === 'telegram' && sender === 8 }
  const raw = { handle: (name: string, fn: Function) => { assert.ok(!handlers.has(name)); handlers.set(name, fn) } }, ipcMain = createSecureIpc(raw, mainWindow, whatsapp, telegram)
  const requestChannelPreference = async (value: string) => { preferences.push(value); if (!['deepseek', 'openai'].includes(value)) throw Error('unavailable provider'); return value }
  const translator = {
    preserveVoiceRequest: async (request: any) => { prepared.push(request); return request },
    translateIncoming: async (request: any, manual: boolean) => { translated.push({ ...request, manual }); return options.translate ? options.translate() : '你明天早上能给我打电话吗？' },
    trackContent: async (updates: any[]) => { tracked.push(...updates) }
  }
  const scope: any = {
    ipcMain, electronIpcMain: raw, mainWindow, whatsapp, webAdapter: (platform: string) => platform === 'whatsapp' ? whatsapp : platform === 'telegram' ? telegram : undefined, VoiceTranslationService, normalizeSignalPeer, app,
    accounts: { list: async () => records }, translator,
    voice: { recognizeWithLanguage: async (bytes: unknown) => { recognitions.push(bytes); return { text: options.recognize ? await options.recognize() : 'Can you call me tomorrow morning?', language: 'en' } }, get busy() { return options.busy?.() ?? false }, dispose: () => { disposed++; return options.dispose?.() ?? Promise.resolve() } },
    taskIdentity: () => { if (!owner) throw Error('请先登录'); const current = owner, version = revision; return { owner, authorized: () => owner === current && revision === version } },
    requireMain: (value: any) => { if (value.sender.id !== 1) throw Error('main required') },
    accountRuntime: async (id: string, conversationId?: string) => { runtimes.push({ id, conversationId }); await options.runtime?.(); return { localLanguage: 'fr-FR', translationQuality: { style: 'natural' }, providerPreference: 'deepseek' } },
    googleVoiceRecords: { get: async (idOwner: string, id: string) => { if (idOwner !== owner || id !== 'gv-fixture') throw Error('Google Voice window unavailable'); return { translationProvider: gvProvider } } },
    settings: { runtime: async () => ({ localLanguage: 'fr-FR', translationQuality: { style: 'faithful' } }) }, requestChannelPreference,
    // Workspace/embedded-view tests own the complete Google navigation gate. Here
    // a strict gate verifies that this raw IPC delegates to it, and carries its
    // revocable authorization through both asynchronous stages.
    googleVoice: { trustedPage: (value: any) => {
      if (!gvCurrent || value.sender.id !== 12 || value.sender.isDestroyed() || value.senderFrame !== value.sender.mainFrame || value.senderFrame.url !== 'https://voice.google.com/u/0/messages') throw Error('untrusted Google page')
      const current = owner, version = revision
      return { owner, accountId: 'gv-fixture', authorized: () => gvCurrent && owner === current && revision === version && !value.sender.isDestroyed() }
    } }
  }
  // Git may check out this actual production module with CRLF on Windows.
  // Normalize only line endings before matching registration boundaries.
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
  const start = source.indexOf('  const voiceTranslations = new VoiceTranslationService('), end = source.indexOf('  const embeddedVoiceTranslation =', start)
  assert.ok(start > 0 && end > start, 'extract actual voice IPC registrations')
  const signalStart = source.indexOf('}, async (accountId, raw, current) => {', end), signalEnd = source.indexOf("\n  })\n  ipcMain.handle('signal-desktop:status'", signalStart)
  assert.ok(signalStart > end && signalEnd > signalStart, 'extract actual SignalHost voice callback')
  const signalCallback = source.slice(signalStart + 3, signalEnd) + '\n}'
  runInNewContext(ts.transpileModule(source.slice(start, end) + '\nglobalThis.voiceCallback = ' + signalCallback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope)
  const invoke = (name: string, args: unknown[], sender = event()) => Promise.resolve().then(() => { assert.ok(handlers.has(name)); return handlers.get(name)!(sender, ...args) })
  return { ...h, invoke, signal: (id: string, input: any, current = () => true) => scope.voiceCallback(id, input, current), records, recognitions, prepared, translated, runtimes, tracked, preferences, app, disposed: () => disposed, quits: () => quits,
    setOwner: (value: string) => { owner = value; revision++ }, revokeWa: () => { ownsWa = false }, revokeTelegram: () => { ownsTelegram = false }, revokeGv: () => { gvCurrent = false }, setGvProvider: (value: string) => { gvProvider = value },
    closeWindow: () => closed.forEach(fn => fn()), close: () => { closed.forEach(fn => fn()); assert.match(relative(resolve(process.env.TEMP || ''), resolve(h.directory)), /^hellodog-test-[a-zA-Z0-9]+$/); rmSync(h.directory, { recursive: true, force: true }) }
  }
}
const waInput = (patch: any = {}) => ({ conversationId: 'peer:123@c.us', messageId: 'voice:false_123@c.us_FIXTURE', bytes: wav(), ...patch })
const gvEvent = () => event(12, 'https://voice.google.com/u/0/messages')
const gvInput = (patch: any = {}) => ({ bytes: wav(), conversationId: 'google-voice-audio:' + 'a'.repeat(64), messageId: 'voice:google-voice:' + 'b'.repeat(64), ...patch })
const telegramInput = (message = '123') => ({ bytes: wav(), conversationId: 'telegram:-100123:99', messageId: 'voice:telegram:-100123:99:' + message })

test('Telegram voice reaches the shared bilingual service with exact message ownership and retry receipts', async () => {
  const h = fixture(), sender = event(8, 'https://web.telegram.org/a/')
  try {
    const first = await h.invoke('voice:translate-message', ['telegram', telegramInput()], sender)
    const retry = await h.invoke('voice:translate-message', ['telegram', telegramInput()], sender)
    assert.equal(first.translation, '你明天早上能给我打电话吗？'); assert.equal(first.englishTranslation, 'Can you call me tomorrow morning?')
    assert.deepEqual(first, retry); assert.equal(h.recognitions.length, 1); assert.equal(h.translated.length, 1)
    await h.invoke('voice:translate-message', ['telegram', telegramInput('124')], sender)
    assert.equal(h.translated.length, 2); assert.notEqual(h.translated[0].requestId, h.translated[1].requestId)
    assert.equal(h.translated[0].conversationId, telegramInput().conversationId); assert.equal(h.translated[0].providerPreference, 'deepseek')
  } finally { h.close() }
})

test('Telegram voice rejects foreign windows and mismatched thread identity before recognition', async () => {
  const h = fixture()
  try {
    for (const sender of [event(7, 'https://web.telegram.org/a/'), event(8, 'https://web.whatsapp.com/'), event(8, 'https://web.telegram.org/a/', true)]) {
      await assert.rejects(h.invoke('voice:translate-message', ['telegram', telegramInput()], sender))
    }
    for (const input of [telegramInput('0'), telegramInput('malformed'), { ...telegramInput(), conversationId: 'telegram:-100123:100' }]) {
      await assert.rejects(h.invoke('voice:translate-message', ['telegram', input], event(8, 'https://web.telegram.org/a/')))
    }
    assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('Telegram account switch while ASR is running prevents paid work and stale bubble results', async () => {
  const gate = deferred<string>(), h = fixture({ recognize: () => gate.promise })
  try {
    const job = h.invoke('voice:translate-message', ['telegram', telegramInput()], event(8, 'https://web.telegram.org/a/'))
    const rejected = assert.rejects(job, /状态已变化/)
    await until(() => h.recognitions.length === 1); h.revokeTelegram(); gate.resolve('Old voice content.')
    await rejected; assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('owning WhatsApp main-frame voice registers one Chinese translation with exact message/peer and account provider', async () => {
  const h = fixture()
  try {
    const result = await h.invoke('voice:translate-message', ['wa', waInput()], event(7, 'https://web.whatsapp.com/'))
    assert.equal(result.targetLanguage, 'zh-CN'); assert.equal(result.translation, '你明天早上能给我打电话吗？'); assert.match(result.audioId, /^[a-f0-9]{64}$/)
    assert.equal(h.recognitions.length, 1); assert.equal(h.translated.length, 1)
    const request = h.translated[0]
    for (const [key, value] of Object.entries({ accountId: 'wa', conversationId: 'peer:123@c.us', messageId: 'voice:false_123@c.us_FIXTURE', providerPreference: 'deepseek', sourceLanguage: 'auto', targetLanguage: 'zh-CN', manual: true })) assert.equal(request[key], value)
    assert.match(request.requestId, /^voice-zh-[a-f0-9]{64}$/); assert.ok(!Object.hasOwn(request, 'bytes')); assert.ok(!Object.hasOwn(request, 'audioBase64'))
  } finally { h.close() }
})

test('WhatsApp voice IPC rejects other accounts, foreign origins, subframes and unknown windows before recognition', async () => {
  const h = fixture()
  try {
    for (const [id, sender] of [['wa', event(9, 'https://web.whatsapp.com/')], ['signal', event(7, 'https://web.whatsapp.com/')], ['wa', event(7, 'https://evil.invalid/')], ['wa', event(7, 'https://web.whatsapp.com/', true)], ['missing', event()], ['wa', event(1, 'https://evil.invalid/')]] as const) await assert.rejects(h.invoke('voice:translate-message', [id, waInput()], sender))
    assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('WhatsApp conversation and durable message ID must agree; malformed identity cannot reach ASR', async () => {
  const h = fixture()
  try {
    for (const input of [null, waInput({ conversationId: 'peer:456@c.us' }), waInput({ messageId: 'voice:unknown' }), waInput({ messageId: 'voice:false_123@c.us_' }), waInput({ messageId: 'x'.repeat(1001) }), waInput({ conversationId: 'x'.repeat(241) }), waInput({ conversationId: 42 })]) await assert.rejects(h.invoke('voice:translate-message', ['wa', input]))
    assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('WhatsApp sender revocation during recognition suppresses transcript and paid translation', async () => {
  const hold = deferred<string>(), h = fixture({ recognize: () => hold.promise })
  try {
    const job = h.invoke('voice:translate-message', ['wa', waInput()], event(7, 'https://web.whatsapp.com/')), rejected = assert.rejects(job, /状态已变化/)
    await until(() => h.recognitions.length === 1); h.revokeWa(); hold.resolve('Do not disclose old content.'); await rejected
    assert.equal(h.prepared.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('WhatsApp opaque messages use isolated message scopes and stable retry receipts', async () => {
  const h = fixture()
  const input = (id: string) => waInput({ conversationId: 'whatsapp-message:' + id, messageId: 'voice:whatsapp-message:' + id })
  try {
    const sender = event(7, 'https://web.whatsapp.com/')
    const first = await h.invoke('voice:translate-message', ['wa', input('3EB0A123456789')], sender)
    const retry = await h.invoke('voice:translate-message', ['wa', input('3EB0A123456789')], sender)
    assert.deepEqual(first, retry)
    assert.equal(h.translated.length, 1)
    await h.invoke('voice:translate-message', ['wa', input('3EB0B123456789')], sender)
    assert.equal(h.translated.length, 2)
    assert.notEqual(h.translated[0].requestId, h.translated[1].requestId)
    assert.equal(h.translated[0].conversationId, 'whatsapp-message:3EB0A123456789')
    assert.equal(h.translated[0].providerPreference, 'deepseek')
    for (const invalid of [input('short'), input('a'.repeat(129)), input('bad_id_123'),
      { ...input('3EB0A123456789'), conversationId: 'whatsapp-message:3EB0B123456789' },
      { ...input('3EB0A123456789'), conversationId: 'peer:123@c.us' }]) {
      await assert.rejects(h.invoke('voice:translate-message', ['wa', invalid], sender))
    }
    await assert.rejects(h.invoke('voice:translate-message', ['wa', input('3EB0A123456789')], event(9, 'https://web.whatsapp.com/')))
    assert.equal(h.translated.length, 2)
  } finally { h.close() }
})

test('account runtime await cannot carry a voice job into a new signed-in owner', async () => {
  const hold = deferred<void>(), h = fixture({ runtime: () => hold.promise })
  try {
    const job = h.invoke('voice:translate-message', ['wa', waInput()]), rejected = assert.rejects(job, /状态已变化/)
    await until(() => h.runtimes.length === 1); h.setOwner('new-owner'); hold.resolve(); await rejected
    assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('file audio requires trusted shell and valid account; native and Google pages cannot call its generic IPC', async () => {
  const h = fixture()
  try {
    for (const [id, sender] of [['wa', event(7, 'https://web.whatsapp.com/')], ['gv-fixture', gvEvent()], ['missing', event()], ['gv-missing', event()], ['', event()], ['x'.repeat(121), event()]] as const) await assert.rejects(h.invoke('voice:translate-file-audio', [id, wav()], sender))
    assert.equal(h.recognitions.length, 0)
    await h.invoke('voice:translate-file-audio', ['wa', wav()]); await h.invoke('voice:translate-file-audio', ['gv-fixture', wav()])
    assert.equal(h.translated[0].conversationId, 'local-voice-files'); assert.equal(h.translated[0].providerPreference, 'deepseek'); assert.equal(h.translated[1].providerPreference, 'openai')
  } finally { h.close() }
})

test('all three registered byte entry points reject malformed, non-PCM, silent and oversized audio without ASR or charging', async () => {
  const h = fixture()
  try {
    for (const bytes of [null, [1, 2], new Uint8Array([1]), wav().fill(0), new Uint8Array(9_600_046)]) {
      await assert.rejects(h.invoke('voice:translate-file-audio', ['wa', bytes]))
      await assert.rejects(h.invoke('voice:translate-message', ['wa', waInput({ bytes })]))
      await assert.rejects(h.invoke('google-voice:voice-audio', [gvInput({ bytes })], gvEvent()))
    }
    const wrongRate = wav(); new DataView(wrongRate.buffer).setUint32(24, 48000, true)
    await assert.rejects(h.invoke('google-voice:voice-audio', [gvInput({ bytes: wrongRate })], gvEvent()))
    assert.equal(h.recognitions.length, 0); assert.equal(h.prepared.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('Google raw voice handler requires trustedPage and cannot accept an account ID from the page', async () => {
  const h = fixture()
  try {
    for (const sender of [event(), event(13, 'https://voice.google.com/u/0/messages'), event(12, 'https://accounts.google.com/'), event(12, 'https://voice.google.com/u/0/messages', true)]) await assert.rejects(h.invoke('google-voice:voice-audio', [gvInput()], sender), /untrusted/)
    await assert.rejects(h.invoke('google-voice:voice-audio', [{ accountId: 'other', bytes: wav() }], gvEvent()))
    assert.equal(h.recognitions.length, 0)
    await h.invoke('google-voice:voice-audio', [gvInput(), 'other-account'], gvEvent())
    assert.equal(h.translated[0].accountId, 'gv-fixture'); assert.equal(h.translated[0].conversationId, gvInput().conversationId); assert.equal(h.translated[0].messageId, gvInput().messageId); assert.equal(h.translated[0].providerPreference, 'openai'); assert.equal(h.translated[0].targetLanguage, 'zh-CN')
    assert.ok(h.preferences.includes('openai'))
  } finally { h.close() }
})

test('Google page revocation after ASR or during text translation blocks late results', async () => {
  for (const stage of ['recognize', 'translate'] as const) {
    const hold = deferred<string>(), h = fixture({ [stage]: () => hold.promise })
    try {
      const job = h.invoke('google-voice:voice-audio', [gvInput()], gvEvent()), rejected = assert.rejects(job, /状态已变化/)
      await until(() => stage === 'recognize' ? h.recognitions.length === 1 : h.translated.length === 1)
      h.revokeGv(); hold.resolve(stage === 'recognize' ? 'Private transcript.' : '旧页面译文'); await rejected
      if (stage === 'recognize') assert.equal(h.translated.length, 0)
    } finally { h.close() }
  }
})

test('disabled Google provider fails before recognition and never silently falls back to a paid provider', async () => {
  const h = fixture()
  try { h.setGvProvider('disabled'); await assert.rejects(h.invoke('google-voice:voice-audio', [gvInput()], gvEvent()), /unavailable provider/); assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0) } finally { h.close() }
})

test('Google voice rejects missing, mixed-account and malformed row identity before ASR', async () => {
  const h = fixture()
  try {
    for (const input of [null, wav(), gvInput({ accountId: 'other' }), gvInput({ url: 'https://example.invalid/audio' }),
      gvInput({ messageId: 'voice:google-voice:' + 'b'.repeat(63) }), gvInput({ messageId: 'voice:unowned' }),
      gvInput({ conversationId: 'google-voice-audio' }), gvInput({ conversationId: 'google-voice-audio:' + 'A'.repeat(64) })]) {
      await assert.rejects(h.invoke('google-voice:voice-audio', [input], gvEvent()), /语音消息标识/)
    }
    assert.equal(h.recognitions.length, 0); assert.equal(h.prepared.length, 0)
  } finally { h.close() }
})

test('same Google audio in different message bubbles keeps separate receipts; retry preserves its own receipt', async () => {
  const h = fixture()
  try {
    await h.invoke('google-voice:voice-audio', [gvInput()], gvEvent())
    await h.invoke('google-voice:voice-audio', [gvInput()], gvEvent())
    assert.equal(h.recognitions.length, 1); assert.equal(h.translated.length, 1)
    await h.invoke('google-voice:voice-audio', [gvInput({ messageId: 'voice:google-voice:' + 'c'.repeat(64) })], gvEvent())
    await h.invoke('google-voice:voice-audio', [gvInput({ conversationId: 'google-voice-audio:' + 'd'.repeat(64) })], gvEvent())
    assert.equal(h.recognitions.length, 3); assert.equal(h.translated.length, 3)
    assert.equal(new Set(h.translated.map(request => request.requestId)).size, 3)
  } finally { h.close() }
})

test('trusted-shell Signal messages normalize peers, reject invalid peers and keep distinct peers isolated', async () => {
  const h = fixture()
  try {
    await assert.rejects(h.invoke('voice:translate-message', ['signal', waInput({ conversationId: 'bad-peer' })]))
    for (const conversationId of ['+12025550123', '+12025550456']) await h.invoke('voice:translate-message', ['signal', { conversationId, messageId: 'voice:same-attachment', bytes: wav() }])
    assert.equal(h.translated.length, 2); assert.notEqual(h.translated[0].requestId, h.translated[1].requestId); assert.equal(h.translated[0].conversationId, '+12025550123')
  } finally { h.close() }
})

test('SignalHost callback binds native account/message/expiry and uses the same selected-provider Chinese service', async () => {
  const h = fixture()
  try {
    const expiresAt = Date.now() + 60_000
    const result = await h.signal('native', { id: 'message-1', conversationId: 'conversation-1', bytes: wav(), expiresAt })
    assert.equal(result.targetLanguage, 'zh-CN'); assert.equal(h.translated[0].accountId, 'native'); assert.equal(h.translated[0].messageId, 'message-1'); assert.equal(h.translated[0].conversationId, 'signal-desktop:conversation-1'); assert.equal(h.translated[0].providerPreference, 'deepseek')
    assert.equal(h.tracked.length, 1); assert.equal(h.tracked[0].identity, 'message-1'); assert.equal(h.tracked[0].expiresAt, expiresAt); assert.equal(h.tracked[0].owner, 'owner')
  } finally { h.close() }
})

test('SignalHost callback refuses paused/non-native accounts, stale child and expired messages without ASR', async () => {
  const h = fixture()
  try {
    const input = { id: 'message-1', conversationId: 'conversation-1', bytes: wav() }
    for (const id of ['missing', 'wa', 'signal', 'paused']) await assert.rejects(h.signal(id, input))
    await assert.rejects(h.signal('native', input, () => false))
    await assert.rejects(h.signal('native', { ...input, expiresAt: Date.now() - 1 }))
    h.setOwner(''); await assert.rejects(h.signal('native', input), /登录/)
    assert.equal(h.recognitions.length, 0); assert.equal(h.translated.length, 0)
  } finally { h.close() }
})

test('Signal child invalidation after recognition starts and main-window close revoke pending voice work', async () => {
  for (const reason of ['child', 'window'] as const) {
    const hold = deferred<string>(), h = fixture({ recognize: () => hold.promise }); let current = true
    try {
      const job = h.signal('native', { id: 'message-1', conversationId: 'conversation-1', bytes: wav() }, () => current), rejected = assert.rejects(job, /状态已变化/)
      await until(() => h.recognitions.length === 1)
      if (reason === 'child') current = false; else h.closeWindow()
      hold.resolve('Late native transcript.'); await rejected; assert.equal(h.translated.length, 0)
    } finally { h.close() }
  }
})

test('final quit waits for native disposal once; cancelled before-quit and idle quit never interfere', async () => {
  const hold = deferred<void>(); let busy = true
  const h = fixture({ busy: () => busy, dispose: () => hold.promise })
  try {
    let prevented = 0; const quitEvent = { preventDefault: () => { prevented++ } }
    h.app.emit('before-quit', quitEvent)
    assert.equal(h.disposed(), 0); assert.equal(prevented, 0)
    h.app.emit('will-quit', quitEvent); h.app.emit('will-quit', quitEvent)
    assert.equal(prevented, 2); assert.equal(h.disposed(), 1); assert.equal(h.quits(), 0)
    busy = false; hold.resolve(); await until(() => h.quits() === 1)
    h.app.emit('will-quit', quitEvent)
    assert.equal(prevented, 2); assert.equal(h.disposed(), 1); assert.equal(h.quits(), 1)
  } finally { hold.resolve(); h.close() }
})
