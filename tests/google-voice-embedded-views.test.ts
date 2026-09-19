import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

const A = 'gv-10000000-0000-4000-8000-000000000001'
const B = 'gv-20000000-0000-4000-8000-000000000002'
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5))

function fixture(options: any = {}) {
  const sessions = new Map<string, any>(), views: FakeView[] = [], states: any[] = [], blocked: any[] = []
  let loadingFailure: Promise<void> | undefined
  let failNextView = false
  function getSession(partition: string) {
    if (!sessions.has(partition)) sessions.set(partition, Object.assign(new EventEmitter(), {
      partition, check: undefined, request: undefined, display: undefined,
      setPermissionCheckHandler(callback: any) { this.check = callback },
      setPermissionRequestHandler(callback: any) { this.request = callback },
      setDisplayMediaRequestHandler(callback: any) { this.display = callback }
    }))
    return sessions.get(partition)
  }
  class FakeContents extends EventEmitter {
    destroyed = false; url = ''; focused = 0; reloads = 0; calls: any[] = []; open: any; sent: any[] = []; mainFrame: any
    history = false; backCalls = 0
    navigationHistory = { canGoBack: () => this.history, goBack: () => { this.backCalls++ } }
    constructor(public session: any) { super(); const contents = this; this.mainFrame = { get url() { return contents.url }, detached: false } }
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    loadURL(url: string, options?: any) { this.url = url; this.calls.push({ url, options }); return loadingFailure || Promise.resolve() }
    setWindowOpenHandler(callback: any) { this.open = callback }
    focus() { this.focused++ }
    send(...args: any[]) { this.sent.push(args) }
    reload() { this.reloads++ }
    close(options: any) { this.calls.push({ close: options }); this.destroyed = true; this.emit('destroyed') }
  }
  class FakeView {
    webContents: FakeContents; visible = false; bounds: any; background: any
    constructor(public options: any) {
      if (failNextView) { failNextView = false; throw new Error('view creation failed') }
      this.webContents = options.webContents || new FakeContents(options.webPreferences.session || getSession(options.webPreferences.partition))
      views.push(this)
    }
    setVisible(value: boolean) { this.visible = value }
    setBounds(value: any) { this.bounds = value }
    setBackgroundColor(value: string) { this.background = value }
  }
  class FakeParent extends EventEmitter {
    destroyed = false; visible = true; minimized = false; children: FakeView[] = []; size = [1200, 800]
    contentView = {
      addChildView: (view: FakeView) => { this.children.push(view) },
      removeChildView: (view: FakeView) => { this.children = this.children.filter(item => item !== view) }
    }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    getContentSize() { return this.size }
  }
  const parent = new FakeParent()
  const h = mainHarness({ WebContentsView: FakeView, session: { fromPartition: getSession } })
  const module = h.load('src/main/platforms/googleVoice/embeddedViews.ts')
  const manager = new module.GoogleVoiceEmbeddedViews(parent, { ...options, onState: (state: any) => states.push(state), onBlockedNavigation: (event: any) => blocked.push(event) })
  manager.setBounds({ x: 60, y: 120, width: 1100, height: 650 })
  const popup = (contents: FakeContents, url = 'https://accounts.google.com/ServiceLogin', extra: any = {}) => contents.open({ url, disposition: 'new-window', referrer: { url: 'https://voice.google.com/u/0/', policy: 'strict-origin-when-cross-origin' }, ...extra })
  return { manager, parent, module, sessions, views, states, blocked, popup, FakeContents, failNextView: () => { failNextView = true }, setLoadingFailure: (promise: Promise<void>) => { loadingFailure = promise } }
}

