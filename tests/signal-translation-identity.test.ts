import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { mainHarness } from './main-harness.ts'

function barrier() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { enter(); await released } }
}

const incoming = { account: '+12025550100', peer: '10000000-0000-4000-8000-000000000001', timestamp: 1, fromMe: false }
const preferences = { localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true,
  historyMode: 'visible', translationsVisible: true, groupTranslate: true, providerPreference: 'openai' }

async function adapterFixture(step: string, provider: 'openai' | 'deepseek' | undefined) {
  const gate = barrier(), calls: string[] = [], requests: any[] = [], events: unknown[] = []
  const h = mainHarness(undefined, undefined, { '../../network/translationChannels': {
    requestChannelPreference: async (choice: string) => { calls.push('channel'); if (step === 'channel') await gate.wait(); return choice }
  } })
  const translator = {
    cached: async () => { calls.push('cached'); if (step === 'cached') await gate.wait(); return undefined },
    translateIncoming: async (request: any) => { calls.push('paid'); requests.push(request); if (step === 'paid') await gate.wait(); return '你今天过得怎么样？' }
  }
  const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts')
  const adapter = new SignalAdapter(translator)
  adapter.setOnlineUser('owner-a')
  adapter.accounts.list = async () => [{ id: 'signal-a', platform: 'signal', signalAccount: incoming.account, translationProvider: provider }]
  adapter.settings.runtime = async () => preferences
  adapter.attachMainWindow({ webContents: { send: (...args: unknown[]) => events.push(args) } })
  await adapter.historyStore.write([{ ...incoming, owner: 'owner-a', original: 'How was your day?' }])
  return { adapter, calls, requests, events, gate, close: () => {
    adapter.stop(); assert.match(basename(h.directory), /^hellodog-test-[a-zA-Z0-9]+$/); rmSync(h.directory, { recursive: true, force: true })
  } }
}

test('Signal persisted-message translation rejects owner changes during real channel lookup before cache or paid work', async () => {
  for (const provider of ['openai', 'deepseek'] as const) for (const restoreOriginalOwner of [false, true]) {
    const h = await adapterFixture('channel', provider)
    try {
      const pending = h.adapter.translateMessage('signal-a', incoming, true), rejected = assert.rejects(pending, /登录状态已变化/)
      await h.gate.entered
      h.adapter.setOnlineUser(restoreOriginalOwner ? '' : 'owner-b')
      if (restoreOriginalOwner) h.adapter.setOnlineUser('owner-a')
      h.gate.release(); await rejected
      assert.deepEqual(h.calls, ['channel']); assert.equal(h.events.length, 0)
    } finally { h.close() }
  }
})

test('Signal persisted-message translation rechecks identity after a slow cache lookup and before billing', async () => {
  const h = await adapterFixture('cached', 'openai')
  try {
    const pending = h.adapter.translateMessage('signal-a', incoming, true), rejected = assert.rejects(pending, /登录状态已变化/)
    await h.gate.entered; h.adapter.setOnlineUser('owner-b'); h.gate.release(); await rejected
    assert.deepEqual(h.calls, ['channel', 'cached']); assert.equal(h.events.length, 0)
  } finally { h.close() }
})

test('Signal discards a paid result when its identity changes without writing it into the new user history', async () => {
  const h = await adapterFixture('paid', 'openai')
  try {
    const pending = h.adapter.translateMessage('signal-a', incoming, true), rejected = assert.rejects(pending, /登录状态已变化/)
    await h.gate.entered; h.adapter.setOnlineUser('owner-b'); h.gate.release(); await rejected
    const history = await h.adapter.historyStore.read()
    assert.equal(history.length, 1); assert.equal(history[0].owner, 'owner-a'); assert.equal(history[0].translated, undefined)
    assert.equal(h.requests.length, 1); assert.equal(h.events.length, 0)
  } finally { h.close() }
})

test('Signal legacy and explicitly selected channels keep translating for an unchanged owner', async () => {
  for (const provider of [undefined, 'deepseek', 'openai'] as const) {
    const h = await adapterFixture('', provider)
    try {
      assert.equal(await h.adapter.translateMessage('signal-a', incoming, true), '你今天过得怎么样？')
      assert.equal(h.requests.length, 1); assert.equal(h.requests[0].providerPreference, provider)
      assert.equal(h.events.length, 1)
    } finally { h.close() }
  }
})

