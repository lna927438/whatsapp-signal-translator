import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { mainHarness } from './main-harness.ts'

const tgUrl = 'https://web.telegram.org/a/#101'
const appUrl = new URL('../src/renderer/index.html', import.meta.url).href
function event(id = 11, url = tgUrl, child = false) {
  const mainFrame = { url }
  return { sender: { id, mainFrame, isDestroyed: () => false }, senderFrame: child ? { url } : mainFrame }
}
const adapters = () => ({
  whatsapp: { ownsSender: (id: string, sender: number) => id === 'wa' && sender === 7 },
  telegram: { ownsSender: (id: string, sender: number) => id === 'tg-a' && sender === 11 || id === 'tg-b' && sender === 12 }
})

test('Telegram bridge requires the owning registered Web A main frame and cannot borrow WhatsApp or settings routes', async () => {
  const h = mainHarness()
  try {
    const { createSecureIpc } = h.load('src/main/secureIpc.ts'), { whatsapp, telegram } = adapters()
    const handles = new Map<string, Function>(), events = new Map<string, Function>(), called: string[] = []
    const secure = createSecureIpc({ handle: (name: string, fn: Function) => handles.set(name, fn), on: (name: string, fn: Function) => events.set(name, fn) }, { webContents: { id: 1 } }, whatsapp, telegram)
    for (const name of ['translator:translate-incoming', 'translator:get-runtime-settings', 'voice:translate-message', 'draft:save', 'send:prepare', 'settings:save', 'auth:storage-get', 'whatsapp:edit-composer', 'telegram:edit-composer']) secure.handle(name, () => { called.push(name); return 'allowed' })
    secure.on('telegram:unread', () => called.push('unread'))
    for (const name of ['translator:translate-incoming', 'translator:get-runtime-settings', 'voice:translate-message', 'telegram:edit-composer']) assert.equal(handles.get(name)!(event(), 'tg-a', {}), 'allowed')
    assert.equal(handles.get('draft:save')!(event(), { accountId: 'tg-a', conversationId: 'telegram:101:0' }, 'saved'), 'allowed')
    assert.equal(handles.get('send:prepare')!(event(), { accountId: 'tg-a', platform: 'telegram' }), 'allowed')
    const before = called.length
    for (const e of [event(12), event(99), event(11, 'https://web.telegram.org/k/'), event(11, 'https://web.telegram.org/a-attacker/'), event(11, 'https://web.telegram.org.evil.invalid/a/'), event(11, 'https://user@web.telegram.org/a/'), event(11, tgUrl, true), event(7, 'https://web.whatsapp.com/')]) assert.throws(() => handles.get('translator:translate-incoming')!(e, 'tg-a', {}))
    for (const name of ['settings:save', 'auth:storage-get', 'whatsapp:edit-composer']) assert.throws(() => handles.get(name)!(event(), 'tg-a', {}))
    assert.throws(() => handles.get('send:prepare')!(event(), { accountId: 'tg-a', platform: 'whatsapp' }))
    assert.throws(() => handles.get('draft:save')!(event(), { accountId: 'tg-b' }, 'overwrite'))
    events.get('telegram:unread')!(event(12), 'tg-a', 5)
    assert.equal(called.length, before, 'rejected calls must never enter the handler')
    events.get('telegram:unread')!(event(), 'tg-a', 5)
    assert.equal(called.at(-1), 'unread')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

function integration() {
  const handlers = new Map<string, Function>(), windowEvents = new EventEmitter(), power = new EventEmitter()
  const h = mainHarness({ ipcMain: { on() {}, handle: (name: string, fn: Function) => handlers.set(name, fn) }, powerMonitor: power, dialog: { showMessageBox: async () => ({ response: 1 }) } })
  const { SendTasks, SendNotStartedError, SendPendingError } = h.load('src/main/translation/sendTasks.ts')
  const { JsonStore } = h.load('src/main/storage/jsonStore.ts'), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts')
  const { createSecureIpc } = h.load('src/main/secureIpc.ts')
  let owner = 'owner', revision = 0, uncertain = false, sends = 0, tgRefreshes = 0, waRefreshes = 0
  const calls: any[] = [], records = [{ id: 'tg-a', platform: 'telegram' }, { id: 'tg-b', platform: 'telegram' }, { id: 'wa', platform: 'whatsapp' }]
  const { whatsapp: waBase, telegram: tgBase } = adapters()
  const whatsapp = { ...waBase, resumeTranslations() {}, refreshTranslations() { waRefreshes++ }, reconcileTask: async () => null }
  const telegram = { ...tgBase, resumeTranslations() {}, refreshTranslations() { tgRefreshes++ }, reconcileTask: async () => null,
    submitTask: async (task: any, authorized: () => boolean) => { assert.ok(authorized()); sends++; if (uncertain) throw new SendPendingError({ baseline: ['1'], targetKey: task.targetKey }); return { messageId: task.conversationId + ':' + (100 + sends), confirmed: true } } }
  const window = { webContents: { id: 1, send() {} }, isDestroyed: () => false, on: windowEvents.on.bind(windowEvents) }
  const tasks = new SendTasks(new JsonStore('outgoing-tasks-v1.json', { tasks: [] }, true)), translator = new TranslationEngine()
  translator.setOnlineSession(owner, 'synthetic-token'); translator.settings.get = async () => ({ provider: 'openai' })
  translator.createProvider = () => ({ translate: async (request: any) => {
    calls.push(request)
    const translated = request.targetLanguage === 'zh-CN' ? '请确认明天上午的安排。' : 'Please confirm tomorrow morning.'
    await translator.receipts.update(owner, request.requestId, { state: 'charged', translated, chargedCharacters: Array.from(request.text).length })
    return translated
  } })
  const identity = () => { const user = owner, version = revision; if (!user) throw Error('请先登录'); return { owner: user, authorized: () => owner === user && revision === version } }
  const signal = { resumeReceiving: async () => {}, flushHistory: async () => {}, submitTask: async () => { throw Error('Telegram task must never reach Signal') } }
  const register = h.load('src/main/reliabilityIpc.ts').registerReliabilityIpc
  const { drafts } = register(window, { list: async () => records }, {}, tasks, translator, whatsapp, signal, () => identity().owner, undefined, telegram)
  const ipcMain = createSecureIpc({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, window, whatsapp, telegram)
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
  const guardStart = source.indexOf('  const assertTaskSender ='), guardEnd = source.indexOf('  const requireAuth =', guardStart)
  const sendsStart = source.indexOf("  ipcMain.handle('send:prepare'"), sendsEnd = source.indexOf("  ipcMain.on('whatsapp:unread'", sendsStart)
  assert.ok(guardStart > 0 && guardEnd > guardStart && sendsStart > 0 && sendsEnd > sendsStart, 'exercise actual production handler blocks')
  runInNewContext(ts.transpileModule(source.slice(guardStart, guardEnd) + source.slice(sendsStart, sendsEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMain, mainWindow: window, webAdapter: (platform: string) => platform === 'telegram' ? telegram : platform === 'whatsapp' ? whatsapp : undefined,
    sendTasks: tasks, translator, drafts, SendNotStartedError, createHash, taskIdentity: identity, accounts: { list: async () => records }, signal,
    outgoingCredit: { check: async () => {} }, accountStatus: { assertAvailable() {} },
    accountRuntime: async () => ({ sendAutoTranslate: true, localLanguage: 'zh-CN', targetLanguage: 'en-US' })
  })
  const invoke = (name: string, args: unknown[], e = event()) => Promise.resolve().then(() => handlers.get(name)!(e, ...args))
  const input = (intentId: string, text = '请帮我确认明天上午的安排。') => ({ platform: 'telegram', accountId: 'tg-a', conversationId: 'telegram:101:0', targetKey: 'peer:telegram:101:0', intentId, text })
  return { ...h, invoke, input, tasks, translator, calls, drafts, sends: () => sends, refreshes: () => ({ telegram: tgRefreshes, whatsapp: waRefreshes }), uncertain: () => { uncertain = true },
    changeOwner: (next: string) => { owner = next; revision++; translator.setOnlineSession(next, 'synthetic-token') },
    close: async () => { windowEvents.emit('closed'); await translator.flush(); await tasks.flush(); await drafts.flush(); rmSync(h.directory, { recursive: true, force: true }) } }
}

test('actual Telegram draft and send handlers bind each task to its account and never fall through to Signal', async () => {
  const h = integration()
  try {
    const target = { accountId: 'tg-a', conversationId: 'telegram:101:0', targetKey: 'peer:telegram:101:0' }
    await h.invoke('draft:save', [target, '保存草稿'])
    assert.equal(await h.invoke('draft:get', [target]), '保存草稿')
    for (const e of [event(12), event(7, 'https://web.whatsapp.com/'), event(11, tgUrl, true), event(11, 'https://evil.invalid/')]) await assert.rejects(h.invoke('draft:save', [target, 'bad overwrite'], e))
    const task = await h.invoke('send:prepare', [h.input('intent-safe-send-001')])
    for (const name of ['send:translate', 'send:submit', 'send:cancel']) {
      await assert.rejects(h.invoke(name, [task.id], event(12)), /账号|窗口/)
      await assert.rejects(h.invoke(name, [task.id], event(7, 'https://web.whatsapp.com/')), /账号|窗口/)
    }
    assert.equal(h.calls.length, 0); assert.equal(h.sends(), 0)
    await h.invoke('send:translate', [task.id]); await h.invoke('send:submit', [task.id])
    assert.equal(h.calls.length, 1); assert.equal(h.sends(), 1)
    assert.equal((await h.tasks.get('owner', task.id)).state, 'sent')
    h.changeOwner('other')
    await assert.rejects(h.invoke('send:submit', [task.id]), /不存在|账号/)
    assert.equal(await h.invoke('draft:get', [target]), '')
    assert.equal(h.sends(), 1)
  } finally { await h.close() }
})

test('Telegram distinct messages retain separate billing and original text; same intent retries share one translation and one send', async () => {
  const h = integration()
  try {
    const firstInput = h.input('intent-billing-first'), first = await h.invoke('send:prepare', [firstInput])
    const duplicate = await h.invoke('send:prepare', [firstInput])
    assert.equal(duplicate.id, first.id)
    await Promise.all(Array.from({ length: 6 }, () => h.invoke('send:translate', [first.id])))
    await Promise.all(Array.from({ length: 6 }, () => h.invoke('send:submit', [first.id])))
    const secondInput = h.input('intent-billing-second', '麻烦帮我确认明天上午的计划。'), second = await h.invoke('send:prepare', [secondInput])
    await h.invoke('send:translate', [second.id]); await h.invoke('send:submit', [second.id])
    assert.equal(h.calls.length, 2); assert.equal(h.sends(), 2)
    assert.notEqual(first.id, second.id)
    const firstSent = await h.tasks.get('owner', first.id), secondSent = await h.tasks.get('owner', second.id)
    assert.equal(firstSent.translated, secondSent.translated)
    assert.equal(await h.tasks.originalForMessage('owner', 'tg-a', firstSent.result.messageId, firstSent.translated), firstInput.text)
    assert.equal(await h.tasks.originalForMessage('owner', 'tg-a', secondSent.result.messageId, secondSent.translated), secondInput.text)
    assert.equal(await h.tasks.originalForMessage('owner', 'tg-a', 'telegram:202:0:101', firstSent.translated), undefined)
    assert.equal(await h.tasks.originalForMessage('other', 'tg-a', firstSent.result.messageId, firstSent.translated), undefined)
    const incoming = { text: 'Please confirm tomorrow morning.', accountId: 'tg-a', conversationId: 'telegram:101:0', targetLanguage: 'zh-CN', sourceLanguage: 'auto' }
    await h.translator.translateIncoming({ ...incoming, messageId: 'telegram:101:0:901' })
    await h.translator.translateIncoming({ ...incoming, messageId: 'telegram:101:0:902' })
    await h.translator.translateIncoming({ ...incoming, messageId: 'telegram:101:0:901' })
    assert.equal(h.calls.length, 4, 'distinct native messages are billed separately while replay is free')
    assert.equal(new Set(h.calls.map(item => item.requestId)).size, 4)
  } finally { await h.close() }
})

test('Telegram uncertain dispatch stays pending without automatic resend, and foreign tasks cannot confirm it', async () => {
  const h = integration()
  try {
    h.uncertain()
    const input = h.input('intent-uncertain-001'), task = await h.invoke('send:prepare', [input])
    await h.invoke('send:translate', [task.id])
    assert.equal((await h.invoke('send:submit', [task.id])).state, 'uncertain')
    assert.equal((await h.invoke('send:prepare', [input])).id, task.id)
    await h.invoke('send:translate', [task.id])
    await assert.rejects(h.invoke('send:submit', [task.id]), /后台确认|重复发送/)
    await assert.rejects(h.invoke('send:confirm-sent', [task.id], event(12)), /账号|窗口/)
    await h.invoke('reliability:recover', [], event(1, appUrl))
    assert.equal(h.calls.length, 1); assert.equal(h.sends(), 1)
    await h.tasks.resolveWithEvidence('owner', task.id, { messageId: 'telegram:101:0:999', confirmed: true })
    assert.equal((await h.invoke('send:submit', [task.id])).state, 'sent')
    assert.equal(h.sends(), 1)
  } finally { await h.close() }
})

test('Telegram translation failure and a Chinese manual preview preserve the original without platform dispatch', async () => {
  const h = integration()
  try {
    const first = await h.invoke('send:prepare', [h.input('intent-chinese-guard')])
    await h.invoke('send:translate', [first.id])
    await h.invoke('send:edit-preview', [first.id, '这个手动修改的内容还是中文'])
    await assert.rejects(h.invoke('send:submit', [first.id]), /中文/)
    assert.equal((await h.tasks.get('owner', first.id)).request.text, first.request.text)
    h.translator.createProvider = () => ({ translate: async () => { throw Error('simulated network loss') } })
    const second = await h.invoke('send:prepare', [h.input('intent-network-guard', '请帮我核对下周的预约时间。')])
    await assert.rejects(h.invoke('send:translate', [second.id]), /network loss/)
    await assert.rejects(h.invoke('send:submit', [second.id]), /译文尚未确认/)
    const saved = await h.tasks.get('owner', second.id)
    assert.equal(saved.state, 'draft'); assert.equal(saved.request.text, second.request.text)
    assert.equal(h.sends(), 0)
  } finally { await h.close() }
})

test('actual correction, restoration and retention handlers refresh Telegram without a new paid translation', async () => {
  const h = integration()
  try {
    const task = await h.invoke('send:prepare', [h.input('intent-refresh-001')])
    await h.invoke('send:translate', [task.id])
    await assert.rejects(h.invoke('reliability:correct', [task.id, 'Please confirm tomorrow.']), /当前账号|阻止/)
    assert.equal(h.refreshes().telegram, 0)
    const main = event(1, appUrl)
    await h.invoke('reliability:correct', [task.id, 'Please confirm tomorrow.'], main)
    await h.invoke('reliability:restore-correction', [task.id], main)
    await h.invoke('reliability:set-retention', [7], main)
    assert.deepEqual(h.refreshes(), { telegram: 3, whatsapp: 3 })
    assert.equal(h.calls.length, 1); assert.equal(h.sends(), 0)
  } finally { await h.close() }
})

test('Telegram account creation and reorder retain platform boundaries and reject unknown platforms', async () => {
  const h = mainHarness()
  try {
    const { AccountManager } = h.load('src/main/accounts/accountManager.ts'), accounts = new AccountManager()
    const first = await accounts.add('telegram'), second = await accounts.add('telegram'), wa = await accounts.add('whatsapp')
    assert.match(first.label, /^Telegram /)
    await accounts.reorder('telegram', [second.id, first.id])
    const values = await accounts.list()
    assert.equal(values.find((item: any) => item.id === first.id).tabOrder, 1)
    assert.equal(values.find((item: any) => item.id === second.id).tabOrder, 0)
    assert.equal(values.find((item: any) => item.id === wa.id).tabOrder, undefined)
    await assert.rejects(accounts.reorder('telegram', [first.id, wa.id]), /账号列表/)
    for (const platform of ['unknown', 'googlevoice', '__proto__']) {
      await assert.rejects(accounts.add(platform), /支持的应用/)
      await assert.rejects(accounts.addBatch(platform, 'fixture', 2, {}), /支持的应用/)
      await assert.rejects(accounts.reorder(platform, []), /账号顺序/)
    }
    assert.equal((await accounts.list()).length, 3)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Telegram microphone permission is tied to the official current document, account and audio device', async () => {
  let check!: Function, request!: Function, answer!: (value: { response: number }) => void
  const session = Object.assign(new EventEmitter(), { setPermissionCheckHandler: (fn: Function) => { check = fn }, setPermissionRequestHandler: (fn: Function) => { request = fn }, setDisplayMediaRequestHandler() {} })
  const h = mainHarness({ app: { isPackaged: true }, BrowserWindow: { fromWebContents: () => null }, dialog: { showMessageBox: () => new Promise(resolve => { answer = resolve }) } })
  try {
    const { installWebSecurity } = h.load('src/main/webSecurity.ts')
    const make = (id: number, url = tgUrl) => Object.assign(new EventEmitter(), { id, session, isDestroyed: () => false, getURL: () => url, setWindowOpenHandler() {} })
    const first = make(11), second = make(12), unregistered = make(13), foreign = make(14, 'https://evil.invalid/a/')
    installWebSecurity(first, 'telegram'); installWebSecurity(second, 'telegram'); installWebSecurity(foreign, 'telegram')
    const details = { requestingUrl: 'https://web.telegram.org', isMainFrame: true, mediaTypes: ['audio'] }
    const grant = (wc: unknown, changes = {}) => new Promise<boolean>(resolve => request(wc, 'media', resolve, { ...details, ...changes }))
    const allowed = grant(first); answer({ response: 1 }); assert.equal(await allowed, true)
    const media = { isMainFrame: true, mediaType: 'audio' }, origin = 'https://web.telegram.org'
    assert.equal(check(first, 'media', origin, media), true)
    assert.equal(check(first, 'media', origin, { ...media, mediaType: 'video' }), false)
    assert.equal(check(first, 'media', origin, { ...media, isMainFrame: false }), false)
    assert.equal(check(second, 'media', origin, media), false)
    assert.equal(await grant(unregistered), false); assert.equal(await grant(foreign), false)
    assert.equal(await grant(first, { requestingUrl: 'https://evil.invalid' }), false)
    assert.equal(await grant(first, { isMainFrame: false }), false)
    first.emit('did-start-navigation', {}, tgUrl, false, true)
    assert.equal(check(first, 'media', origin, media), false)
    const pending = grant(second); second.emit('did-start-navigation', {}, tgUrl, false, true); answer({ response: 1 }); assert.equal(await pending, false)
    first.emit('destroyed'); const reused = make(11); installWebSecurity(reused, 'telegram')
    assert.equal(check(reused, 'media', origin, media), false)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})
