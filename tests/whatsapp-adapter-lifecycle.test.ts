import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

const flush = async () => { for (let i = 0; i < 48; i++) await Promise.resolve() }
function deferred() { let resolve!: (value?: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function fixture(t: any) {
  const views: FakeView[] = [], actions: any[] = [], health: any[] = [], proxyCalls: any[] = [], gates: ReturnType<typeof deferred>[] = []
  let configure: (session: any, proxy: any) => Promise<any> = async () => undefined
  class FakeContents extends EventEmitter {
    destroyed = false; crashed = false; audible = false; loads: any[] = []; scripts: string[] = []; reloads = 0; zoom = 1; rtc = ''
    save: any = {}; execute: ((script: string) => Promise<any>) | undefined; load: Promise<any> | undefined
    session = { flushes: 0, setUserAgent() {}, webRequest: { onBeforeSendHeaders() {} }, async flushStorageData() { this.flushes++ } }
    isDestroyed() { return this.destroyed }
    isCrashed() { return this.crashed }
    isCurrentlyAudible() { return this.audible }
    setZoomFactor(value: number) { this.zoom = value }
    setUserAgent() {}
    setWebRTCIPHandlingPolicy(value: string) { this.rtc = value }
    loadURL(url: string, options: any) { this.loads.push({ url, options }); return this.load || Promise.resolve() }
    executeJavaScript(script: string) { this.scripts.push(script); return this.execute?.(script) || Promise.resolve(script.includes('__RT_SAVE_WORKSPACE__') ? this.save : undefined) }
    reload() { this.reloads++ }
    send() {}
    close() { this.destroyed = true; this.emit('destroyed') }
    ready() { this.crashed = false; this.emit('dom-ready') }
    crash() { this.crashed = true; this.emit('render-process-gone', {}, { reason: 'crashed' }) }
    fail(code = -105, isMain = true) { this.emit('did-fail-load', {}, code, 'synthetic failure', 'https://private.invalid/', isMain) }
  }
  class FakeView {
    webContents = new FakeContents(); visible = false; bounds: any; visibility: boolean[] = []
    constructor(public options: any) { views.push(this) }
    setVisible(value: boolean) { this.visible = value; this.visibility.push(value) }
    setBounds(value: any) { this.bounds = value }
  }
  const parent = Object.assign(new EventEmitter(), {
    destroyed: false, children: [] as FakeView[], getContentSize: () => [1200, 800], isDestroyed() { return this.destroyed },
    webContents: { getZoomFactor: () => 1, isDestroyed: () => parent.destroyed, send: (_name: string, payload: any) => actions.push(payload) },
    contentView: { addChildView: (view: FakeView) => parent.children.push(view), removeChildView: (view: FakeView) => { parent.children = parent.children.filter(x => x !== view) } }
  })
  const h = mainHarness({ app: { on() {} }, WebContentsView: FakeView }, undefined, {
    '../../network/accountProxy': { configureProxySession: async (session: any, proxy: any) => { proxyCalls.push({ session, proxy }); await configure(session, proxy) } },
    '../../webSecurity': { installWebSecurity() {} }, './inject/script': { whatsappInjectionScript: '/* synthetic injection */' },
    '../../runtimeHealth': { markSwitch() {}, setAccountState: (...value: any[]) => health.push(value) }
  })
  const { WhatsAppAdapter } = h.load('src/main/platforms/whatsapp/whatsAppAdapter.ts')
  const adapter = new WhatsAppAdapter(); adapter.attachMainWindow(parent)
  adapter.setContentBounds({ x: 120, y: 180, width: 1080, height: 620 })
  t.after(async () => { adapter.resetViews(); for (const gate of gates) gate.resolve(); await flush() })
  return { adapter, views, actions, health, parent, proxyCalls, gate() { const gate = deferred(); gates.push(gate); return gate }, setConfigure(value: typeof configure) { configure = value } }
}

test('initial selection commits bounds and returns while native proxy setup is pending', async t => {
  const h = fixture(t), gate = h.gate(); h.setConfigure(() => gate.promise)
  const result = await h.adapter.focus('a')
  assert.equal(result.state, 'loading'); assert.equal(h.views.length, 1)
  assert.deepEqual({ ...h.views[0].bounds }, { x: 120, y: 180, width: 1080, height: 620 })
  assert.equal(h.views[0].webContents.loads.length, 0); assert.equal(h.views[0].visible, false)
  assert.ok(h.actions.some(x => x.accountId === 'a' && x.action === 'page-loading'))
  gate.resolve(); await flush(); assert.equal(h.views[0].webContents.loads.length, 1)
})

test('dom-ready reveals the page without waiting for loadURL subresources and old completions cannot steal selection', async t => {
  const h = fixture(t)
  await h.adapter.focus('a'); h.views[0].webContents.load = h.gate().promise
  await flush(); h.views[0].webContents.ready(); await flush()
  assert.equal(h.views[0].visible, true)
  await h.adapter.focus('b'); await flush(); h.views[1].webContents.ready(); await flush()
  h.views[0].webContents.emit('did-finish-load'); await flush()
  assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
  assert.equal((await h.adapter.focus('a')).state, 'ready')
  assert.equal(h.views[0].webContents.loads.length, 1)
})

test('switching away while loading never reveals the old account or covers another platform', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); h.adapter.hideAll()
  h.views[0].webContents.ready(); await flush()
  assert.equal(h.views[0].visible, false)
  h.adapter.setOverlayOpen(false); assert.equal(h.views[0].visible, false)
})

