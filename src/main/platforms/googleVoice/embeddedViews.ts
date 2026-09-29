import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, WebContentsView, session, type BrowserWindow, type Rectangle, type Session, type WebContents, type WebPreferences, type IpcMainInvokeEvent, type DownloadItem } from 'electron'
import { isOfficialGoogleAccountsHost } from './googleAccountDomains'
import { configureProxySession, type AccountProxy } from '../../network/accountProxy'
import { attachGoogleVoiceProxyAuth, checkGoogleVoiceSession, prepareGoogleVoiceNetwork, type GoogleVoiceNetworkRoute } from './network'
import { installGoogleVoiceContextMenu } from './contextMenu'
import type { GoogleVoicePage } from '../../../shared/googleVoicePage'
import type { GoogleVoiceNetworkState } from '../../../shared/googleVoiceNetwork'
import { parseGoogleVoiceRuntimeHealth, type GoogleVoiceRuntimeHealth } from '../../../shared/googleVoiceRuntimeHealth'
export type { GoogleVoiceNetworkState } from '../../../shared/googleVoiceNetwork'

const START_URL = 'https://voice.google.com/u/0/'
const PAGE_ZOOM_FACTOR = 0.9
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// A closed view and its replacement can share a persistent Chromium session.
// Serialize setup/cleanup so an older completion never changes the new route.
const sessionChanges = new WeakMap<Session, Promise<void>>()
function changeSession(ses: Session, action: () => Promise<void>): Promise<void> {
  const work = (sessionChanges.get(ses) || Promise.resolve()).catch(() => undefined).then(action)
  sessionChanges.set(ses, work); return work
}

/** Only top-level pages required by Voice and its official Google sign-in/help. */
export function isGoogleVoiceEmbeddedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    if (['voice.google.com', 'support.google.com'].includes(url.hostname)) return true
    // Google can complete verification on a country Accounts host. Trust only
    // the pinned official list and a literal HTTPS authority, not URL-parser
    // normalizations of Unicode, escaped or backslash-containing hostnames.
    if (isOfficialGoogleAccountsHost(url.hostname)) {
      const authority = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(value)
      return authority?.[1].toLowerCase() === url.hostname
    }
    // Google lists accounts.youtube.com as a sign-in dependency. Its SetSID
    // bridge may be a top-level redirect after verification; allow only these
    // exact endpoints, not YouTube browsing.
    if (url.hostname === 'accounts.youtube.com') return /^https:\/\/accounts\.youtube\.com(?:[/?#]|$)/i.test(value) &&
      ['/SetSID', '/accounts/SetSID'].includes(url.pathname)
    return url.hostname === 'workspace.google.com' && /^\/(?:intl\/[^/]+\/)?products\/voice(?:\/|$)/.test(url.pathname)
  } catch { return false }
}

/** Classify only the official location; a help article is not proof of suspension. */
export function googleVoicePage(value: string): GoogleVoicePage {
  if (!isGoogleVoiceEmbeddedUrl(value)) return 'unknown'
  const url = new URL(value)
  if (url.hostname === 'voice.google.com') return /^\/u\/\d+\/messages\/?$/.test(url.pathname) ? 'messages' : 'voice'
  if (isOfficialGoogleAccountsHost(url.hostname) || url.hostname === 'accounts.youtube.com') return 'sign-in'
  if (url.hostname === 'support.google.com') return url.pathname === '/accounts/answer/40039' && url.searchParams.getAll('p').length === 1 && url.searchParams.get('p') === 'grandcentral' ? 'access-help' : 'help'
  if (url.hostname === 'workspace.google.com') return 'product'
  return 'unknown'
}

/** New isolated Electron storage; never imports a Chrome profile or Google cookies. */
export function googleVoiceEmbeddedPartition(owner: string, windowId: string): string {
  if (typeof owner !== 'string' || !owner || owner.length > 512 || typeof windowId !== 'string' || !/^gv-[a-f0-9-]{36}$/.test(windowId)) {
    throw new Error('Google Voice 窗口身份无效。')
  }
  // 128-bit identifiers keep Chromium cache paths below common Windows limits.
  return `persist:google-voice-embedded-v1-${hash(owner).slice(0, 32)}-${hash(windowId).slice(0, 32)}`
}

