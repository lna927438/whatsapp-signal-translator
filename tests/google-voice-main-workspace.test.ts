import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

const A = 'gv-10000000-0000-4000-8000-000000000001', B = 'gv-20000000-0000-4000-8000-000000000002'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
function fixture() {
  let owner = 'owner-a', authRevision = 0, zoom = 1
  const calls: any[] = [], views: FakeView[] = [], sessions = new Map<string, any>(), getGates = new Map<string, Promise<void>>()
  const data: any[] = [A, B].map((id, tabOrder) => ({ id, owner, label: id, tabOrder, browser: 'chrome', closed: false }))
  const records = {
    list: async (who: string) => data.filter(row => row.owner === who && !row.closed),
    get: async (who: string, id: string) => { await getGates.get(id); const row = data.find(row => row.id === id && row.owner === who && !row.closed); if (!row) throw new Error('missing'); return row },
    proxyPassword: async (who: string, id: string) => { await records.get(who, id); return '' },
    add: async (who: string) => { const row = { id: 'gv-30000000-0000-4000-8000-000000000003', owner: who, label: 'Google Voice 3', tabOrder: 2, browser: 'chrome', closed: false }; data.push(row); return row },
    update: async (who: string, id: string, patch: any) => { const row = await records.get(who, id); Object.assign(row, patch); return row },
    reorder: async (who: string, ids: string[]) => { const rows = await records.list(who); rows.forEach(row => { row.tabOrder = ids.indexOf(row.id) }); return rows.sort((a, b) => a.tabOrder - b.tabOrder) }
  }
  function fromPartition(key: string): any {
    if (!sessions.has(key)) sessions.set(key, Object.assign(new EventEmitter(), { partition: key, setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {}, webRequest: { onBeforeRequest() {} }, async setProxy(config: any) { calls.push(['proxy', key, config]) }, async closeAllConnections() {}, async clearAuthCache() {} }))
    return sessions.get(key)
  }
  class FakeContents extends EventEmitter {
    destroyed = false; url = ''; reloads = 0; history = false; focused = false; session: any; mainFrame: any; sent: any[] = []; open: any
    navigationHistory = { canGoBack: () => this.history, goBack: () => { calls.push(['back']) } }
    constructor(options: any = {}) { super(); this.session = options.session || fromPartition(options.partition); const wc = this; this.mainFrame = { get url() { return wc.url }, detached: false } }
    getURL() { return this.url } isDestroyed() { return this.destroyed }
    setWebRTCIPHandlingPolicy() {}
    loadURL(url: string) { this.url = url; calls.push(['load', url]); return Promise.resolve() }
    setWindowOpenHandler(callback: any) { this.open = callback }
    focus() { this.focused = true }
    send(...args: any[]) { this.sent.push(args); calls.push(['send', ...args]) }
    reload() { this.reloads++ }
    close() { this.destroyed = true; this.emit('destroyed') }
    getZoomFactor() { return zoom }
  }
  class FakeView {
    visible = false; bounds: any; webContents: FakeContents
    constructor(public options: any) { this.webContents = options.webContents || new FakeContents(options.webPreferences); views.push(this) }
    setVisible(value: boolean) { this.visible = value } setBounds(value: any) { this.bounds = value } setBackgroundColor() {}
  }
  class FakeWindow extends EventEmitter {
    destroyed = false; visible = true; minimized = false; focused = false; private contents = new FakeContents(); children: FakeView[] = []
    get webContents() { if (this.destroyed) throw new TypeError('Object has been destroyed'); return this.contents }
    contentView = { addChildView: (view: FakeView) => this.children.push(view), removeChildView: (view: FakeView) => { this.children = this.children.filter(item => item !== view) } }
    getContentSize() { return [1400, 1000] } isDestroyed() { return this.destroyed } isVisible() { return this.visible } isMinimized() { return this.minimized }
    isFocused() { return this.focused }
    close() { this.destroyed = true; this.contents.close(); this.emit('closed') }
  }
  const window = new FakeWindow()
  const h = mainHarness({ WebContentsView: FakeView, session: { fromPartition }, screen: { getDisplayMatching: () => { throw new Error('Native DPI conversion must not be used') } } })
  const { GoogleVoiceWorkspace } = h.load('src/main/platforms/googleVoice/workspace.ts')
  const identity = () => { if (!owner) throw new Error('not logged in'); const saved = owner, revision = authRevision; return { owner, authorized: () => owner === saved && revision === authRevision } }
  const activity: any[] = []
  const workspace = new GoogleVoiceWorkspace(window, records, identity, { preloadPath: 'D:/HelloDog/preload/googleVoice.js', onUnread: (id:string,count:number|null) => activity.push(['unread',id,count]), notify: (id:string,authorized:()=>boolean) => activity.push(['notify',id,authorized]), clearNotifications: (id:string) => activity.push(['clear',id]) })
  const focus = workspace.focus.bind(workspace)
  workspace.focus = async (...args: any[]) => { const result = await focus(...args); await tick(); return result }
  workspace.setBounds({ x: 50, y: 100, width: 900, height: 650 })
  return { workspace, window, records, data, calls, views, sessions, getGates, activity, setOwner: (value: string) => { owner = value; authRevision++ }, setZoom: (value: number) => { zoom = value; window.webContents.emit('zoom-changed') } }
}