test('embedded views use isolated persistent partitions and never put owner identities in disk paths', () => {
  const h = fixture()
  h.manager.create('first@example.invalid', A); h.manager.create('first@example.invalid', B); h.manager.create('second@example.invalid', A)
  assert.equal(h.manager.count, 3); assert.equal(h.sessions.size, 3)
  const keys = [...h.sessions.keys()]
  for (const key of keys) { assert.match(key, /^persist:google-voice-embedded-v1-[a-f0-9]{32}-[a-f0-9]{32}$/); assert.ok(!key.includes('@')) }
  assert.equal(h.module.googleVoiceEmbeddedPartition('first@example.invalid', A), keys[0])
  assert.throws(() => h.manager.create('', A), /身份无效/)
  assert.throws(() => h.manager.create('owner', '../../profile'), /身份无效/)
})

test('remote views are child contentViews with secure defaults and the direct official Voice URL', () => {
  const h = fixture(), state = h.manager.create('owner', A), view = h.views[0], prefs = view.options.webPreferences
  assert.equal(state.status, 'loading'); assert.equal(h.parent.children[0], view)
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(prefs[key], true)
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'allowRunningInsecureContent', 'webviewTag', 'devTools']) assert.equal(prefs[key], false)
  assert.equal(prefs.preload, undefined); assert.equal(prefs.additionalArguments, undefined)
  assert.equal(view.background, '#ffffff')
  assert.deepEqual(view.webContents.calls, [{ url: 'https://voice.google.com/u/0/', options: undefined }])
  assert.equal(view.visible, true)
})

test('selection, overlays, host minimize and clipping never show an inactive account', () => {
  const h = fixture(); h.manager.create('owner', A); h.manager.create('owner', B)
  assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
  h.manager.setOverlayOpen(true); assert.ok(h.views.every(view => !view.visible))
  h.manager.setOverlayOpen(false); assert.equal(h.views[1].visible, true)
  h.parent.minimized = true; h.parent.emit('minimize'); assert.ok(h.views.every(view => !view.visible))
  h.parent.minimized = false; h.parent.emit('restore'); assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
  h.parent.size = [700, 500]; h.parent.emit('resize')
  assert.equal(h.views[1].bounds.width, 640); assert.equal(h.views[1].bounds.height, 380)
  h.manager.hide(); assert.ok(h.views.every(view => !view.visible)); assert.equal(h.manager.getState('owner', B).selected, false)
  assert.throws(() => h.manager.setBounds({ x: 0, y: NaN, width: 30, height: 30 }), /区域无效/)
})

test('navigation allowlist rejects URL tricks and reports no path, query, email or fragment', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  for (const url of ['https://voice.google.com/u/0/', 'https://accounts.google.com/v3/signin/identifier', 'https://support.google.com/voice/answer/1', 'https://workspace.google.com/products/voice/', 'https://workspace.google.com/intl/zh-CN/products/voice/']) assert.equal(h.module.isGoogleVoiceEmbeddedUrl(url), true)
  for (const url of ['http://voice.google.com/', 'https://voice.google.com:444/', 'https://voice.google.com.attacker.invalid/', 'https://voice.google.com@attacker.invalid/', 'file:///D:/secret', 'javascript:alert(1)', 'https://workspace.google.com/products/gmail/']) assert.equal(h.module.isGoogleVoiceEmbeddedUrl(url), false)
  let prevented = 0
  wc.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://attacker.invalid/path?email=private@example.invalid#secret')
  wc.emit('will-redirect', { preventDefault: () => prevented++ }, 'https://attacker.invalid/path?token=secret', false, true)
  assert.equal(prevented, 2); assert.equal(h.blocked[0].origin, 'https://attacker.invalid')
  assert.ok(!JSON.stringify(h.blocked).includes('private')); assert.ok(!JSON.stringify(h.blocked).includes('token'))
  wc.url = 'https://accounts.google.com/login?email=private@example.invalid#secret'; wc.emit('did-navigate', {}, wc.url); wc.emit('did-finish-load')
  assert.equal(h.states.at(-1).origin, 'https://accounts.google.com'); assert.ok(!JSON.stringify(h.states).includes('private'))
})