test('settings on a loading page are deferred and a hung ready renderer cannot block preference application forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t); await h.adapter.focus('a'); await flush()
  await h.adapter.applyPreferences('a', { zoomFactor: 1.2, fontSize: 15 })
  assert.equal(h.views[0].webContents.scripts.length, 0)
  h.views[0].webContents.ready(); await flush()
  const gate = h.gate(); h.views[0].webContents.execute = () => gate.promise
  let settled = false; const work = h.adapter.applyPreferences('a', { fontSize: 16 }).then(() => { settled = true })
  t.mock.timers.tick(1000); await flush(); await work
  assert.equal(settled, true)
  assert.equal((await h.adapter.focus('b')).state, 'loading')
})

test('crashed-page refresh bypasses unavailable draft JS and recovers the same partition and view', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const view = h.views[0], wc = view.webContents
  wc.ready(); await flush(); wc.crash(); wc.scripts.length = 0
  assert.equal(view.visible, false); assert.equal(h.actions.at(-1).action, 'page-failed')
  wc.execute = async () => { if (wc.crashed) throw new Error('crashed context'); return undefined }
  const work = h.adapter.reload('a'); await flush()
  assert.equal(wc.scripts.length, 0); assert.equal(wc.loads.length, 2)
  wc.ready(); await work; await flush()
  assert.equal(h.views.length, 1); assert.equal(view.options.webPreferences.partition, 'persist:wa:a'); assert.equal(view.visible, true)
})

test('refresh during initial loading shares navigation and waits only until DOM readiness', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  const first = h.adapter.reload('a'), second = h.adapter.reload('a')
  assert.equal(first, second); assert.equal(wc.loads.length, 1); assert.equal(wc.scripts.length, 0)
  wc.ready(); await first; assert.equal(h.views[0].visible, true)
})

test('page failure exposes a static host error and an error-document dom-ready cannot falsely recover it', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  wc.fail(); await flush(); wc.ready(); await flush()
  assert.equal(h.views[0].visible, false); assert.equal(h.actions.at(-1).action, 'page-failed')
  assert.equal(JSON.stringify(h.actions).includes('private.invalid'), false)
  const work = h.adapter.reload('a'); await flush(); wc.ready(); await work
  assert.equal(h.views[0].visible, true); assert.equal(wc.loads.length, 2)
})

test('subresource and ERR_ABORTED events do not hide a functioning page', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  wc.ready(); await flush(); wc.fail(-105, false); wc.fail(-3, true)
  assert.equal(h.views[0].visible, true)
})

test('failed proxy setup remains fail-closed and explicit retry reuses the account partition', async t => {
  const h = fixture(t); h.setConfigure(async () => { throw new Error('synthetic proxy failure') })
  await h.adapter.applyPreferences('a', { proxy: { enabled: true, host: 'synthetic.invalid' } })
  await h.adapter.focus('a'); await flush()
  assert.equal(h.views[0].webContents.loads.length, 0); assert.equal(h.actions.at(-1).action, 'page-failed')
  h.setConfigure(async () => undefined); await h.adapter.focus('a'); await flush(); h.views[0].webContents.ready(); await flush()
  assert.equal(h.views.length, 1); assert.equal(h.views[0].visible, true)
  assert.equal(h.views[0].webContents.rtc, 'disable_non_proxied_udp')
  assert.equal(h.proxyCalls.length, 2); assert.ok(h.proxyCalls.every(x => x.proxy.enabled))
})

test('proxy timeout becomes an error and late native completion never starts navigation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t), gate = h.gate(); h.setConfigure(() => gate.promise)
  await h.adapter.focus('a'); t.mock.timers.tick(8000); await flush()
  assert.equal(h.actions.at(-1).action, 'page-failed')
  gate.resolve(); await flush(); assert.equal(h.views[0].webContents.loads.length, 0)
})

test('retry cannot race a still-running native proxy setup for the same partition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t), gate = h.gate(); let setups = 0
  h.setConfigure(async () => { if (++setups === 1) await gate.promise })
  await h.adapter.focus('a'); await flush(); assert.equal(setups, 1)
  t.mock.timers.tick(8000); await flush(); await h.adapter.focus('a'); await flush()
  assert.equal(setups, 1); assert.equal(h.views[0].webContents.loads.length, 0)
  gate.resolve(); await flush()
  assert.equal(setups, 2); assert.equal(h.views[0].webContents.loads.length, 1)
  h.views[0].webContents.ready(); await flush(); assert.equal(h.views[0].visible, true)
})