test('workspace opens actual child views, preserves record identities and never binds a Chrome process', async () => {
  const h = fixture(); assert.equal((await h.workspace.focus(A)).state, 'loading')
  assert.equal(h.views.length, 1); assert.equal(h.window.children.length, 1); assert.equal(h.views[0].visible, true)
  assert.equal(h.views[0].options.webPreferences.preload, 'D:/HelloDog/preload/googleVoice.js')
  await h.workspace.focus(A); assert.equal(h.views.length, 1)
  assert.equal(h.data[0].browser, 'chrome'); assert.equal(h.data[0].id, A)
})

test('workspace CRUD remains owner-scoped and safe metadata excludes storage and owner details', async () => {
  const h = fixture(), listed = await h.workspace.list()
  assert.equal(listed.length, 2); assert.equal(listed[0].owner, undefined)
  assert.equal((await h.workspace.update(A, { label: 'Primary' })).label, 'Primary')
  assert.equal((await h.workspace.reorder([B, A]))[0].id, B)
  assert.equal((await h.workspace.add()).label, 'Google Voice 3')
  await assert.rejects(h.workspace.update(A, {}), /窗口设置无效/)
})

test('changing one proxy invalidates its old view and keeps other accounts and login partitions', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.focus(B)
  const a = h.views[0].webContents, b = h.views[1].webContents, session = a.session
  const result = await h.workspace.update(A, { proxy: { enabled: true, protocol: 'http', host: 'proxy.invalid', port: 3128 } })
  assert.equal(result.proxy.host, 'proxy.invalid'); assert.equal(result.proxySecret, undefined)
  assert.equal(a.destroyed, true); assert.equal(b.destroyed, false); assert.equal(h.views[1].visible, true)
  await h.workspace.focus(A); const replacement = h.views[2].webContents
  assert.equal(replacement.session, session)
  await h.workspace.refresh(A); assert.equal(replacement.destroyed, true)
  assert.equal(h.views[3].webContents.session, session); assert.equal(b.destroyed, false)
})

test('disabled proxy never decrypts an obsolete password, and a slow refresh cannot steal another selection', async () => {
  const h = fixture(); h.data[0].proxy = { enabled: false, protocol: 'http', host: 'old.invalid', port: 3128 }
  h.records.proxyPassword = async () => { throw new Error('saved secret unavailable') }
  await h.workspace.focus(A); assert.equal(h.views[0].webContents.url, 'https://voice.google.com/u/0/')
  const gate = deferred(); h.getGates.set(A, gate.promise)
  const late = h.workspace.refresh(A); await h.workspace.focus(B); gate.resolve()
  assert.equal((await late).state, 'cancelled'); assert.equal(h.views[1].visible, true)
})

test('a late record lookup cannot restore an earlier selection or create an abandoned view', async () => {
  const h = fixture(), gate = deferred(); h.getGates.set(A, gate.promise)
  const earlier = h.workspace.focus(A); await h.workspace.focus(B); gate.resolve()
  assert.equal((await earlier).state, 'cancelled'); assert.equal(h.views.length, 1); assert.equal(h.views[0].visible, true)
})

test('hide cancels pending focus and preserves the view and its page draft', async () => {
  const h = fixture(); await h.workspace.focus(A)
  h.views[0].webContents.url = 'https://voice.google.com/u/0/messages?itemId=synthetic'
  h.workspace.hide(); assert.equal(h.views[0].visible, false); assert.equal(h.views[0].webContents.destroyed, false)
  await h.workspace.focus(A); assert.equal(h.views[0].webContents.url.includes('itemId=synthetic'), true)
  const gate = deferred(); h.getGates.set(B, gate.promise); const pending = h.workspace.focus(B); h.workspace.hide(); gate.resolve()
  assert.equal((await pending).state, 'cancelled'); assert.equal(h.views.length, 1)
})

