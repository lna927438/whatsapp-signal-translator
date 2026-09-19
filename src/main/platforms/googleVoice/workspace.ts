import { createHash } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { GoogleVoiceRecords, type GoogleVoiceRecord } from './windowRecords'
import { GoogleVoiceEmbeddedViews, type GoogleVoiceEmbeddedOptions, type GoogleVoiceEmbeddedState, type GoogleVoiceTrustedPage } from './embeddedViews'

type Identity = { owner: string; authorized: () => boolean }
type Bounds = { x: number; y: number; width: number; height: number }
type Instance = { owner: string; ownerHash: string; record: GoogleVoiceRecord }
type Options = Pick<GoogleVoiceEmbeddedOptions, 'preloadPath' | 'onPage'>

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
  private windowRevisions = new Map<string, number>()

  constructor(private window: BrowserWindow, readonly records: GoogleVoiceRecords, private identity: () => Identity, private options: Options = {}) {
    const layout = () => this.applyBounds()
    window.on('resize', layout)
    window.webContents.on('zoom-changed', layout)
    window.once('closed', () => {
      this.closed = true; window.removeListener('resize', layout)
      window.webContents.removeListener('zoom-changed', layout)
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

  private safe(record: GoogleVoiceRecord) { return { id: record.id, label: record.label, tabOrder: record.tabOrder, browser: record.browser } }

  private ensureViews(): GoogleVoiceEmbeddedViews {
    if (!this.views) {
      this.views = new GoogleVoiceEmbeddedViews(this.window, {
        ...this.options,
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
    const detail = message || (status === 'error' ? `Google Voice 页面未能加载${state.origin ? '（' + state.origin + '）' : ''}，请重试。` : '')
    this.window.webContents.send('google-voice:state', { id: state.windowId, state: status, message: detail, canGoBack: state.canGoBack })
  }

  async list() {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    const rows = await this.records.list(identity.owner); this.requireAvailable(identity, lifecycle)
    return rows.map(row => this.safe(row))
  }

  async add() {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    const row = await this.records.add(identity.owner); this.requireAvailable(identity, lifecycle)
    return this.safe(row)
  }

  async update(id: string, patch: { label?: string }) {
    const identity = this.identity(), lifecycle = this.lifecycle
    this.requireAvailable(identity, lifecycle)
    if (!patch || typeof patch.label !== 'string') throw new Error('名称无效。')
    const row = await this.records.update(identity.owner, id, { label: patch.label }); this.requireAvailable(identity, lifecycle)
    return this.safe(row)
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
    const previous = this.instances.get(id)
    if (previous && previous.owner !== identity.owner) throw new Error('Google Voice 账号已变化，请重新打开。')
    const views = this.ensureViews()
    if (!previous) this.instances.set(id, { owner: identity.owner, ownerHash: createHash('sha256').update(identity.owner).digest('hex'), record })
    try {
      this.active = id
      const state = previous ? views.focus(identity.owner, id) : views.create(identity.owner, id)
      return { state: state.status === 'failed' ? 'error' : state.status === 'closed' ? 'idle' : state.status, canGoBack: state.canGoBack }
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
    const identity = this.identity(), lifecycle = this.lifecycle
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
    await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (!this.instances.has(id) || !this.views) return { microphone: false, notifications: false }
    return this.views.getPermissions(identity.owner, id)
  }

  async setPermissionConsent(id: string, permission: 'microphone' | 'notifications', allowed: boolean) {
    if (!['microphone', 'notifications'].includes(permission) || typeof allowed !== 'boolean') throw new Error('Google Voice 权限无效。')
    const identity = this.identity(), lifecycle = this.lifecycle
    await this.records.get(identity.owner, id); this.requireAvailable(identity, lifecycle)
    if (this.instances.get(id)?.owner !== identity.owner || !this.views) throw new Error('请先打开对应的 Google Voice 窗口。')
    return this.views.setPermissionConsent(identity.owner, id, permission, allowed)
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
    this.tearingDown = true
    try { this.views?.destroy() }
    finally { this.views = undefined; this.instances.clear(); this.tearingDown = false }
    // Only live contents are destroyed. Persistent login profiles remain on D:.
    return Promise.resolve()
  }
}