test('official window.open adopts the exact precreated guest and does not replay POST or loadURL', () => {
  const h = fixture(); h.manager.create('owner', A); const opener = h.views[0].webContents
  const response = h.popup(opener, 'https://accounts.google.com/login', { postBody: { data: [{ bytes: Buffer.from('private=secret') }], contentType: 'application/x-www-form-urlencoded' } })
  assert.equal(response.action, 'allow'); assert.equal(response.overrideBrowserWindowOptions.webPreferences.session, opener.session)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  const guest = new h.FakeContents(opener.session); guest.url = 'https://accounts.google.com/login'
  const returned = response.createWindow({ webContents: guest, webPreferences: response.overrideBrowserWindowOptions.webPreferences })
  assert.equal(returned, guest); assert.equal(h.views[1].webContents, guest); assert.equal(guest.calls.length, 0)
  assert.equal(h.manager.getState('owner', A).popupDepth, 1); assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
  assert.equal(h.manager.back('owner', A), true); assert.equal(guest.destroyed, true); assert.equal(h.views[0].visible, true)
  assert.equal(opener.destroyed, false); assert.equal(h.manager.getState('owner', A).popupDepth, 0)
})

test('a normal official target blank GET creates an internal view preserving session and referrer', () => {
  const h = fixture(); h.manager.create('owner', A); const opener = h.views[0].webContents
  const response = h.popup(opener, 'https://accounts.google.com/ServiceLogin?continue=voice')
  const child = response.createWindow({ webPreferences: { nodeIntegration: true, sandbox: false, preload: 'untrusted.js' } })
  assert.notEqual(child, opener); assert.equal(child.session, opener.session)
  assert.equal(h.parent.children.length, 2); assert.equal(h.views[1].visible, true)
  assert.equal(child.calls[0].url, 'https://accounts.google.com/ServiceLogin?continue=voice')
  assert.equal(child.calls[0].options.httpReferrer.url, 'https://voice.google.com/u/0/')
  assert.equal(child.calls[0].options.httpReferrer.policy, 'strict-origin-when-cross-origin')
  assert.equal(h.views[1].options.webPreferences.nodeIntegration, false); assert.equal(h.views[1].options.webPreferences.preload, undefined)
})

test('missing-guest POST and blank popups fail closed without replaying data or opening an external window', async () => {
  const h = fixture(); h.manager.create('owner', A); const opener = h.views[0].webContents
  for (const [url, extra] of [['https://accounts.google.com/login', { postBody: { data: [{ bytes: Buffer.from('secret') }] } }], ['about:blank', {}]] as const) {
    const response = h.popup(opener, url, extra), unused = response.createWindow({})
    assert.notEqual(unused, opener); assert.equal(unused.calls.length, 0); assert.equal(h.parent.children.length, 1)
    await tick(); assert.equal(unused.destroyed, true)
  }
  assert.equal(opener.destroyed, false); assert.equal(h.blocked.length, 2)
  assert.ok(h.blocked.every(event => event.reason === 'popup-unavailable'))
})

test('unknown and background popups are denied before creation, and delayed guests cannot revive closed accounts', () => {
  const h = fixture(); h.manager.create('owner', A); const opener = h.views[0].webContents
  assert.equal(h.popup(opener, 'https://external.invalid/').action, 'deny')
  assert.equal(h.popup(opener, 'https://accounts.google.com/', { disposition: 'background-tab' }).action, 'deny')
  const pending = h.popup(opener), guest = new h.FakeContents(opener.session)
  h.manager.close('owner', A); assert.equal(pending.createWindow({ webContents: guest }), guest)
  assert.equal(guest.destroyed, true); assert.equal(h.parent.children.length, 0); assert.equal(h.manager.count, 0)
})

test('precreated popup from another session is closed without attaching or replacing account storage', () => {
  const h = fixture(); h.manager.create('owner', A); h.manager.create('owner', B)
  const guest = new h.FakeContents(h.views[1].webContents.session)
  h.popup(h.views[0].webContents).createWindow({ webContents: guest })
  assert.equal(guest.destroyed, true); assert.equal(h.parent.children.length, 2)
  assert.equal(h.manager.getState('owner', A).popupDepth, 0)
})