test('overlay and minimization hide all content and restore only the selected account', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.focus(B)
  h.workspace.setOverlayOpen(true); assert.ok(h.views.every(view => !view.visible))
  h.workspace.setOverlayOpen(false); assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
  h.window.minimized = true; h.window.emit('minimize'); assert.ok(h.views.every(view => !view.visible))
  h.window.minimized = false; h.window.emit('restore'); assert.equal(h.views[1].visible, true)
})

test('CSS bounds use main UI zoom exactly once without monitor DPI scaling', async () => {
  const h = fixture(); h.setZoom(1.25); await h.workspace.focus(A)
  assert.equal(h.views[0].bounds.x, 63); assert.equal(h.views[0].bounds.y, 125)
  assert.equal(h.views[0].bounds.width, 1125); assert.equal(h.views[0].bounds.height, 813)
  h.setZoom(1); assert.equal(h.views[0].bounds.width, 900)
  h.workspace.setBounds({ x: 0, y: 0, width: 0, height: 0 }); assert.equal(h.views[0].visible, false)
})

test('external and extension compatibility actions remain inside the same client view', async () => {
  const h = fixture(); await h.workspace.focus(A)
  await h.workspace.external(A); assert.equal((await h.workspace.extensionSetup(A)).embedded, true)
  assert.equal(h.views.length, 1); assert.equal(h.window.children.length, 1)
  assert.equal(h.calls.filter(call => call[0] === 'load').length, 1)
})

test('refresh reloads the real embedded page and back uses its own Chromium history', async () => {
  const h = fixture(); await h.workspace.focus(A); h.views[0].webContents.history = true
  assert.equal(await h.workspace.back(A), true); assert.equal((await h.workspace.refresh(A)).state, 'loading')
  assert.equal(h.views[0].webContents.reloads, 1); assert.equal(h.calls.filter(call => call[0] === 'back').length, 1)
})

test('closing an inactive account preserves the active one and marks only its own record closed', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.focus(B); await h.workspace.close(A)
  assert.equal(h.views[0].webContents.destroyed, true); assert.equal(h.views[1].visible, true)
  assert.equal(h.data[0].closed, true); assert.equal(h.data[1].closed, false)
})

test('logout destroys live views immediately, cancels pending opens and retains persistent session storage', async () => {
  const h = fixture(); await h.workspace.focus(A)
  const session = h.views[0].webContents.session, gate = deferred(); h.getGates.set(B, gate.promise)
  const pending = h.workspace.focus(B); await h.workspace.detachAll(); gate.resolve()
  assert.equal((await pending).state, 'cancelled'); assert.equal(h.views[0].webContents.destroyed, true)
  assert.equal(h.data[0].closed, false); assert.equal(h.sessions.get(session.partition), session)
  await h.workspace.focus(A); assert.equal(h.views[1].webContents.session, session)
})

test('owner change or same-owner reauthentication invalidates trusted in-flight translation authorization', async () => {
  const h = fixture(); await h.workspace.focus(A); const wc = h.views[0].webContents, event = { sender: wc, senderFrame: wc.mainFrame }
  const page = h.workspace.trustedPage(event); assert.equal(page.owner, 'owner-a'); assert.equal(page.accountId, A); assert.equal(page.authorized(), true)
  h.setOwner('owner-a'); assert.equal(page.authorized(), false)
  const renewed = h.workspace.trustedPage(event); assert.equal(renewed.authorized(), true)
  h.setOwner('owner-b'); assert.equal(renewed.authorized(), false); assert.throws(() => h.workspace.trustedPage(event), /页面或登录状态已变化/)
})

test('settings changes, closing and logout revoke registered page contexts across await boundaries', async () => {
  const h = fixture(); await h.workspace.focus(A); const wc = h.views[0].webContents, event = { sender: wc, senderFrame: wc.mainFrame }
  let page = h.workspace.trustedPage(event); h.workspace.invalidateContext(); assert.equal(page.authorized(), false)
  page = h.workspace.trustedPage(event); await h.workspace.close(A); assert.equal(page.authorized(), false)
  assert.throws(() => h.workspace.trustedPage(event), /主页面/)
  await h.workspace.focus(B); const other = h.views[1].webContents
  page = h.workspace.trustedPage({ sender: other, senderFrame: other.mainFrame }); await h.workspace.detachAll(); assert.equal(page.authorized(), false)
})