function desktopFixture(step: string) {
  const gate = barrier(), calls: string[] = [], requests: any[] = []
  let owner = 'owner-a', revision = 0, translate!: (accountId: string, raw: any, startedAt: number) => Promise<any>
  const pause = async (name: string) => { calls.push(name); if (step === name) await gate.wait() }
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const signalDesktop = new SignalDesktopHost('), end = source.indexOf("  ipcMain.handle('signal-desktop:status'", start)
  assert.ok(start >= 0 && end > start)
  // Execute the production callback, with only external I/O replaced by gates.
  runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    mainWindow: {}, onlineIdentity: { userId: owner }, createHash,
    SignalDesktopHost: class { constructor(_window: unknown, _owner: unknown, callback: typeof translate) { translate = callback } },
    taskIdentity: () => { const captured = owner, version = revision; return { owner, authorized: () => !!owner && captured === owner && version === revision } },
    accounts: { list: async () => { await pause('accounts'); return [{ id: 'signal-a', platform: 'signal', signalEngine: 'desktop' }] } },
    accountRuntime: async () => { await pause('channel'); return preferences },
    signalNeedsTranslation: () => true, alreadyInTargetLanguage: () => false, hasBlockedChinese: () => false, validateTranslation: () => {},
    outgoingCredit: { check: async (_owner: string, _request: unknown, _translate: boolean, confirmed?: boolean) => pause(confirmed ? 'final-credit' : 'credit') },
    translator: {
      trackContent: async () => pause('retention'),
      preserveOutgoingRequest: async (request: any) => { await pause('preserve-outgoing'); return request },
      preserveIncomingRequest: async (request: any) => { await pause('preserve-incoming'); return request },
      prepareOutgoingRequest: async (request: any) => { await pause('prepare'); return request },
      cached: async () => { await pause('cached'); return undefined },
      translate: async (request: any) => { requests.push(request); await pause('paid-outgoing'); return 'Please confirm the meeting tomorrow.' },
      translateIncoming: async (request: any) => { requests.push(request); await pause('paid-incoming'); return '请确认明天的会议。' },
      restoreSignalOutgoing: async () => { await pause('restore'); return { request: { requestId: 'send-sd-fixture', targetLanguage: 'en-US' }, text: 'Please confirm the meeting tomorrow.' } }
    }
  })
  const invoke = (direction: 'incoming' | 'outgoing', extra: Record<string, unknown> = {}) => translate('signal-a', {
    id: 'native-message', conversationId: 'peer', text: direction === 'incoming' ? 'Please confirm the meeting tomorrow.' : '请确认明天的会议。', direction, ...extra
  }, 0)
  return { gate, calls, requests, invoke, setOwner: (value: string) => { owner = value; revision++ } }
}

test('Signal Desktop rejects identity races at each asynchronous boundary before paid translation', async () => {
  const scenarios = [
    ['outgoing', 'accounts'], ['outgoing', 'channel'], ['outgoing', 'preserve-outgoing'], ['outgoing', 'prepare'], ['outgoing', 'credit'],
    ['incoming', 'channel'], ['incoming', 'preserve-incoming'], ['incoming', 'cached']
  ] as const
  for (const [direction, step] of scenarios) for (const restoreOriginalOwner of [false, true]) {
    const h = desktopFixture(step), pending = h.invoke(direction), rejected = assert.rejects(pending, /登录状态已变化/, step)
    await h.gate.entered; h.setOwner(restoreOriginalOwner ? '' : 'owner-b'); if (restoreOriginalOwner) h.setOwner('owner-a')
    h.gate.release(); await rejected
    assert.equal(h.requests.length, 0, step); assert.equal(h.calls.includes('final-credit'), false, step)
  }
})

test('Signal Desktop rejects stale retention and send-authorization completions before any billing check', async () => {
  for (const step of ['retention', 'restore']) {
    const h = desktopFixture(step), pending = h.invoke('outgoing', step === 'retention' ? { expiresAt: Date.now() + 60000 } : { authorizationOnly: true, requestId: 'send-sd-fixture' })
    const rejected = assert.rejects(pending, /登录状态已变化/)
    await h.gate.entered; h.setOwner('owner-b'); h.gate.release(); await rejected
    assert.equal(h.requests.length, 0); assert.equal(h.calls.includes('credit'), false); assert.equal(h.calls.includes('final-credit'), false)
  }
})

test('Signal Desktop suppresses paid output after logout and preserves normal channel choice without identity changes', async () => {
  for (const direction of ['outgoing', 'incoming'] as const) {
    const h = desktopFixture('paid-' + direction), pending = h.invoke(direction), rejected = assert.rejects(pending, /登录状态已变化/)
    await h.gate.entered; h.setOwner(''); h.gate.release(); await rejected
    assert.equal(h.requests.length, 1); assert.equal(h.calls.includes('final-credit'), false)
    const normal = desktopFixture(''), result = await normal.invoke(direction)
    assert.equal(result.enabled, true); assert.equal(normal.requests.length, 1); assert.equal(normal.requests[0].providerPreference, 'openai')
  }
})