test('microphone permission defaults to denied and explicit consent is account and origin bound', () => {
  const h = fixture(); h.manager.create('owner', A); h.manager.create('owner', B)
  const a = h.views[0].webContents, b = h.views[1].webContents
  const check = (wc: any, permission = 'media', extra: any = {}) => wc.session.check(wc, permission, 'https://voice.google.com', { mediaType: 'audio', isMainFrame: true, ...extra })
  const request = (wc: any, permission = 'media', extra: any = {}) => {
    let accepted: boolean | undefined
    wc.session.request(wc, permission, (value: boolean) => { accepted = value }, { mediaTypes: ['audio'], isMainFrame: true, requestingUrl: 'https://voice.google.com/u/0/', ...extra })
    return accepted
  }
  assert.equal(check(a), false); assert.equal(request(a), false)
  h.manager.setAudioConsent('owner', A, true)
  assert.equal(check(a), true); assert.equal(request(a), true); assert.equal(check(b), false)
  for (const permission of ['notifications', 'clipboard-read', 'geolocation', 'display-capture', 'openExternal']) { assert.equal(check(a, permission), false); assert.equal(request(a, permission), false) }
  assert.equal(check(a, 'media', { mediaType: 'video' }), false)
  assert.equal(check(a, 'media', { isMainFrame: false }), false)
  assert.equal(request(a, 'media', { mediaTypes: ['audio', 'video'] }), false)
  assert.equal(request(a, 'media', { mediaTypes: [] }), false)
  assert.equal(request(a, 'media', { requestingUrl: 'https://accounts.google.com/' }), false)
  a.url = 'https://accounts.google.com/login'; assert.equal(check(a), false); assert.equal(request(a), false)
  a.url = 'https://voice.google.com/u/0/'; h.manager.setAudioConsent('owner', A, false); assert.equal(check(a), false)
})

test('closing an inactive view preserves the selected one, while host destruction closes all views', () => {
  const h = fixture(); h.manager.create('owner', A); h.manager.create('owner', B)
  h.manager.close('owner', A); assert.equal(h.views[0].webContents.destroyed, true); assert.equal(h.views[1].visible, true)
  assert.equal(h.manager.getState('owner', B).selected, true)
  h.parent.destroyed = true; h.parent.emit('closed')
  assert.equal(h.views[1].webContents.destroyed, true); assert.equal(h.manager.count, 0)
  assert.throws(() => h.manager.create('owner', A), /已关闭/)
  h.manager.destroy(); assert.equal(h.manager.count, 0)
})

test('native Chromium back/reload and failure states remain local to the selected record', async () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  assert.equal(h.manager.back('owner', A), false); wc.history = true
  assert.equal(h.manager.getState('owner', A).canGoBack, true); assert.equal(h.manager.back('owner', A), true); assert.equal(wc.backCalls, 1)
  h.manager.reload('owner', A); assert.equal(wc.reloads, 1)
  wc.emit('did-fail-load', {}, -3, 'cancelled', wc.url, true); assert.equal(h.manager.getState('owner', A).status, 'loading')
  wc.emit('did-fail-load', {}, -2, 'failure', wc.url, true); assert.equal(h.manager.getState('owner', A).status, 'failed')
  wc.emit('did-finish-load'); assert.equal(h.manager.getState('owner', A).status, 'ready')
  wc.emit('render-process-gone'); assert.equal(h.manager.getState('owner', A).status, 'failed')
  h.manager.close('owner', A); await tick(); assert.equal(h.states.at(-1).status, 'closed')
})