/** `ready` means the main document is usable, not that Google sign-in succeeded. */
export type GoogleVoiceEmbeddedStatus = 'loading' | 'ready' | 'failed' | 'closed'
export interface GoogleVoiceEmbeddedState {
  ownerHash: string
  windowId: string
  status: GoogleVoiceEmbeddedStatus
  page: GoogleVoicePage
  origin: string
  popupDepth: number
  selected: boolean
  canGoBack: boolean
  network?: GoogleVoiceNetworkState
  runtimeHealth?: GoogleVoiceRuntimeHealth
}
export interface GoogleVoiceConnection { proxy?: AccountProxy; password: string }
export interface GoogleVoiceEmbeddedBlocked {
  ownerHash: string
  windowId: string
  origin: string
  reason: 'navigation' | 'popup-limit' | 'popup-unavailable' | 'background-tab'
}
export interface GoogleVoiceEmbeddedOptions {
  preloadPath?: string
  onPage?: (page: { owner: string; accountId: string; webContents: WebContents }) => void
  onState?: (state: GoogleVoiceEmbeddedState) => void
  onBlockedNavigation?: (event: GoogleVoiceEmbeddedBlocked) => void
  authorizeOwner?: (owner: string) => boolean
}
export interface GoogleVoiceTrustedPage { owner: string; accountId: string; url: string; authorized: () => boolean }
interface Page { view: WebContentsView; status: GoogleVoiceEmbeddedStatus; origin: string; epoch: number; leavingVoice: boolean; runtimeHealth?: GoogleVoiceRuntimeHealth; healthTimer?: ReturnType<typeof setTimeout>; detachAuth?: () => void; detachMenu?: () => void }
interface Record {
  key: string; owner: string; ownerHash: string; windowId: string; session: Session; pages: Page[]; audioConsent: boolean; notificationsConsent: boolean
  downloads: Map<DownloadItem, Page>
  downloadHandler?: (event: Electron.Event, item: DownloadItem, webContents: WebContents) => void
  connection?: GoogleVoiceConnection; route?: GoogleVoiceNetworkRoute; networkReady: boolean; configuring?: Promise<void>
  networkTimer?: ReturnType<typeof setTimeout>
  checkAbort?: AbortController
  checking?: Promise<GoogleVoiceNetworkState>; network: GoogleVoiceNetworkState
}
const originOf = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : '' } catch { return '' }
}
const securePreferences = (partition: string, preload?: string): WebPreferences => ({
  partition, ...(preload ? { preload } : {}), sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false, contextIsolation: true, webSecurity: true,
  allowRunningInsecureContent: false, webviewTag: false, devTools: false,
  navigateOnDragDrop: false, spellcheck: true, zoomFactor: PAGE_ZOOM_FACTOR
})

/**
 * Genuine child views in the Electron contentView. This class launches no external
 * browser and runs no page scripts. Google decides whether embedded sign-in works.
 * Callers must authenticate owner/window ownership before using this main-only API.
 */
export class GoogleVoiceEmbeddedViews {
  private readonly records = new Map<string, Record>()
  private selected?: string
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private overlayOpen = false
  private disposed = false
  private readonly parentLayout = () => this.layout()
  private readonly parentClosed = () => this.destroy()

  constructor(private readonly parent: BrowserWindow, private readonly options: GoogleVoiceEmbeddedOptions = {}) {
    parent.on('resize', this.parentLayout); parent.on('show', this.parentLayout); parent.on('hide', this.parentLayout)
    parent.on('minimize', this.parentLayout); parent.on('restore', this.parentLayout)
    parent.once('closed', this.parentClosed)
  }

  get count(): number { return this.records.size }

