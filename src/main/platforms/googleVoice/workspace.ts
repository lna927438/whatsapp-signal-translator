import { createHash } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { GoogleVoiceRecords, type GoogleVoiceRecord } from './windowRecords'
import { GoogleVoiceEmbeddedViews, type GoogleVoiceEmbeddedOptions, type GoogleVoiceEmbeddedState, type GoogleVoiceTrustedPage } from './embeddedViews'
import { testGoogleVoiceProxy } from './network'
import { GoogleVoiceUnread } from './unread'

type Identity = { owner: string; authorized: () => boolean }
type Bounds = { x: number; y: number; width: number; height: number }
type Instance = { owner: string; ownerHash: string; record: GoogleVoiceRecord }
type Options = Pick<GoogleVoiceEmbeddedOptions, 'preloadPath' | 'onPage'> & {
  onUnread?: (id: string, count: number | null) => void
  notify?: (id: string, authorized: () => boolean) => void
  clearNotifications?: (id: string) => void
}

/** Main-process owner boundary for genuine in-client Google Voice views. */
export class GoogleVoiceWorkspace {
  private instances = new Map<string, Instance>()
  private views?: GoogleVoiceEmbeddedViews
  private active = ''
  private revision = 0
  private lifecycle = 0
  private closed = false
  private tearingDown = false
  private overlay = false
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }
  private changing = new Set<string>()
  private proxyTesting = false
  private windowRevisions = new Map<string, number>()
  private unread = new GoogleVoiceUnread()

  constructor(private window: BrowserWindow, readonly records: GoogleVoiceRecords, private identity: () => Identity, private options: Options = {}) {
    const layout = () => this.applyBounds()
    // BrowserWindow.webContents itself throws after the native window is destroyed.
    // Keep the live emitter so the closed handler can always complete child cleanup.
    const contents = window.webContents
    window.on('resize', layout)
    contents.on('zoom-changed', layout)
    window.once('closed', () => {
      this.closed = true; window.removeListener('resize', layout)
      contents.removeListener('zoom-changed', layout)
      void this.detachAll()
    })
  }

  private available(identity: Identity, lifecycle: number, id?: string, version?: number): boolean {
    try {
      return !this.closed && !this.window.isDestroyed() && identity.authorized() && this.identity().owner === identity.owner &&
        lifecycle === this.lifecycle && (!id || !this.changing.has(id) && (this.windowRevisions.get(id) || 0) === version)
    } catch { return false }
  }

  private requireAvailable(identity: Identity, lifecycle: number): void {
    if (!this.available(identity, lifecycle)) throw new Error('窗口或登录状态已变化，请重新打开。')
  }

  private safe(record: GoogleVoiceRecord) { return { id: record.id, label: record.label, tabOrder: record.tabOrder, browser: record.browser, translationProvider: record.translationProvider, proxy: record.proxy ? { ...record.proxy } : undefined } }

  private ensureViews(): GoogleVoiceEmbeddedViews {
    if (!this.views) {
      this.views = new GoogleVoiceEmbeddedViews(this.window, {
        ...this.options,
        authorizeOwner: owner => this.currentOwner(owner),
        onState: state => this.publish(state),
        onBlockedNavigation: event => {
          const item = this.instances.get(event.windowId)
          if (!item || item.ownerHash !== event.ownerHash || !this.currentOwner(item.owner)) return
          const state = this.views?.getState(item.owner, item.record.id)
          if (state) this.publish(state, `此跳转暂未完成${event.origin ? '（' + event.origin + '）' : ''}。请返回或重试。`)
        }
      })
      this.views.setOverlayOpen(this.overlay)
      this.applyBounds()
    }
    return this.views
  }

  private currentOwner(owner: string): boolean {
    try { const identity = this.identity(); return identity.owner === owner && identity.authorized() } catch { return false }
  }

  private publish(state: GoogleVoiceEmbeddedState, message?: string): void {
    const item = this.instances.get(state.windowId)
    if (!item || item.ownerHash !== state.ownerHash) return
    if (state.status === 'closed') {
      this.clearUnread(state.windowId)
      const intentional = this.closed || this.tearingDown || this.changing.has(state.windowId)
      // The embedded manager has removed the dead contents. Forget our live
      // index as well, so retry creates a view with the same persistent profile.
      this.instances.delete(state.windowId)
      this.windowRevisions.set(state.windowId, (this.windowRevisions.get(state.windowId) || 0) + 1)
      if (this.active === state.windowId) this.active = ''
      if (!intentional && !this.window.isDestroyed() && this.currentOwner(item.owner)) {
        this.window.webContents.send('google-voice:state', { id: state.windowId, state: 'error', message: 'Google Voice 页面意外关闭，请点击重试。登录资料仍保留。', canGoBack: false })
      }
      return
    }
    if (this.window.isDestroyed() || !this.currentOwner(item.owner)) return
    const status = state.status === 'failed' ? 'error' : state.status
    const detail = message || (status === 'error' ? (state.network?.message || (state.network?.mode === 'proxy' ? '此窗口代理或页面连接失败，请检查 IP 设置后重试；不会自动切换为直连。' : `Google Voice 页面未能加载${state.origin ? '（' + state.origin + '）' : ''}，请重试。`)) : '')
    this.window.webContents.send('google-voice:state', { id: state.windowId, state: status, page: state.page, message: detail, canGoBack: state.canGoBack, network: state.network })
  }

  async list() {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    const rows = await this.records.list(identity.owner); this.requireAvailable(identity, lifecycle)
    return rows.map(row => this.safe(row))
  }

  async add(options?: { label?: string; proxy?: unknown; translationProvider?: 'deepseek' | 'openai' }) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    const row = await this.records.add(identity.owner, options); this.requireAvailable(identity, lifecycle)
    return this.safe(row)
  }

  async update(id: string, patch: { label?: string; proxy?: unknown; translationProvider?: 'deepseek'|'openai' }) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    if (!patch || typeof patch !== 'object' || (patch.label === undefined && patch.proxy === undefined && patch.translationProvider === undefined)) throw new Error('窗口设置无效。')
    if (this.changing.has(id)) throw new Error('此窗口正在调整，请稍后重试。')
    this.changing.add(id)
    try {
      const row = await this.records.update(identity.owner, id, { label: patch.label, proxy: patch.proxy, translationProvider:patch.translationProvider }); this.requireAvailable(identity, lifecycle)
      if (patch.proxy !== undefined) {
        this.windowRevisions.set(id, (this.windowRevisions.get(id) || 0) + 1)
        if (this.active === id) this.hide()
        const item = this.instances.get(id)
        if (item?.owner === identity.owner) this.views?.close(identity.owner, id)
        this.instances.delete(id)
      }
      return this.safe(row)
    } finally { this.changing.delete(id) }
  }

  async testProxy(input: unknown, id?: string) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    if (this.proxyTesting) throw new Error('代理检测正在进行，请稍后重试。')
    this.proxyTesting = true
    try {
      const prepared = await this.records.proxyForTest(identity.owner, id, input)
      this.requireAvailable(identity, lifecycle)
      const result = await testGoogleVoiceProxy(prepared.proxy, prepared.password)
      this.requireAvailable(identity, lifecycle); return result
    } finally { this.proxyTesting = false }
  }

  async checkNetwork(id: string) {
    const identity = this.identity(), lifecycle = this.lifecycle, version = this.windowRevisions.get(id) || 0
    await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (this.instances.get(id)?.owner !== identity.owner || !this.views || !this.available(identity, lifecycle, id, version)) throw new Error('请先打开对应的 Google Voice 窗口。')
    const result = await this.views.checkNetwork(identity.owner, id)
    if (!this.available(identity, lifecycle, id, version)) throw new Error('窗口配置已变化，请重新检测。')
    return result
  }

  async reorder(ids: string[]) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    const rows = await this.records.reorder(identity.owner, ids); this.requireAvailable(identity, lifecycle)
    return rows.map(row => this.safe(row))
  }

  hide(): void { this.revision++; this.active = ''; this.views?.hide() }
  setOverlayOpen(open: boolean): void { this.overlay = Boolean(open); this.views?.setOverlayOpen(this.overlay) }
  invalidateContext(): void { this.views?.invalidateContext() }

  setBounds(value: Bounds): void {
    if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key as keyof Bounds])) || value.width < 0 || value.height < 0 || value.width > 20000 || value.height > 20000) return
    this.bounds = { x: Math.max(0, value.x), y: Math.max(0, value.y), width: value.width, height: value.height }
    this.applyBounds()
  }

  private applyBounds(): void {
    if (!this.views || this.window.isDestroyed()) return
    // Renderer DOM rectangles are CSS pixels. Electron child-view bounds are
    // DIP: apply the UI zoom once, never multiply by the monitor DPI again.
    const scale = this.window.webContents.getZoomFactor(), b = this.bounds
    if (!Number.isFinite(scale) || scale <= 0) return
    this.views.setBounds({ x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale })
  }

  async focus(id?: string) {
    const identity = this.identity(), revision = ++this.revision, lifecycle = this.lifecycle, version = this.windowRevisions.get(id || '') || 0
    this.active = ''; this.views?.hide()
    if (!this.available(identity, lifecycle, id, version)) return { state: 'cancelled' }
    if (!id) return { state: 'empty' }
    const record = await this.records.get(identity.owner, id)
    if (!this.available(identity, lifecycle, id, version) || revision !== this.revision) return { state: 'cancelled' }
    const password = record.proxy?.enabled ? await this.records.proxyPassword(identity.owner, id) : ''
    if (!this.available(identity, lifecycle, id, version) || revision !== this.revision) return { state: 'cancelled' }
    const previous = this.instances.get(id)
    if (previous && previous.owner !== identity.owner) throw new Error('Google Voice 账号已变化，请重新打开。')
    const views = this.ensureViews()
    if (!previous) this.instances.set(id, { owner: identity.owner, ownerHash: createHash('sha256').update(identity.owner).digest('hex'), record })
    try {
      this.active = id
      const state = previous ? views.focus(identity.owner, id) : views.create(identity.owner, id, { proxy: record.proxy, password })
      return { state: state.status === 'failed' ? 'error' : state.status === 'closed' ? 'idle' : state.status, page: state.page, canGoBack: state.canGoBack, network: state.network }
    } catch {
      this.active = ''
      if (!previous) this.instances.delete(id)
      this.window.webContents.send('google-voice:state', { id, state: 'error', message: 'Google Voice 页面未能打开，请重试。' })
      throw new Error('Google Voice 页面未能打开，请重试。')
    }
  }

  // Compatibility for older renderer calls: neither method launches a browser.
  async external(id: string) { return this.focus(id) }
  async extensionSetup(id: string) { return { ...await this.focus(id), embedded: true } }

  async close(id: string) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    if (this.changing.has(id)) throw new Error('此窗口正在调整，请稍后重试。')
    this.changing.add(id); this.windowRevisions.set(id, (this.windowRevisions.get(id) || 0) + 1)
    if (this.active === id) this.hide()
    try {
      await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
      const item = this.instances.get(id)
      if (item && item.owner !== identity.owner) throw new Error('登录状态已变化。')
      if (item) this.views?.close(identity.owner, id)
      this.instances.delete(id)
      await this.records.update(identity.owner, id, { closed: true }); this.requireAvailable(identity, lifecycle)
      return true
    } finally { this.changing.delete(id) }
  }

  async refresh(id: string) {
    const identity = this.identity(), lifecycle = this.lifecycle, revision = this.revision
    const record = await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (revision !== this.revision) return { state: 'cancelled' }
    if (record.proxy?.enabled) {
      if (this.changing.has(id)) throw new Error('此窗口正在调整，请稍后重试。')
      this.changing.add(id)
      try {
        this.windowRevisions.set(id, (this.windowRevisions.get(id) || 0) + 1)
        const item = this.instances.get(id)
        if (item?.owner === identity.owner) this.views?.close(identity.owner, id)
        this.instances.delete(id)
      } finally { this.changing.delete(id) }
      return this.focus(id)
    }
    const result = await this.focus(id)
    if (result.state === 'cancelled' || !this.views || this.active !== id || !this.available(identity, lifecycle)) return { state: 'cancelled' }
    const item = this.instances.get(id)
    if (item?.owner !== identity.owner) throw new Error('登录状态已变化。')
    this.views.reload(identity.owner, id)
    return { state: 'loading' }
  }

  async back(id: string) {
    const identity = this.identity(), lifecycle = this.lifecycle
    await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (!this.instances.has(id) || !this.views) return false
    return this.views.back(identity.owner, id)
  }

  async getPermissions(id: string) {
    const identity = this.identity(), lifecycle = this.lifecycle
    const row = await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    const live = this.instances.has(id) && this.views ? this.views.getPermissions(identity.owner, id) : { microphone: false }
    return { microphone: live.microphone, notifications: row.notificationsEnabled === true }
  }

  async setPermissionConsent(id: string, permission: 'microphone' | 'notifications', allowed: boolean) {
    if (!['microphone', 'notifications'].includes(permission) || typeof allowed !== 'boolean') throw new Error('Google Voice 权限无效。')
    const identity = this.identity(), lifecycle = this.lifecycle
    await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (permission === 'notifications') {
      const row = await this.records.update(identity.owner, id, { notificationsEnabled: allowed }); this.requireAvailable(identity, lifecycle)
      const item = this.instances.get(id)
      if (item?.owner === identity.owner) {
        item.record.notificationsEnabled = row.notificationsEnabled === true
        // HelloDog owns the privacy-preserving desktop notification. Granting
        // the website as well could expose SMS bodies and produce two alerts.
        this.views?.setPermissionConsent(identity.owner, id, 'notifications', false)
      }
      if (!allowed) this.options.clearNotifications?.(id)
      return this.getPermissions(id)
    }
    if (this.instances.get(id)?.owner !== identity.owner || !this.views) throw new Error('请先打开对应的 Google Voice 窗口。')
    this.views.setPermissionConsent(identity.owner, id, permission, allowed)
    return this.getPermissions(id)
  }

  observeUnread(event: IpcMainInvokeEvent, raw: unknown): boolean {
    const page = this.trustedPage(event), item = this.instances.get(page.accountId)
    if (!item || !page.authorized()) return false
    const update = this.unread.observe(page.accountId, raw)
    if (!update) return false
    this.options.onUnread?.(page.accountId, update.count)
    if (update.count === 0) this.options.clearNotifications?.(page.accountId)
    const identity = this.identity(), lifecycle = this.lifecycle
    const authorized = () => this.available(identity, lifecycle) && page.authorized() && this.instances.get(page.accountId) === item && item.record.notificationsEnabled === true
    const attended = this.active === page.accountId && !this.overlay && this.bounds.width > 0 && this.bounds.height > 0 && this.window.isVisible() && !this.window.isMinimized() && this.window.isFocused()
    if (update.increased && authorized() && !attended) this.options.notify?.(page.accountId, authorized)
    return true
  }

  private clearUnread(id: string): void {
    this.unread.clear(id); this.options.onUnread?.(id, null); this.options.clearNotifications?.(id)
  }

  trustedPage(event: IpcMainInvokeEvent): GoogleVoiceTrustedPage {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    if (!this.views) throw new Error('Google Voice 页面尚未打开。')
    const page = this.views.trustedPage(event), item = this.instances.get(page.accountId)
    const version = this.windowRevisions.get(page.accountId) || 0
    const authorized = () => this.available(identity, lifecycle, page.accountId, version) &&
      this.instances.get(page.accountId) === item && item?.owner === page.owner && page.owner === identity.owner && page.authorized()
    if (!authorized()) throw new Error('Google Voice 页面或登录状态已变化。')
    return { owner: page.owner, accountId: page.accountId, url: page.url, authorized }
  }

  detachAll(): Promise<void> {
    this.lifecycle++; this.hide()
    for (const id of this.instances.keys()) this.clearUnread(id)
    this.tearingDown = true
    try { this.views?.destroy() }
    finally { this.views = undefined; this.instances.clear(); this.tearingDown = false }
    // Only live contents are destroyed. Persistent login profiles remain on D:.
    return Promise.resolve()
  }
}