test('consent is explicit per account and ownership is rechecked after local record lookup', async () => {
  const h = fixture(); assert.equal((await h.workspace.getPermissions(A)).microphone, false)
  await h.workspace.focus(A); await h.workspace.focus(B)
  assert.equal((await h.workspace.setPermissionConsent(A, 'microphone', true)).microphone, true)
  assert.equal((await h.workspace.getPermissions(B)).microphone, false)
  assert.equal((await h.workspace.setPermissionConsent(A, 'notifications', true)).notifications, true)
  await assert.rejects(h.workspace.setPermissionConsent(A, 'camera', true), /权限无效/)
  const gate = deferred(); h.getGates.set(A, gate.promise); const pending = h.workspace.setPermissionConsent(A, 'microphone', false)
  h.setOwner('owner-b'); gate.resolve(); await assert.rejects(pending, /状态已变化/)
})

test('page state and navigation failures are pushed without private URLs or stale owner data', async () => {
  const h = fixture(); await h.workspace.focus(A); const wc = h.views[0].webContents
  wc.url = 'https://voice.google.com/u/0/messages?itemId=private-conversation'; wc.emit('dom-ready')
  let event = h.calls.filter(call => call[0] === 'send' && call[1] === 'google-voice:state').at(-1)[2]
  assert.equal(event.state, 'ready'); assert.equal(event.id, A); assert.ok(!JSON.stringify(event).includes('private-conversation'))
  wc.emit('will-navigate', { preventDefault() {} }, 'https://unknown.invalid/path?secret=private')
  event = h.calls.filter(call => call[0] === 'send' && call[1] === 'google-voice:state').at(-1)[2]
  assert.equal(event.state, 'ready'); assert.match(event.message, /https:\/\/unknown.invalid/); assert.ok(!event.message.includes('secret'))
  wc.emit('did-fail-load', {}, -105, 'https://private', wc.url, true)
  event = h.calls.filter(call => call[0] === 'send' && call[1] === 'google-voice:state').at(-1)[2]
  assert.equal(event.state, 'error'); assert.equal(h.views[0].visible, false)
  const count = h.calls.length; h.setOwner('owner-b'); wc.emit('dom-ready'); assert.equal(h.calls.length, count)
})

test('closing the parent cleans up all child contents without a native detach acknowledgment loop', async () => {
  const h = fixture(), contents = h.window.webContents; await h.workspace.focus(A); await h.workspace.focus(B)
  assert.doesNotThrow(() => h.window.close()); assert.throws(() => h.window.webContents, /Object has been destroyed/)
  assert.equal(contents.listenerCount('zoom-changed'), 0); assert.equal(h.window.listenerCount('resize'), 0)
  assert.ok(h.views.every(view => view.webContents.destroyed)); assert.equal(h.data.some(row => row.closed), false)
  assert.equal((await h.workspace.focus(A)).state, 'cancelled')
  await h.workspace.detachAll(); await h.workspace.detachAll()
})

test('closing the application before opening Voice still removes the destroyed contents listener', () => {
  const h = fixture(), contents = h.window.webContents
  assert.equal(contents.listenerCount('zoom-changed'), 1)
  assert.doesNotThrow(() => h.window.close())
  assert.equal(contents.listenerCount('zoom-changed'), 0); assert.equal(h.views.length, 0)
})

test('a pending Voice lookup cannot create a child after its parent is destroyed', async () => {
  const h = fixture(), gate = deferred(); h.getGates.set(A, gate.promise)
  const opening = h.workspace.focus(A)
  assert.doesNotThrow(() => h.window.close()); gate.resolve()
  assert.equal((await opening).state, 'cancelled'); assert.equal(h.views.length, 0)
  assert.equal(h.data.some(row => row.closed), false)
})

test('unexpected destruction reports a retryable error and retry recreates the same persistent account', async () => {
  const h = fixture(); await h.workspace.focus(A); const wc = h.views[0].webContents, session = wc.session
  wc.emit('dom-ready')
  const page = h.workspace.trustedPage({ sender: wc, senderFrame: wc.mainFrame })
  wc.close()
  const event = h.calls.filter(call => call[0] === 'send' && call[1] === 'google-voice:state').at(-1)[2]
  assert.equal(event.state, 'error'); assert.match(event.message, /页面意外关闭/); assert.equal(event.canGoBack, false)
  assert.equal(page.authorized(), false); assert.equal(h.data[0].closed, false); assert.equal(h.window.children.length, 0)
  assert.equal((await h.workspace.focus(A)).state, 'loading')
  assert.equal(h.views.length, 2); assert.equal(h.views[1].webContents.session, session); assert.equal(h.views[1].visible, true)
})