test('late navigation errors after account close never resurrect a record or emit private request details', async () => {
  let reject!: (error: Error) => void
  const h = fixture(); h.setLoadingFailure(new Promise<void>((_resolve, failure) => { reject = failure }))
  h.manager.create('owner', A); h.manager.close('owner', A)
  const count = h.states.length; reject(new Error('https://accounts.google.com/?secret=not-logged'))
  await tick(); assert.equal(h.states.length, count); assert.equal(h.manager.count, 0)
  assert.ok(!JSON.stringify(h.states).includes('secret'))
})

test('a failed renderer creation removes the incomplete record and allows the same window to retry', () => {
  const h = fixture(); h.failNextView()
  assert.throws(() => h.manager.create('owner', A), /内嵌页面未能创建/)
  assert.equal(h.manager.count, 0); assert.equal(h.parent.children.length, 0)
  h.manager.create('owner', A); assert.equal(h.manager.count, 1); assert.equal(h.views[0].visible, true)
})

test('delayed popup creation cannot exceed the four-popup bound', () => {
  const h = fixture(); h.manager.create('owner', A); const opener = h.views[0].webContents
  const pending = Array.from({ length: 6 }, () => h.popup(opener))
  const guests = pending.map(response => {
    const guest = new h.FakeContents(opener.session); guest.url = 'https://accounts.google.com/login'
    response.createWindow({ webContents: guest }); return guest
  })
  assert.equal(h.parent.children.length, 5); assert.equal(h.manager.getState('owner', A).popupDepth, 4)
  assert.equal(guests.filter(guest => guest.destroyed).length, 2)
  assert.equal(h.popup(opener).action, 'deny')
  h.manager.destroy(); assert.ok(guests.every(guest => guest.destroyed))
})

test('main-document readiness does not wait for subresources or imply that Google login succeeded', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  wc.url = 'https://workspace.google.com/products/voice/'
  wc.emit('did-start-navigation', {}, wc.url, false, true)
  assert.equal(h.manager.getState('owner', A).status, 'loading')
  wc.emit('dom-ready')
  assert.equal(h.manager.getState('owner', A).status, 'ready')
  assert.equal(h.manager.getState('owner', A).origin, 'https://workspace.google.com')
  wc.emit('did-start-loading')
  wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }, 'https://example.invalid/subresource', false, false)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }, wc.url + '#fragment', true, true)
  assert.equal(h.manager.getState('owner', A).status, 'ready')
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'https://accounts.google.com/login', false, true)
  assert.equal(h.manager.getState('owner', A).status, 'loading')
  wc.url = 'https://accounts.google.com/login'; wc.emit('dom-ready')
  assert.equal(h.manager.getState('owner', A).status, 'ready')
  assert.equal(h.manager.getState('owner', A).origin, 'https://accounts.google.com')
  assert.equal('authenticated' in h.manager.getState('owner', A), false)
})