  /** Creates/selects a window immediately. Loading progress is delivered via onState. */
  create(owner: string, windowId: string, connection?: GoogleVoiceConnection): GoogleVoiceEmbeddedState {
    this.assertLive()
    const key = googleVoiceEmbeddedPartition(owner, windowId)
    if (!this.records.has(key)) {
      if (this.records.size >= 20) throw new Error('最多可添加 20 个 Google Voice 窗口。')
      const record: Record = { key, owner, ownerHash: hash(owner), windowId, session: session.fromPartition(key), pages: [], audioConsent: false, notificationsConsent: false, downloads: new Map(), connection, networkReady: !connection, network: { mode: connection?.proxy?.enabled ? 'proxy' : 'system', status: 'unchecked' } }
      this.records.set(key, record)
      try {
        // Hold all requests, including service workers, until this window's
        // network configuration has completed. Closed views stay blocked.
        if (connection) record.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: !record.networkReady || this.records.get(key) !== record }))
        this.installPermissions(record)
        const view = new WebContentsView({ webPreferences: securePreferences(key, this.options.preloadPath) })
        this.attachPage(record, view)
        // Main-frame lifecycle events are authoritative. This Promise can reject
        // after the user has already started a different official navigation.
        if (connection) this.startNetwork(record)
        else void view.webContents.loadURL(START_URL).catch(() => undefined)
      } catch {
        this.removeRecord(record)
        throw new Error('Google Voice 内嵌页面未能创建，请重试。')
      }
    }
    return this.focus(owner, windowId)
  }

  focus(owner: string, windowId: string): GoogleVoiceEmbeddedState {
    const record = this.record(owner, windowId)
    const previous = this.selected && this.records.get(this.selected)
    this.selected = record.key; this.layout()
    if (previous && previous !== record) this.emit(previous)
    if (this.visible(record)) this.top(record).view.webContents.focus()
    return this.emit(record)
  }

  hide(): void {
    const previous = this.selected && this.records.get(this.selected)
    this.selected = undefined; this.layout()
    if (previous) this.emit(previous)
  }

  setBounds(bounds: Rectangle): void {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error('Google Voice 显示区域无效。')
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.min(20000, Math.round(bounds.width))), height: Math.max(0, Math.min(20000, Math.round(bounds.height)))
    }
    this.layout()
  }

  setOverlayOpen(open: boolean): void { this.overlayOpen = Boolean(open); this.layout() }

  getState(owner: string, windowId: string): GoogleVoiceEmbeddedState { return this.state(this.record(owner, windowId)) }

  /** First returns from an official popup; otherwise uses Chromium's own history. */
  back(owner: string, windowId: string): boolean {
    const record = this.record(owner, windowId), page = this.top(record)
    if (record.pages.length > 1) { this.removePage(record, page); return true }
    if (page.view.webContents.navigationHistory.canGoBack()) { page.view.webContents.navigationHistory.goBack(); return true }
    return false
  }

  reload(owner: string, windowId: string): void {
    const record = this.record(owner, windowId), page = this.top(record)
    if (record.configuring && record.network.status === 'error') throw new Error(record.network.message || '窗口网络尚未恢复，请退出 HelloDog 后重试。')
    this.revoke(page); page.status = 'loading'; this.layout(); this.emit(record)
    if (record.route?.isClosed?.()) { record.networkReady = false; this.releaseNetworkRoute(record) }
    if (!record.networkReady) this.startNetwork(record)
    else page.view.webContents.reload()
  }

  private startNetwork(record: Record): void {
    if (record.configuring || !record.connection) return
    const page = record.pages[0]
    record.networkReady = false
    record.network = { mode: record.network.mode, status: 'unchecked' }
    let timedOut = false
    record.networkTimer = setTimeout(() => {
      if (!this.alive(record, page)) return
      timedOut = true; page.status = 'failed'; record.networkReady = false
      this.releaseNetworkRoute(record)
      record.network = { mode: record.network.mode, status: 'error', message: '窗口网络初始化超时，请退出 HelloDog 后重试。' }
      this.layout(); this.emit(record)
    }, 15_000)
    record.configuring = prepareGoogleVoiceNetwork(record.connection.proxy, record.connection.password).then(async route => {
      // A local SOCKS bridge can finish opening after its window was closed or
      // timed out. Never let that late result configure a replacement session.
      if (!this.alive(record, page) || timedOut) { this.closeNetworkRoute(route); return }
      record.route = route
      await changeSession(record.session, async () => {
        if (this.alive(record, page) && !timedOut && record.route === route) await configureProxySession(record.session, route.proxy)
      })
      if (!this.alive(record, page) || timedOut || record.route !== route) { this.releaseNetworkRoute(record); return }
      for (const current of record.pages) {
        current.detachAuth?.()
        current.detachAuth = attachGoogleVoiceProxyAuth(current.view.webContents, route.proxy, route.password)
      }
      record.networkReady = true
      const current = this.top(record).view.webContents
      if (isGoogleVoiceEmbeddedUrl(current.getURL())) current.reload()
      else void current.loadURL(START_URL).catch(() => undefined)
      // Diagnostics are explicit user actions. Opening/reloading a window must
      // not send extra IP-service or sign-in probes in the background.
    }).catch(() => {
      this.releaseNetworkRoute(record)
      if (!this.alive(record, page) || timedOut) return
      record.networkReady = false; page.status = 'failed'
      record.network = { mode: record.network.mode, status: 'error', message: '窗口网络配置失败，请检查代理设置后重试。' }
      this.layout(); this.emit(record)
    }).finally(() => { clearTimeout(record.networkTimer); record.networkTimer = undefined; record.configuring = undefined })
  }

  async checkNetwork(owner: string, windowId: string): Promise<GoogleVoiceNetworkState> {
    const record = this.record(owner, windowId)
    if (!record.networkReady || record.connection && !record.route) throw new Error(record.network.message || '窗口网络正在配置，请稍后检测。')
    if (record.checking) return record.checking
    const route = record.route
    const controller = new AbortController(); record.checkAbort = controller
    record.network = { mode: record.network.mode, status: 'checking' }; this.emit(record)
    const operation = checkGoogleVoiceSession(record.session, route?.proxy, route?.password || '', { route, signal: controller.signal }).then(result => {
      if (this.records.get(record.key) !== record || record.route !== route || !record.networkReady) throw new Error('窗口已关闭或网络配置已变化，请重新检测。')
      const authenticationFailed = Object.values(result.checks).some(check => check.code === 'proxy-auth')
      record.network = { mode: record.network.mode, status: result.reachable ? 'checked' : 'error', ...result,
        ...(!result.reachable ? { message: authenticationFailed ? '代理认证失败，请核对账号和密码。' : '部分网络端点未通过检测；请查看各项结果。此检测不验证登录、短信或图片发送。' } : {}) }; this.emit(record)
      return { ...record.network }
    }).catch(() => {
      if (this.records.get(record.key) !== record || record.route !== route || !record.networkReady) throw new Error('窗口已关闭或网络配置已变化，请重新检测。')
      record.network = { mode: record.network.mode, status: 'error', message: '网络检测未完成，请检查网络或代理后重试。' }; this.emit(record)
      return { ...record.network }
    }).finally(() => { if (record.checking === operation) record.checking = undefined; if (record.checkAbort === controller) record.checkAbort = undefined })
    record.checking = operation
    return operation
  }

  /** Must only be called after an explicit user choice in trusted HelloDog UI. */
  setAudioConsent(owner: string, windowId: string, allowed: boolean): void {
    this.record(owner, windowId).audioConsent = allowed === true
  }

  getPermissions(owner: string, windowId: string): { microphone: boolean; notifications: boolean } {
    const record = this.record(owner, windowId)
    return { microphone: record.audioConsent, notifications: record.notificationsConsent }
  }

  setPermissionConsent(owner: string, windowId: string, permission: 'microphone' | 'notifications', allowed: boolean) {
    const record = this.record(owner, windowId)
    if (permission === 'microphone') record.audioConsent = allowed === true
    else if (permission === 'notifications') record.notificationsConsent = allowed === true
    else throw new Error('Google Voice 权限无效。')
    return this.getPermissions(owner, windowId)
  }

  invalidateContext(): void { for (const record of this.records.values()) for (const page of record.pages) this.revoke(page) }

  /** This is only the browser boundary; Workspace additionally binds HelloDog identity. */
  trustedPage(event: IpcMainInvokeEvent): GoogleVoiceTrustedPage {
    this.assertLive()
    let match: { record: Record; page: Page } | undefined
    for (const record of this.records.values()) {
      const page = record.pages.find(item => item.view.webContents === event.sender)
      if (page) { match = { record, page }; break }
    }
    if (!match) throw new Error('此操作只能来自 Google Voice 主页面。')
    const { record, page } = match, wc = page.view.webContents, frame = event.senderFrame, epoch = page.epoch
    const url = wc.getURL()
    const authorized = () => {
      try {
        return this.alive(record, page) && this.top(record) === page && !page.leavingVoice && page.status !== 'failed' && page.epoch === epoch && frame === wc.mainFrame && !frame.detached &&
          wc.getURL() === url && isGoogleVoiceEmbeddedUrl(url) && originOf(url) === 'https://voice.google.com' &&
          isGoogleVoiceEmbeddedUrl(frame.url) && originOf(frame.url) === 'https://voice.google.com'
      } catch { return false }
    }
    if (!authorized()) throw new Error('Google Voice 页面已变化，请重新操作。')
    return { owner: record.owner, accountId: record.windowId, url, authorized }
  }

  observeRuntimeHealth(event: IpcMainInvokeEvent, input: unknown): boolean {
    const health = parseGoogleVoiceRuntimeHealth(input)
    if (!health) return false
    const trusted = this.trustedPage(event), record = this.record(trusted.owner, trusted.accountId), page = this.top(record)
    if (!trusted.authorized() || page.view.webContents !== event.sender) return false
    if (JSON.stringify(page.runtimeHealth) === JSON.stringify(health)) return true
    page.runtimeHealth = health
    clearTimeout(page.healthTimer); page.healthTimer = undefined
    this.watchRuntimeHealth(record, page); this.emit(record)
    return true
  }

  close(owner: string, windowId: string): void { this.removeRecord(this.record(owner, windowId)) }

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.parent.removeListener('resize', this.parentLayout); this.parent.removeListener('show', this.parentLayout)
    this.parent.removeListener('hide', this.parentLayout); this.parent.removeListener('minimize', this.parentLayout)
    this.parent.removeListener('restore', this.parentLayout)
    this.parent.removeListener('closed', this.parentClosed)
    for (const record of [...this.records.values()]) this.removeRecord(record)
  }

  private assertLive(): void {
    if (this.disposed || this.parent.isDestroyed()) throw new Error('Google Voice 客户端窗口已关闭。')
  }

  private record(owner: string, windowId: string): Record {
    this.assertLive()
    const record = this.records.get(googleVoiceEmbeddedPartition(owner, windowId))
    if (!record) throw new Error('Google Voice 窗口不存在。')
    return record
  }

  private alive(record: Record, page: Page): boolean {
    return !this.disposed && this.records.get(record.key) === record && record.pages.includes(page) && !page.view.webContents.isDestroyed()
  }

  private top(record: Record): Page { return record.pages[record.pages.length - 1] }

  private state(record: Record): GoogleVoiceEmbeddedState {
    const page = this.top(record), live = page && !page.view.webContents.isDestroyed()
    return {
      ownerHash: record.ownerHash, windowId: record.windowId, status: live ? page.status : 'closed',
      page: live && page.status === 'ready' ? googleVoicePage(page.view.webContents.getURL()) : 'unknown',
      origin: live ? page.origin : '', popupDepth: Math.max(0, record.pages.length - 1), selected: this.selected === record.key,
      canGoBack: Boolean(live && (record.pages.length > 1 || page.view.webContents.navigationHistory.canGoBack())), network: { ...record.network },
      runtimeHealth: live && page.status === 'ready' && page.origin === 'https://voice.google.com' && page.runtimeHealth ? { ...page.runtimeHealth } : undefined
    }
  }

  private emit(record: Record): GoogleVoiceEmbeddedState {
    const state = this.state(record)
    try { this.options.onState?.(state) } catch { /* UI observers cannot break browser cleanup. */ }
    return state
  }

  private blocked(record: Record, url: string, reason: GoogleVoiceEmbeddedBlocked['reason']): void {
    try { this.options.onBlockedNavigation?.({ ownerHash: record.ownerHash, windowId: record.windowId, origin: originOf(url), reason }) } catch { /* no URLs or credentials are logged */ }
  }

  private attachPage(record: Record, view: WebContentsView): Page {
    const previous = this.top(record)
    if (previous) this.revoke(previous)
    const page: Page = { view, status: 'loading', origin: '', epoch: 0, leavingVoice: false }
    // Match a normal browser's canvas; transparent official pages may use dark
    // text. Google can still apply its own light/dark theme on top of this.
    record.pages.push(page); view.setVisible(false); view.setBackgroundColor('#ffffff')
    this.parent.contentView.addChildView(view)
    const wc = view.webContents
    // Native page zoom keeps Chromium's layout and pointer hit testing aligned.
    // Isolate it from the HelloDog shell and other webContents, including guests
    // adopted from window.open. Reapply after navigation when Chromium restores
    // the destination origin's saved page settings.
    wc.setZoomMode('isolated')
    const applyPageZoom = () => { if (this.alive(record, page)) wc.setZoomFactor(PAGE_ZOOM_FACTOR) }
    applyPageZoom()
    page.detachMenu = installGoogleVoiceContextMenu(wc, () => this.alive(record, page) && page.status !== 'failed' && this.selected === record.key && this.top(record) === page && !this.overlayOpen && (this.options.authorizeOwner?.(record.owner) ?? true))
    if (record.connection) {
      wc.setWebRTCIPHandlingPolicy(record.connection.proxy?.enabled ? 'disable_non_proxied_udp' : 'default')
      if (record.route) page.detachAuth = attachGoogleVoiceProxyAuth(wc, record.route.proxy, record.route.password)
    }
    const navigate = (event: Electron.Event, url: string) => {
      if (!isGoogleVoiceEmbeddedUrl(url)) { event.preventDefault(); this.blocked(record, url, 'navigation') }
    }
    wc.on('will-navigate', (event, url) => navigate(event, event.url || url))
    wc.on('will-redirect', (event, url, _inPlace, isMain) => { if (event.isMainFrame ?? isMain) navigate(event, event.url || url) })
    wc.on('will-attach-webview', event => event.preventDefault())
    wc.on('content-bounds-updated', event => event.preventDefault())
    wc.on('did-start-navigation', (event, url, inPlace, isMain) => {
      if ((event.isMainFrame ?? isMain) && this.alive(record, page)) {
        this.revoke(page)
        // Reject fresh calls from the outgoing document before Chromium has
        // replaced its URL/frame with an official login or help destination.
        page.leavingVoice = originOf(event.url || url) !== 'https://voice.google.com'
        if (!(event.isSameDocument ?? inPlace)) { page.runtimeHealth = undefined; page.status = 'loading'; this.emit(record) }
      }
    })
    wc.on('did-navigate', (_event, url) => { if (this.alive(record, page)) { applyPageZoom(); page.origin = originOf(url); this.emit(record) } })
    wc.on('did-navigate-in-page', (_event, url, isMain) => { if (isMain && this.alive(record, page)) { page.origin = originOf(url); this.emit(record) } })
    const documentReady = () => {
      if (record.networkReady && this.alive(record, page)) { applyPageZoom(); page.status = 'ready'; page.origin = originOf(wc.getURL()); page.leavingVoice = page.origin !== 'https://voice.google.com'; this.layout(); this.emit(record) }
    }
    // A hung analytics/image request must not leave an interactive official page
    // behind a permanent loading indicator. Subresource loads never reset this.
    wc.on('dom-ready', documentReady)
    wc.on('did-finish-load', documentReady)
    wc.on('preload-error', () => {
      if (!this.alive(record, page)) return
      clearTimeout(page.healthTimer); page.healthTimer = undefined
      page.runtimeHealth = { phase: 'error', code: 'preload-failed', messageCount: 0 }
      this.emit(record)
    })
    wc.on('did-fail-load', (_event, code, _description, _url, isMain) => {
      if (isMain && code !== -3 && this.alive(record, page)) {
        this.revoke(page); page.status = 'failed'
        if (record.network.mode === 'proxy') record.network = { mode: 'proxy', status: 'error', message: '页面连接失败，请检查代理后重试。' }
        this.layout(); this.emit(record)
      }
    })
    wc.on('render-process-gone', () => { if (this.alive(record, page)) { this.revoke(page); page.status = 'failed'; this.layout(); this.emit(record) } })
    wc.once('destroyed', () => {
      if (this.records.get(record.key) !== record || !record.pages.includes(page)) return
      if (record.pages[0] === page) this.removeRecord(record)
      else this.removePage(record, page)
    })
    wc.setWindowOpenHandler(details => {
      if (!this.alive(record, page) || !isGoogleVoiceEmbeddedUrl(wc.getURL()) || !(isGoogleVoiceEmbeddedUrl(details.url) || details.url === 'about:blank')) {
        this.blocked(record, details.url, 'navigation'); return { action: 'deny' }
      }
      // Electron does not provide a precreated guest for background-tab links.
      // Do not reconstruct a navigation that could lose POST/opener semantics.
      if (details.disposition === 'background-tab') { this.blocked(record, details.url, 'background-tab'); return { action: 'deny' } }
      if (record.pages.length >= 5) { this.blocked(record, details.url, 'popup-limit'); return { action: 'deny' } }
      return {
        action: 'allow', outlivesOpener: false,
        overrideBrowserWindowOptions: { show: false, webPreferences: { ...securePreferences(record.key, this.options.preloadPath), session: record.session } },
        createWindow: options => {
          // Electron supplies the guest here. Adopting that exact instance keeps
          // the original POST, referrer and window.opener relationship intact.
          const guest = (options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents
          if (!guest) {
            if (this.alive(record, page) && record.pages.length < 5 && isGoogleVoiceEmbeddedUrl(details.url) && !details.postBody) {
              // A normal target=_blank GET has no precreated guest. Electron
              // delegates navigation to us in this branch; retain its referrer
              // policy and isolated session, without inventing POST/opener data.
              const child = new WebContentsView({ webPreferences: { ...options.webPreferences, ...securePreferences(record.key, this.options.preloadPath), session: record.session, preload: this.options.preloadPath } })
              this.attachPage(record, child)
              void child.webContents.loadURL(details.url, { httpReferrer: details.referrer }).catch(() => undefined)
              this.layout(); this.emit(record)
              if (this.visible(record)) child.webContents.focus()
              return child.webContents
            }
            this.blocked(record, details.url, 'popup-unavailable')
            // With no precreated guest Electron performs no navigation after
            // this callback. Return a safe, unmounted blank child and close it;
            // never reinterpret a POST or accidentally return the opener.
            const unused = new WebContentsView({ webPreferences: securePreferences(record.key) })
            unused.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            unused.webContents.on('will-navigate', event => event.preventDefault())
            setTimeout(() => { if (!unused.webContents.isDestroyed()) unused.webContents.close({ waitForBeforeUnload: false }) }, 0)
            return unused.webContents
          }
          const child = new WebContentsView({ webContents: guest })
          if (!this.alive(record, page) || record.pages.length >= 5 || guest.session !== record.session) {
            guest.close({ waitForBeforeUnload: false }); this.blocked(record, details.url, 'popup-unavailable'); return guest
          }
          this.attachPage(record, child); this.layout(); this.emit(record)
          if (this.visible(record)) guest.focus()
          return guest
        }
      }
    })
    try { this.options.onPage?.({ owner: record.owner, accountId: record.windowId, webContents: wc }) } catch { /* a diagnostic observer cannot break an official page */ }
    return page
  }

  private installPermissions(record: Record): void {
    const permitted = (wc: WebContents | null, origin: string | undefined, main: boolean) => Boolean(
      this.records.get(record.key) === record && wc && !wc.isDestroyed() && wc.session === record.session &&
      record.pages.some(page => page.view.webContents === wc) && main === true &&
      originOf(wc.getURL()) === 'https://voice.google.com' && origin && originOf(origin) === 'https://voice.google.com'
    )
    record.session.setPermissionCheckHandler((wc, permission, origin, details) =>
      permitted(wc, origin, details.isMainFrame) && (permission === 'clipboard-sanitized-write' || permission === 'media' && details.mediaType === 'audio' && record.audioConsent || permission === 'notifications' && record.notificationsConsent))
    record.session.setPermissionRequestHandler((wc, permission, callback, details) => {
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined
      callback(permitted(wc, details.requestingUrl, details.isMainFrame) &&
        (permission === 'clipboard-sanitized-write' || permission === 'notifications' && record.notificationsConsent || permission === 'media' && record.audioConsent && Boolean(types?.length) && types!.every(type => type === 'audio')))
    })
    record.session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    record.downloadHandler = (_event, item, wc) => {
      const page = record.pages.find(candidate => candidate.view.webContents === wc)
      if (!page || !this.alive(record, page) || page.status === 'failed' || wc.session !== record.session ||
        !isGoogleVoiceEmbeddedUrl(wc.getURL()) || originOf(wc.getURL()) !== 'https://voice.google.com') {
        item.cancel(); return
      }
      try {
        let filename = Array.from(item.getFilename().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '')).slice(0, 180).join('') || 'attachment'
        if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = 'attachment-' + filename
        item.setSaveDialogOptions({ title: '保存 Google Voice 附件', defaultPath: join(app.getPath('downloads'), filename) })
        record.downloads.set(item, page)
        item.once('done', () => record.downloads.delete(item))
      } catch { item.cancel() }
    }
    record.session.on('will-download', record.downloadHandler)
  }

  private visible(record: Record): boolean {
    return !this.disposed && !this.parent.isDestroyed() && this.parent.isVisible() && !this.parent.isMinimized() &&
      this.selected === record.key && !this.overlayOpen && this.bounds.width > 0 && this.bounds.height > 0
  }

  private layout(): void {
    if (this.disposed || this.parent.isDestroyed()) return
    const [width, height] = this.parent.getContentSize()
    const bounds = { ...this.bounds, width: Math.max(0, Math.min(this.bounds.width, width - this.bounds.x)), height: Math.max(0, Math.min(this.bounds.height, height - this.bounds.y)) }
    for (const record of this.records.values()) for (const page of record.pages) {
      if (page.view.webContents.isDestroyed()) continue
      page.view.setVisible(this.visible(record) && this.top(record) === page && page.status !== 'failed' && bounds.width > 0 && bounds.height > 0)
      page.view.setBounds({ ...bounds, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) })
      this.watchRuntimeHealth(record, page)
    }
  }

  private watchRuntimeHealth(record: Record, page: Page): void {
    if (!this.visible(record) || this.top(record) !== page || page.status !== 'ready' || page.origin !== 'https://voice.google.com') {
      clearTimeout(page.healthTimer); page.healthTimer = undefined; return
    }
    // Even 'waiting' proves that the runtime booted: the official message list
    // can legitimately have no selected conversation for an unlimited time.
    if (!this.options.preloadPath || page.healthTimer || page.runtimeHealth) return
    const epoch = page.epoch
    page.healthTimer = setTimeout(() => {
      page.healthTimer = undefined
      // Hidden/covered pages can be throttled. Report only while this document
      // remains visible and current; never reload it or change send permissions.
      if (!this.alive(record, page) || page.epoch !== epoch || !this.visible(record) || this.top(record) !== page ||
        page.status !== 'ready' || page.origin !== 'https://voice.google.com' || page.runtimeHealth) return
      page.runtimeHealth = { phase: 'error', code: 'runtime-unavailable', messageCount: 0 }; this.emit(record)
    }, 15000)
    page.healthTimer.unref?.()
  }

  private removePage(record: Record, page: Page): void {
    this.revoke(page)
    page.detachAuth?.()
    page.detachMenu?.()
    for (const [item, source] of record.downloads) if (source === page) { item.cancel(); record.downloads.delete(item) }
    record.pages = record.pages.filter(item => item !== page)
    const current = this.top(record)
    if (current) this.revoke(current)
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(page.view)
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false })
    this.layout(); this.emit(record)
    if (record.pages.length && this.visible(record)) this.top(record).view.webContents.focus()
  }

  private removeRecord(record: Record): void {
    this.records.delete(record.key); record.audioConsent = false; record.notificationsConsent = false; record.networkReady = false
    clearTimeout(record.networkTimer); record.networkTimer = undefined
    this.releaseNetworkRoute(record)
    if (record.downloadHandler) record.session.removeListener('will-download', record.downloadHandler)
    for (const item of record.downloads.keys()) item.cancel()
    record.downloads.clear()
    if (this.selected === record.key) this.selected = undefined
    const pages = record.pages; record.pages = []
    for (const page of [...pages].reverse()) {
      this.revoke(page)
      page.detachAuth?.()
      page.detachMenu?.()
      if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(page.view)
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false })
    }
    if (record.connection) { record.connection.password = ''; void changeSession(record.session, () => record.session.closeAllConnections()).catch(() => undefined) }
    // Do not clear session storage: an explicitly closed tab may be reopened.
    this.layout(); this.emit(record)
  }

  private revoke(page: Page): void {
    clearTimeout(page.healthTimer); page.healthTimer = undefined
    page.epoch++
    if (!page.view.webContents.isDestroyed()) {
      try { page.view.webContents.send('google-voice:context-changed') } catch { /* closing renderer */ }
    }
  }

  private closeNetworkRoute(route: GoogleVoiceNetworkRoute): void {
    // Closing a bridge is independent of Chromium's serialized configuration;
    // a hung native operation must never keep its proxy listener alive.
    void Promise.resolve().then(() => route.close()).catch(() => undefined)
  }

  private releaseNetworkRoute(record: Record): void {
    record.checkAbort?.abort(); record.checkAbort = undefined
    const route = record.route; record.route = undefined
    for (const page of record.pages) { page.detachAuth?.(); page.detachAuth = undefined }
    if (route) this.closeNetworkRoute(route)
  }
}