test('intentional close and logout do not emit misleading unexpected-closure errors', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.focus(B)
  await h.workspace.close(A); await h.workspace.detachAll()
  const errors = h.calls.filter(call => call[0] === 'send' && call[1] === 'google-voice:state' && call[2].state === 'error')
  assert.equal(errors.length, 0); assert.equal(h.data[0].closed, true); assert.equal(h.data[1].closed, false)
})

test('Voice unread uses trusted page identity and local notification consent, suppressing focused and duplicate alerts', async () => {
  const h = fixture(); await h.workspace.focus(A)
  const wc = h.views[0].webContents, event = { sender: wc, senderFrame: wc.mainFrame }
  const sample = (count: number | null, sequence: number) => ({ source: 'sms-navigation', documentId: '10000000-0000-4000-8000-000000000001', count, sequence })
  assert.equal(h.workspace.observeUnread(event, sample(0, 1)), true)
  assert.equal(h.workspace.observeUnread(event, sample(1, 2)), true)
  assert.equal(h.activity.filter(row => row[0] === 'notify').length, 0)
  await h.workspace.setPermissionConsent(A, 'notifications', true)
  assert.equal(h.workspace.observeUnread(event, sample(2, 3)), true)
  assert.equal(h.workspace.observeUnread(event, sample(2, 4)), false)
  assert.equal(h.activity.filter(row => row[0] === 'notify').length, 1)
  const notification = h.activity.find(row => row[0] === 'notify'); assert.equal(notification[2](), true)
  h.window.focused = true; h.workspace.observeUnread(event, sample(3, 5))
  assert.equal(h.activity.filter(row => row[0] === 'notify').length, 1)
  h.workspace.hide(); h.workspace.observeUnread(event, sample(4, 6))
  assert.equal(h.activity.filter(row => row[0] === 'notify').length, 2)
  await h.workspace.setPermissionConsent(A, 'notifications', false); assert.equal(notification[2](), false)
  assert.ok(h.activity.some(row => row[0] === 'clear' && row[1] === A))
  assert.throws(() => h.workspace.observeUnread({sender:{},senderFrame:wc.mainFrame},sample(9,7)))
  assert.throws(() => h.workspace.observeUnread({sender:wc,senderFrame:{}},sample(9,7)))
  wc.url = 'https://accounts.google.com/'; assert.throws(() => h.workspace.observeUnread(event,sample(9,7)))
})

test('Voice notification choice persists independently while microphone consent resets; closing clears only its activity', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.focus(B)
  assert.equal((await h.workspace.getPermissions(A)).notifications, false)
  await h.workspace.setPermissionConsent(A, 'notifications', true)
  await h.workspace.setPermissionConsent(A, 'microphone', true)
  assert.equal((await h.workspace.getPermissions(B)).notifications, false)
  await h.workspace.detachAll(); await h.workspace.focus(A)
  assert.deepEqual(JSON.parse(JSON.stringify(await h.workspace.getPermissions(A))), { microphone: false, notifications: true })
  const wc = h.views.at(-1)!.webContents, event = { sender:wc,senderFrame:wc.mainFrame }
  h.workspace.observeUnread(event,{source:'sms-navigation',documentId:'20000000-0000-4000-8000-000000000002',sequence:1,count:2})
  const start = h.activity.length
  await h.workspace.close(A)
  assert.ok(h.activity.slice(start).some(row => row[0] === 'unread' && row[1] === A && row[2] === null))
  assert.ok(h.activity.slice(start).every(row => row[1] === A))
  assert.throws(() => h.workspace.observeUnread(event,{source:'sms-navigation',documentId:'20000000-0000-4000-8000-000000000002',sequence:2,count:3}))
})

test('closing immediately revokes an existing Voice notification before the record lookup finishes', async () => {
  const h = fixture(); await h.workspace.focus(A); await h.workspace.setPermissionConsent(A, 'notifications', true)
  const wc = h.views[0].webContents, event = { sender:wc,senderFrame:wc.mainFrame }
  h.workspace.observeUnread(event,{source:'sms-navigation',documentId:'30000000-0000-4000-8000-000000000003',sequence:1,count:0})
  h.workspace.observeUnread(event,{source:'sms-navigation',documentId:'30000000-0000-4000-8000-000000000003',sequence:2,count:1})
  const notification = h.activity.find(row => row[0] === 'notify'); assert.equal(notification[2](), true)
  const gate = deferred(); h.getGates.set(A, gate.promise)
  const closing = h.workspace.close(A)
  assert.equal(notification[2](), false)
  gate.resolve(); await closing
  assert.equal(notification[2](), false)
})