test('page timeout exposes retry, then a delayed DOM becomes visible without blocking other selections', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t); await h.adapter.focus('a'); await flush(); t.mock.timers.tick(30000); await flush()
  assert.equal(h.actions.at(-1).action, 'page-failed'); assert.equal(h.views[0].visible, false)
  h.views[0].webContents.ready(); await flush(); assert.equal(h.views[0].visible, true)
})

test('healthy drafts, attachments and active audio are preserved instead of forcibly refreshing', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  wc.audible = true; await assert.rejects(h.adapter.reload('a'), /音频/); assert.equal(wc.loads.length, 1)
  wc.audible = false
  wc.ready(); await flush()
  for (const flag of ['busy', 'editing', 'media', 'capturing']) {
    wc.save = { [flag]: true }; await assert.rejects(h.adapter.reload('a'), /刷新/); assert.equal(wc.reloads, 0)
  }
  wc.save = {}; wc.audible = true; await assert.rejects(h.adapter.reload('a'), /刷新/); assert.equal(wc.reloads, 0)
})

test('restart flushes crashed and not-yet-ready partitions without invoking unavailable page scripts', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush()
  await h.adapter.focus('b'); await flush(); h.views[1].webContents.ready(); await flush(); h.views[1].webContents.crash()
  for (const view of h.views) { view.webContents.scripts.length = 0; view.webContents.execute = async () => { throw new Error('unavailable renderer') } }
  await h.adapter.prepareRestart()
  for (const view of h.views) { assert.equal(view.webContents.scripts.length, 0); assert.equal(view.webContents.session.flushes, 1) }
})

test('restart refuses live draft save failures, pending media and active audio even before readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  wc.audible = true; await assert.rejects(h.adapter.prepareRestart(), /音频/); assert.equal(wc.session.flushes, 0)
  wc.audible = false; wc.ready(); await flush()
  for (const flag of ['busy', 'editing', 'media', 'capturing']) {
    wc.save = { [flag]: true }; await assert.rejects(h.adapter.prepareRestart(), /重启/)
  }
  wc.execute = async () => { throw new Error('synthetic failed draft save') }
  await assert.rejects(h.adapter.prepareRestart(), /failed draft save/)
  const gate = h.gate(); wc.execute = () => gate.promise
  const work = h.adapter.prepareRestart(), check = assert.rejects(work, /草稿/)
  t.mock.timers.tick(1500); await flush(); await check
  assert.equal(wc.session.flushes, 0); assert.equal(wc.destroyed, false)
})

test('nonresponsive draft guard times out without destroying a live draft or sending a message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t); await h.adapter.focus('a'); await flush(); const wc = h.views[0].webContents
  wc.ready(); await flush(); const gate = h.gate(); wc.execute = () => gate.promise
  const work = h.adapter.reload('a'), check = assert.rejects(work, /草稿/)
  t.mock.timers.tick(1500); await flush(); await check
  assert.equal(wc.reloads, 0); assert.equal(wc.destroyed, false); assert.equal(wc.loads.length, 1)
})

test('modal closure reveals only the selected ready page, including when readiness occurs behind it', async t => {
  const h = fixture(t); h.adapter.setOverlayOpen(true); await h.adapter.focus('a'); await flush()
  h.views[0].webContents.ready(); await flush(); assert.equal(h.views[0].visible, false)
  h.adapter.setOverlayOpen(false); assert.equal(h.views[0].visible, true)
  await h.adapter.focus('b'); h.adapter.setOverlayOpen(true); await flush(); h.views[1].webContents.ready(); await flush()
  h.adapter.setOverlayOpen(false); assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true)
})

test('removed accounts cannot navigate after proxy completion or emit state for a replacement view', async t => {
  const h = fixture(t), gate = h.gate(); h.setConfigure(() => gate.promise)
  await h.adapter.focus('a'); const old = h.views[0]; h.adapter.remove('a')
  h.setConfigure(async () => undefined); await h.adapter.focus('a'); await flush(); h.views[1].webContents.ready(); await flush()
  const count = h.actions.length; gate.resolve(); old.webContents.ready(); await flush()
  assert.equal(old.webContents.loads.length, 0); assert.equal(h.actions.length, count)
  assert.equal(h.parent.children.length, 1); assert.equal(h.views[1].visible, true)
})

test('destroyed native views are detached and paused or destroyed-host selections cannot activate a page', async t => {
  const h = fixture(t); await h.adapter.focus('a'); await flush(); h.views[0].webContents.close()
  await h.adapter.focus('a'); await flush(); assert.equal(h.parent.children.length, 1); assert.equal(h.views.length, 2)
  await h.adapter.applyPreferences('paused', { runtimeMode: 'paused' }); await assert.rejects(h.adapter.focus('paused'), /暂停/)
  h.parent.destroyed = true; assert.equal((await h.adapter.focus('c')).state, 'cancelled')
})