test('an old loadURL rejection cannot overwrite a newer document or its loading state', async () => {
  let reject!: (error: Error) => void
  const h = fixture(); h.setLoadingFailure(new Promise<void>((_resolve, failure) => { reject = failure }))
  h.manager.create('owner', A); const wc = h.views[0].webContents
  wc.emit('did-start-navigation', {}, 'https://accounts.google.com/login', false, true)
  reject(Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED', errno: -3 }))
  await tick(); assert.equal(h.manager.getState('owner', A).status, 'loading')
  wc.url = 'https://accounts.google.com/login'; wc.emit('dom-ready')
  assert.equal(h.manager.getState('owner', A).status, 'ready')
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://voice.google.com/u/0/', true)
  assert.equal(h.manager.getState('owner', A).status, 'ready')
})

test('a popup loadURL rejection cannot replace a newer ready popup with a stale error', async () => {
  const h = fixture(); h.manager.create('owner', A)
  let reject!: (error: Error) => void
  h.setLoadingFailure(new Promise<void>((_resolve, failure) => { reject = failure }))
  const guest = h.popup(h.views[0].webContents).createWindow({})
  guest.emit('did-start-navigation', {}, 'https://accounts.google.com/new-step', false, true)
  guest.url = 'https://accounts.google.com/new-step'; guest.emit('dom-ready')
  reject(new Error('Late failure of a superseded request'))
  await tick(); assert.equal(h.manager.getState('owner', A).status, 'ready')
  assert.equal(h.manager.getState('owner', A).popupDepth, 1)
  guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', guest.url, true)
  assert.equal(h.manager.getState('owner', A).status, 'failed')
})

test('Google post-verification CheckCookie and exact YouTube SetSID redirects stay in the same embedded view', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  wc.url = 'https://accounts.google.com/v3/signin/challenge/totp'
  let prevented = 0
  for (const url of [
    'https://accounts.google.com/CheckCookie?checkedDomains=youtube',
    'https://accounts.youtube.com/accounts/SetSID?sidt=synthetic-test-only&continue=https%3A%2F%2Faccounts.google.com',
    'https://accounts.google.com/ServiceLogin',
    'https://voice.google.com/u/0/'
  ]) {
    wc.emit('will-redirect', { isMainFrame: true, url, preventDefault: () => { prevented++ } }, url, false, true)
    wc.url = url; wc.emit('did-navigate', {}, url)
  }
  assert.equal(prevented, 0); assert.equal(h.parent.children.length, 1); assert.equal(h.blocked.length, 0)
  assert.equal(h.module.isGoogleVoiceEmbeddedUrl('https://accounts.youtube.com/SetSID'), true)
  assert.ok(!JSON.stringify(h.states).includes('synthetic-test-only'))
  wc.emit('dom-ready'); assert.equal(h.manager.getState('owner', A).origin, 'https://voice.google.com')
})

test('SetSID permission does not allow lookalike domains, other YouTube pages, ports or unverified regional hosts', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const denied = [
    'http://accounts.youtube.com/accounts/SetSID',
    'https://accounts.youtube.com:443/accounts/SetSID',
    'https://accounts.youtube.com:8443/accounts/SetSID',
    'https://user@accounts.youtube.com/accounts/SetSID',
    'https://accounts.youtube.com.evil.invalid/accounts/SetSID',
    'https://accounts.youtube.com@evil.invalid/accounts/SetSID',
    'https://www.youtube.com/accounts/SetSID',
    'https://accounts.youtube.com/watch',
    'https://accounts.youtube.com/accounts/SetSID/extra',
    'https://accounts.youtube.com/accounts/setsid',
    'https://accounts.google.fr/accounts/SetSID'
  ]
  let prevented = 0
  for (const url of denied) {
    assert.equal(h.module.isGoogleVoiceEmbeddedUrl(url), false, url)
    wc.emit('will-redirect', { isMainFrame: true, url, preventDefault: () => { prevented++ } }, url, false, true)
  }
  assert.equal(prevented, denied.length)
  assert.equal(h.blocked.at(-1).origin, 'https://accounts.google.fr')
})

test('trusted translation IPC requires a registered current main frame at the exact Voice origin', () => {
  const h = fixture(); h.manager.create('real-owner', A); const wc = h.views[0].webContents
  const event = { sender: wc, senderFrame: wc.mainFrame }, page = h.manager.trustedPage(event)
  assert.equal(page.owner, 'real-owner'); assert.equal(page.accountId, A); assert.equal(page.authorized(), true)
  assert.throws(() => h.manager.trustedPage({ sender: {}, senderFrame: wc.mainFrame }), /主页面/)
  assert.throws(() => h.manager.trustedPage({ sender: wc, senderFrame: { url: wc.url, detached: false } }), /页面已变化/)
  wc.url = 'https://accounts.google.com/ServiceLogin'
  assert.equal(page.authorized(), false); assert.throws(() => h.manager.trustedPage(event), /页面已变化/)
  wc.url = 'https://voice.google.com.attacker.invalid/'
  assert.throws(() => h.manager.trustedPage(event), /页面已变化/)
  wc.url = 'https://voice.google.com/u/0/'; wc.mainFrame.detached = true
  assert.throws(() => h.manager.trustedPage(event), /页面已变化/)
})

test('navigation, settings invalidation, reload and close revoke all earlier IPC authorizations', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const event = { sender: wc, senderFrame: wc.mainFrame }
  let page = h.manager.trustedPage(event)
  wc.emit('did-start-navigation', {}, wc.url, true, true)
  assert.equal(page.authorized(), false)
  page = h.manager.trustedPage(event); h.manager.invalidateContext(); assert.equal(page.authorized(), false)
  page = h.manager.trustedPage(event); h.manager.reload('owner', A); assert.equal(page.authorized(), false)
  page = h.manager.trustedPage(event); h.manager.close('owner', A); assert.equal(page.authorized(), false)
  assert.ok(wc.sent.length >= 4); assert.ok(wc.sent.every(args => args.length === 1 && args[0] === 'google-voice:context-changed'))
})

test('specialized preload is inherited by official internal pages and their guest creation preferences', () => {
  const pages: any[] = [], h = fixture({ preloadPath: 'D:/HelloDog/preload/googleVoice.js', onPage: (page: any) => pages.push(page) })
  h.manager.create('owner', A); const wc = h.views[0].webContents
  assert.equal(h.views[0].options.webPreferences.preload, 'D:/HelloDog/preload/googleVoice.js')
  const response = h.popup(wc)
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.preload, 'D:/HelloDog/preload/googleVoice.js')
  response.createWindow({})
  assert.equal(h.views[1].options.webPreferences.preload, 'D:/HelloDog/preload/googleVoice.js')
  assert.equal(pages.length, 2); assert.ok(pages.every(page => page.owner === 'owner' && page.accountId === A))
  assert.equal(pages[1].webContents, h.views[1].webContents)
})

test('notification consent is explicit, independent of microphone consent, and resets with the live view', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const request = () => { let result: any; wc.session.request(wc, 'notifications', (accepted: boolean) => { result = accepted }, { isMainFrame: true, requestingUrl: wc.url }); return result }
  assert.equal(request(), false)
  const permissions = h.manager.setPermissionConsent('owner', A, 'notifications', true)
  assert.equal(permissions.notifications, true); assert.equal(permissions.microphone, false); assert.equal(request(), true)
  wc.url = 'https://accounts.google.com/login'; assert.equal(request(), false)
  h.manager.close('owner', A); h.manager.create('owner', A)
  assert.equal(h.manager.getPermissions('owner', A).notifications, false)
  assert.throws(() => h.manager.setPermissionConsent('owner', A, 'camera', true), /权限无效/)
})

test('a failed embedded page is hidden so the host can display its retry controls', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const page = h.manager.trustedPage({ sender: wc, senderFrame: wc.mainFrame })
  wc.emit('did-fail-load', {}, -105, 'failure', wc.url, true)
  assert.equal(h.views[0].visible, false); assert.equal(page.authorized(), false)
  assert.throws(() => h.manager.trustedPage({ sender: wc, senderFrame: wc.mainFrame }), /页面已变化/)
  h.manager.reload('owner', A); assert.equal(h.views[0].visible, true)
  wc.emit('dom-ready'); assert.equal(h.manager.getState('owner', A).status, 'ready')
})

test('attachment downloads require a live Voice source, sanitize names and always offer a save dialog', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const item = (filename: string) => Object.assign(new EventEmitter(), { cancelled: false, options: undefined as any, getFilename: () => filename, cancel() { this.cancelled = true }, setSaveDialogOptions(value: any) { this.options = value } })
  const accepted = item('../../private:file.png'); wc.session.emit('will-download', {}, accepted, wc)
  assert.equal(accepted.cancelled, false); assert.ok(accepted.options.defaultPath.endsWith('.._.._private_file.png'))
  assert.equal(accepted.options.title, '保存 Google Voice 附件'); assert.equal(accepted.options.defaultPath.includes('../'), false)
  const reserved = item('CON.txt'); wc.session.emit('will-download', {}, reserved, wc)
  assert.ok(reserved.options.defaultPath.endsWith('attachment-CON.txt'))
  const accountPage = item('download.exe'); wc.url = 'https://accounts.google.com/login'
  wc.session.emit('will-download', {}, accountPage, wc); assert.equal(accountPage.cancelled, true); assert.equal(accountPage.options, undefined)
  const unknown = item('attachment.png'); wc.session.emit('will-download', {}, unknown, new h.FakeContents(wc.session)); assert.equal(unknown.cancelled, true)
  accepted.emit('done'); h.manager.close('owner', A)
  assert.equal(accepted.cancelled, false); assert.equal(reserved.cancelled, true)
  assert.equal(wc.session.listenerCount('will-download'), 0)
  h.manager.create('owner', A); assert.equal(wc.session.listenerCount('will-download'), 1)
})

test('closing a view revokes its microphone and notification grants for late requests', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  h.manager.setPermissionConsent('owner', A, 'microphone', true); h.manager.setPermissionConsent('owner', A, 'notifications', true)
  const before = wc.session.check(wc, 'media', 'https://voice.google.com', { mediaType: 'audio', isMainFrame: true })
  assert.equal(before, true); h.manager.close('owner', A)
  assert.equal(wc.session.check(wc, 'media', 'https://voice.google.com', { mediaType: 'audio', isMainFrame: true }), false)
  assert.equal(wc.session.check(wc, 'notifications', 'https://voice.google.com', { isMainFrame: true }), false)
})

test('returning from an internal popup cancels only downloads belonging to that popup', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const popup = h.popup(wc, 'https://voice.google.com/u/0/').createWindow({})
  const item = () => Object.assign(new EventEmitter(), { cancelled: false, getFilename: () => 'photo.png', cancel() { this.cancelled = true }, setSaveDialogOptions() {} })
  const originalDownload = item(), popupDownload = item()
  wc.session.emit('will-download', {}, originalDownload, wc); wc.session.emit('will-download', {}, popupDownload, popup)
  h.manager.back('owner', A)
  assert.equal(popupDownload.cancelled, true); assert.equal(originalDownload.cancelled, false)
  h.manager.destroy(); assert.equal(originalDownload.cancelled, true)
})

test('official copy permits only sanitized clipboard writes from the registered Voice main frame', () => {
  const h = fixture(); h.manager.create('owner', A); const wc = h.views[0].webContents
  const check = (permission = 'clipboard-sanitized-write', origin = 'https://voice.google.com', main = true, contents = wc) => wc.session.check(contents, permission, origin, { isMainFrame: main })
  const request = (permission = 'clipboard-sanitized-write', origin = wc.url, main = true, contents = wc) => {
    let result: boolean | undefined
    wc.session.request(contents, permission, (value: boolean) => { result = value }, { requestingUrl: origin, isMainFrame: main })
    return result
  }
  assert.equal(check(), true); assert.equal(request(), true)
  assert.equal(check('clipboard-read'), false); assert.equal(request('clipboard-read'), false)
  assert.equal(check('clipboard-sanitized-write', 'https://accounts.google.com'), false)
  assert.equal(request('clipboard-sanitized-write', 'https://accounts.google.com'), false)
  assert.equal(check('clipboard-sanitized-write', 'https://voice.google.com', false), false)
  assert.equal(request('clipboard-sanitized-write', wc.url, false), false)
  const unregistered = new h.FakeContents(wc.session); unregistered.url = wc.url
  assert.equal(check('clipboard-sanitized-write', 'https://voice.google.com', true, unregistered), false)
  const ownSession = wc.session; wc.session = {}
  assert.equal(ownSession.check(wc, 'clipboard-sanitized-write', 'https://voice.google.com', { isMainFrame: true }), false)
  wc.session = ownSession; wc.url = 'https://accounts.google.com/login'; assert.equal(check(), false)
  wc.url = 'https://voice.google.com/u/0/'; h.manager.close('owner', A); assert.equal(check(), false); assert.equal(request(), false)
})
