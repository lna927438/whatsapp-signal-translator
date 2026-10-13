import { configureProxySession, normalizeProxy, proxyAuthMatches } from '../../network/accountProxy'
import { installWebSecurity } from '../../webSecurity'
import { app, net, session, Menu, BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { performance } from 'node:perf_hooks'
import { telegramInjectionScript } from './inject/script'
import { SendNotStartedError, SendPendingError, type SendTask } from '../../translation/sendTasks'
import { clampViewBounds, type ViewBounds } from '../whatsapp/viewBounds'
import { markSwitch, setAccountState } from '../../runtimeHealth'
import { boundedOperation } from '../../boundedOperation'
import { telegramContextMenu } from './contextMenu'

function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '140.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}


export class TelegramAdapter {
  private passwordReader: (id: string) => Promise<string> = async () => ''
  constructor() {
    app.on('login', (event, contents, _details, authInfo, callback) => {
      const entry = [...this.views.entries()].find(([, view]) => view.webContents === contents)
      if (!entry) return
      const proxy = this.preferences.get(entry[0])?.proxy
      if (!proxy || !proxyAuthMatches(proxy, authInfo)) return
      event.preventDefault()
      void this.passwordReader(entry[0]).then(password => callback(proxy.username || '', password)).catch(() => callback())
    })
  }
  setPasswordReader(reader: (id: string) => Promise<string>) { this.passwordReader = reader }
  async testProxy(input: any, password: string): Promise<{ ip: string; latencyMs: number }> {
    const proxy = normalizeProxy(input)
    if (!proxy.enabled) throw new Error('请先启用并填写代理。')
    const ses = session.fromPartition(`proxy-test:${Date.now()}:${Math.random()}`, { cache: false })
    const started = Date.now()
    await configureProxySession(ses, proxy)
    try {
      return await new Promise((resolve, reject) => {
        const request = net.request({ url: 'https://api.ipify.org?format=json', session: ses })
        const timer = setTimeout(() => { request.abort(); reject(new Error('代理检测超时，请检查主机、端口和认证。')) }, 12000)
        const fail = () => { clearTimeout(timer); reject(new Error('代理连接失败，请检查地址、端口或账号密码。')) }
        request.on('login', (info, callback) => proxyAuthMatches(proxy, info) ? callback(proxy.username || '', password) : callback())
        request.on('error', fail)
        request.on('response', response => {
          let body = ''
          response.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) { request.abort(); fail() } })
          response.on('error', fail)
          response.on('end', () => {
            clearTimeout(timer)
            try {
              const ip = JSON.parse(body).ip
              if (response.statusCode !== 200 || typeof ip !== 'string' || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new Error()
              resolve({ ip, latencyMs: Date.now() - started })
            } catch { fail() }
          })
        })
        request.end()
      })
    } finally { await ses.closeAllConnections() }
  }

  private readonly views = new Map<string, WebContentsView>()
  private activeId?: string
  private mainWindow?: BrowserWindow
  private overlayOpen = false
  private readonly pageStates = new Map<string, 'loading' | 'ready' | 'failed'>()
  private readonly networkReady = new WeakSet<WebContentsView>()
  private readonly failedDocuments = new WeakSet<WebContentsView>()
  private readonly proxySetups = new Map<string, Promise<void>>()
  private readonly pageLoads = new Map<string, { view: WebContentsView; work: Promise<void>; cancel: () => void }>()
  private bounds: ViewBounds = { x: 248, y: 180, width: 1032, height: 640 }
  private menuHandler?: (accountId: string) => void
  private readonly preferences = new Map<string, any>()

  setMenuHandler(handler: (accountId: string) => void): void { this.menuHandler = handler }
  contents(accountId: string) {
    const contents = this.views.get(accountId)?.webContents
    return contents && !contents.isDestroyed() ? contents : undefined
  }
  setContentBounds(value: ViewBounds): void {
    if (!this.mainWindow) return
    const [width, height] = this.mainWindow.getContentSize()
    const bounds = clampViewBounds(value, width, height, this.mainWindow.webContents.getZoomFactor())
    if (bounds) { this.bounds = bounds; this.layout() }
  }
  async applyPreferences(accountId: string, value: any): Promise<void> {
    this.preferences.set(accountId, value)
    const contents = this.contents(accountId)
    if (!contents) return
    contents.setZoomFactor(Math.max(0.5, Math.min(1.5, Number(value.zoomFactor) || 1)))
    // A page which is loading or has crashed cannot acknowledge injected settings.
    // The latest stored settings are applied again on dom-ready.
    if (this.pageStates.get(accountId) !== 'ready' || contents.isCrashed()) return
    await boundedOperation(contents.executeJavaScript(`window.__RT_APPLY_SETTINGS__?.(${JSON.stringify({ fontSize: value.fontSize, translationColor: value.translationColor, translationsVisible: value.translationsVisible !== false })})`), 1000, '页面设置稍后应用。').catch(() => {})
  }

  attachMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    window.on('resize', () => this.layout())
  }

  async focus(accountId: string): Promise<{ state: 'loading' | 'ready' | 'cancelled' }> {
    if (this.preferences.get(accountId)?.runtimeMode === 'paused') throw new Error('此账号已暂停，请先恢复收消息。')
    const started = performance.now()
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return { state: 'cancelled' }
    this.hideAll()
    let view = this.views.get(accountId)
    if (!view || view.webContents.isDestroyed()) {
      if (view) this.remove(accountId)
      view = this.createView(accountId)
      view.setVisible(false)
      this.views.set(accountId, view)
      this.mainWindow.contentView.addChildView(view)
    }
    // Commit selection and dimensions before any proxy, navigation or page script.
    // Background completion may update this view, but may never change selection.
    this.activeId = accountId
    this.layout()
    if (this.pageStates.get(accountId) !== 'ready' || view.webContents.isCrashed()) {
      void this.loadPage(accountId, view).catch(() => {})
    }
    const state = this.pageStates.get(accountId) === 'ready' ? 'ready' : 'loading'
    this.setPageState(accountId, view, state)
    markSwitch(performance.now() - started)
    return { state }
  }

  hideAll(): void {
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.setVisible(false)
    }
    this.activeId = undefined
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open
    if (!this.activeId) return
    const view = this.views.get(this.activeId)
    if (!view || view.webContents.isDestroyed()) return
    view.setVisible(!open && this.pageStates.get(this.activeId) === 'ready')
    if (!open) this.layout()
  }

  ownsSender(accountId: string, senderId: number): boolean {
    const view = this.views.get(accountId)
    return Boolean(view && !view.webContents.isDestroyed() && view.webContents.id === senderId)
  }

  resetViews(): void {
    this.hideAll()
    for (const id of [...this.views.keys()]) this.remove(id)
    this.overlayOpen = false
  }

  resumeTranslations(): void {
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) void view.webContents.executeJavaScript('window.__RT_RESUME_TRANSLATIONS__?.()').catch(() => {})
    }
  }
  refreshTranslations(): void {
    for (const view of this.views.values()) if (!view.webContents.isDestroyed()) void view.webContents.executeJavaScript('window.__RT_REFRESH_TRANSLATIONS__?.()').catch(() => undefined)
  }

  async prepareRestart(): Promise<void> {
    for (const [accountId, view] of this.views) {
      const contents = view.webContents
      if (contents.isDestroyed()) continue
      // WebRTC and recording are owned by the platform; never interrupt them.
      if (contents.isCurrentlyAudible()) throw new Error('聊天窗口正在使用音频，请先结束通话、录音或播放，再重启。')
      if (this.pageStates.get(accountId) === 'ready' && !contents.isCrashed()) {
        const result = await boundedOperation(contents.executeJavaScript('window.__RT_SAVE_WORKSPACE__?.()'), 1500, '聊天页面暂未响应，草稿尚未确认保存，请稍后重启。')
        if (result?.busy || result?.editing) throw new Error('正在写入消息，请稍后重启。')
        if (result?.media || result?.capturing) throw new Error('请先结束通话、录音或处理附件预览，再重启。')
      }
      await contents.session.flushStorageData()
    }
  }
  private reloads = new Map<string, Promise<void>>()
  reload(accountId: string): Promise<void> {
    const existing = this.reloads.get(accountId)
    if (existing) return existing
    const work = boundedOperation((async () => {
      let view = this.views.get(accountId)
      if (!view || view.webContents.isDestroyed()) {
        await this.focus(accountId)
        view = this.views.get(accountId)
        if (!view) throw new Error('页面尚未准备好，请重新打开账号。')
        await this.pageLoads.get(accountId)?.work
        return
      }
      const contents = view.webContents
      if (contents.isCurrentlyAudible()) throw new Error('聊天窗口正在使用音频，请先结束通话、录音或播放，再刷新页面。')
      const ready = this.pageStates.get(accountId) === 'ready' && !contents.isCrashed()
      if (ready) {
        // Never reload a healthy page until its draft and media guards respond.
        // A crashed/unloaded renderer has no live editing session to interrogate.
        const state = await boundedOperation(contents.executeJavaScript('window.__RT_SAVE_WORKSPACE__?.()'), 1500, '聊天页面暂未响应，已保留草稿，请稍后重试刷新。')
        if (state?.busy || state?.editing) throw new Error('正在处理消息，未刷新页面，请稍后重试；草稿已保留。')
        if (state?.media || state?.capturing || contents.isCurrentlyAudible()) throw new Error('请先结束通话、录音或处理附件预览，再刷新页面。')
      }
      if (this.views.get(accountId) !== view || contents.isDestroyed()) return
      await this.loadPage(accountId, view, ready)
    })(), 32000, '页面刷新超时，账号和草稿已保留。').finally(() => this.reloads.delete(accountId))
    this.reloads.set(accountId, work)
    return work
  }

  private sendPolicyRevision = 0
  async invalidateSendPolicy(accountId?: string): Promise<void> {
    this.sendPolicyRevision++
    await Promise.all([...this.views.entries()].filter(([id, view]) => (!accountId || id === accountId) && !view.webContents.isDestroyed()).map(([,view]) =>
      boundedOperation(view.webContents.executeJavaScript('window.__RT_SEND_INVALIDATE__?.()'), 1500, '聊天页面暂未响应，发送设置尚未更改，请稍后重试。')))
  }

  async submitTask(task: SendTask, authorized: () => boolean): Promise<{ queued: true }> {
    const view = this.views.get(task.accountId)
    const policyRevision = this.sendPolicyRevision
    const canSend = () => policyRevision === this.sendPolicyRevision && authorized() && this.activeId === task.accountId && !this.overlayOpen
      && Boolean(this.mainWindow?.isFocused()) && view && !view.webContents.isDestroyed()
    if (!canSend() || !view) throw new SendNotStartedError('发送窗口已切换，原对话草稿已保留。')
    const args = JSON.stringify({ id: task.id, conversationId: task.conversationId,
      targetKey: task.targetKey, original: task.request.text, translated: task.translated, targetLanguage: task.request.targetLanguage, blockChinese: task.blockChinese !== false })
    let dispatched = false
    try {
      // Page guard selects only the snapshotted editor. Input is briefly locked
      // during native insertion; the final guard and button click share one JS turn.
      const selected = await view.webContents.executeJavaScript(`window.__RT_SEND_SELECT__?.(${args})`, true)
      if (!selected || !canSend()) throw new SendNotStartedError('对话或草稿已变化，译文已保存，请回原对话重试。')
      if(!await this.editComposer(task.accountId,{token:randomUUID(),text:task.translated!,expected:selected.text,targetKey:task.targetKey,conversationId:task.conversationId})) throw new SendNotStartedError('输入框尚未准备好，译文已保留。')
      if (!canSend()) throw new SendNotStartedError('发送窗口已切换，译文已保存。')
      // If the renderer disappears during this call we cannot prove whether it
      // clicked Send. Persist uncertainty, never retry Enter/button automatically.
      dispatched = true
      const result = await view.webContents.executeJavaScript(`window.__RT_SEND_COMMIT__?.(${args})`, true)
      if (result?.dispatched === false) {
        dispatched = false
        throw new SendNotStartedError(result.message || '发送目标已变化，已阻止发送。')
      }
      if (!result?.confirmed) throw new SendPendingError(result)
      return { queued: true, ...result }
    } catch (error: any) {
      if (!dispatched) throw new SendNotStartedError(String(error?.message || error))
      throw error
    } finally {
      if (!view.webContents.isDestroyed()) {
        await view.webContents.executeJavaScript(`window.__RT_SEND_RELEASE__?.(${JSON.stringify(task.id)}, ${!dispatched})`).catch(() => {})
      }
    }
  }

  async editComposer(accountId: string, value: any): Promise<boolean> {
    const contents=this.contents(accountId)
    if(!contents||this.activeId!==accountId||this.overlayOpen||!this.mainWindow?.isFocused())return false
    if(!value||typeof value.text!=='string'||value.text.length>20000||typeof value.expected!=='string'||value.expected.length>20000||! /^[\w-]{1,100}$/.test(value.token||'')||typeof value.targetKey!=='string'||typeof value.conversationId!=='string')return false
    const token=JSON.stringify(value.token)
    try {
      const atomic = await contents.executeJavaScript(`window.__RT_EDIT_ATOMIC__?.(${JSON.stringify(value)})`, true)
      if (typeof atomic === 'boolean') return atomic
      if(!await contents.executeJavaScript(`window.__RT_EDIT_SELECT__?.(${JSON.stringify(value)})`,true))return false
      contents.focus()
      // Collapse any previous selection first. Repeating Ctrl+A on an already
      // selected editor can select the entire page in Chromium.
      contents.sendInputEvent({type:'keyDown',keyCode:'End',modifiers:['control']})
      contents.sendInputEvent({type:'keyUp',keyCode:'End',modifiers:['control']})
      contents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']})
      contents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']})
      contents.sendInputEvent({type:'keyUp',keyCode:'Control'})
      if(!await contents.executeJavaScript(`window.__RT_EDIT_CHECK__?.(${token})`,true))return false
      if(this.activeId!==accountId||this.overlayOpen||!this.mainWindow?.isFocused())return false
      if(value.text) await contents.executeJavaScript(`window.__RT_EDIT_WRITE__?.(${token})`,true)
      else {contents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});contents.sendInputEvent({type:'keyUp',keyCode:'Backspace'})}
      return Boolean(await contents.executeJavaScript(`window.__RT_EDIT_CHECK__?.(${token},true)`,true))
    } finally {if(!contents.isDestroyed()) await contents.executeJavaScript(`window.__RT_EDIT_RELEASE__?.(${token})`).catch(()=>{})}
  }

  async reconcileTask(task: SendTask): Promise<unknown | null> {
    const contents = this.views.get(task.accountId)?.webContents
    const evidence = task.result as any
    if (!contents || contents.isDestroyed() || !Array.isArray(evidence?.baseline) || !evidence?.targetKey) return null
    return contents.executeJavaScript(`window.__RT_SEND_PROBE__?.(${JSON.stringify({ translated: task.translated, baseline: evidence.baseline, targetKey: evidence.targetKey, route: evidence.route, watermark: evidence.watermark, atLatestTail: evidence.atLatestTail })})`).catch(() => null)
  }

  async retryTask(task: SendTask): Promise<boolean> {
    // The records dialog closes first; let its overlay update reach the host.
    for(let n=0;n<30 && this.overlayOpen;n++) await new Promise(resolve=>setTimeout(resolve,20))
    const contents=this.contents(task.accountId)
    if(this.activeId!==task.accountId||this.overlayOpen||!contents)return false
    return Boolean(await contents.executeJavaScript(`window.__RT_RETRY_QUEUED_SEND__?.(${JSON.stringify(task.id)})`,true))
  }

  remove(accountId: string): void {
    setAccountState(accountId, 'closed')
    const view = this.views.get(accountId)
    this.pageLoads.get(accountId)?.cancel()
    this.views.delete(accountId)
    this.pageStates.delete(accountId)
    if (view) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try { this.mainWindow.contentView.removeChildView(view) } catch { /* Native parent may already have detached a destroyed view. */ }
      }
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    if (this.activeId === accountId) this.activeId = undefined
  }

  private setPageState(accountId: string, view: WebContentsView, state: 'loading' | 'ready' | 'failed'): void {
    if (this.views.get(accountId) !== view || view.webContents.isDestroyed()) return
    this.pageStates.set(accountId, state)
    view.setVisible(this.activeId === accountId && !this.overlayOpen && state === 'ready')
    if (this.activeId === accountId) this.layout()
    if (state !== 'ready') setAccountState(accountId, state === 'loading' ? 'loading' : 'disconnected')
    const host = this.mainWindow
    if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) {
      host.webContents.send('ui:account-action', { action: `page-${state}`, accountId })
    }
  }

  private loadPage(accountId: string, view: WebContentsView, reload = false): Promise<void> {
    const existing = this.pageLoads.get(accountId)
    if (existing?.view === view && this.pageStates.get(accountId) === 'loading') return existing.work
    existing?.cancel()
    const contents = view.webContents
    let settled = false, cancel!: () => void
    this.failedDocuments.delete(view)
    this.setPageState(accountId, view, 'loading')
    const work = new Promise<void>((resolve, reject) => {
      const current = () => !settled && this.views.get(accountId) === view && !contents.isDestroyed()
      const cleanup = () => {
        clearTimeout(timer)
        contents.removeListener('dom-ready', ready); contents.removeListener('did-finish-load', ready)
        contents.removeListener('did-fail-load', failed); contents.removeListener('render-process-gone', gone); contents.removeListener('destroyed', gone)
      }
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true; cleanup()
        this.setPageState(accountId, view, ok ? 'ready' : 'failed')
        if (ok) resolve()
        else reject(new Error('Telegram 页面加载未完成，请检查代理或网络后刷新；账号资料已保留。'))
      }
      const ready = () => { if (!this.failedDocuments.has(view)) finish(true) }
      const failed = (_event: unknown, code: number, _description: string, _url: string, isMain: boolean) => { if (isMain && code !== -3) finish(false) }
      const gone = () => finish(false)
      cancel = () => { if (!settled) { settled = true; cleanup(); resolve() } }
      const timer = setTimeout(() => finish(false), 30000)
      contents.once('dom-ready', ready); contents.once('did-finish-load', ready)
      contents.on('did-fail-load', failed); contents.once('render-process-gone', gone); contents.once('destroyed', gone)
      void (async () => {
        if (!this.networkReady.has(view)) {
          const proxy = this.preferences.get(accountId)?.proxy
          // Native setProxy cannot be cancelled. Serialize only this account's
          // session setup so a timed-out old operation cannot overwrite a retry.
          const setup = (this.proxySetups.get(accountId) || Promise.resolve()).catch(() => {}).then(async () => {
            if (current()) await configureProxySession(contents.session, proxy)
          })
          this.proxySetups.set(accountId, setup)
          void setup.finally(() => { if (this.proxySetups.get(accountId) === setup) this.proxySetups.delete(accountId) }).catch(() => {})
          await boundedOperation(setup, 8000, '代理配置未完成。')
          if (!current()) return
          contents.setWebRTCIPHandlingPolicy(proxy?.enabled ? 'disable_non_proxied_udp' : 'default')
          this.networkReady.add(view)
        }
        if (!current()) return
        if (reload) contents.reload()
        else await contents.loadURL('https://web.telegram.org/a/', { userAgent: chromeUserAgent() })
      })().catch(() => { if (current()) finish(false) })
    })
    const entry = { view, work, cancel }
    this.pageLoads.set(accountId, entry)
    void work.finally(() => { if (this.pageLoads.get(accountId) === entry) this.pageLoads.delete(accountId) }).catch(() => {})
    return work
  }

  private createView(accountId: string): WebContentsView {
    const preload = join(__dirname, '../preload/telegram.js')
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:telegram:${accountId}`,
        preload,
        additionalArguments: [`--rt-account-id=${accountId}`],
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: true
      }
    })

    const userAgent = chromeUserAgent()
    setAccountState(accountId, 'loading')
    view.webContents.on('did-fail-load', (_event, code, _description, _url, isMain) => {
      if (isMain && code !== -3) { this.failedDocuments.add(view); this.setPageState(accountId, view, 'failed') }
    })
    view.webContents.on('render-process-gone', () => { this.failedDocuments.add(view); this.setPageState(accountId, view, 'failed') })
    view.webContents.on('dom-ready', () => { if (!this.failedDocuments.has(view)) this.setPageState(accountId, view, 'ready') })
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' || input.control && input.key.toLowerCase() === 'r')) {
        event.preventDefault(); void this.reload(accountId).catch(() => this.mainWindow?.webContents.send('translator:error', '刷新未完成，草稿已保留。')); return
      }
      // Editing/search shortcuts belong to Telegram while its view has focus.
      // Host shortcuts are handled by the host renderer instead.
    })
    view.webContents.setUserAgent(userAgent)
    view.webContents.session.setUserAgent(userAgent, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7')

    view.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://web.telegram.org/*'] },
      (details, callback) => {
        const requestHeaders = { ...details.requestHeaders }
        requestHeaders['User-Agent'] = userAgent
        const major = (process.versions.chrome || '140').split('.')[0]
        requestHeaders['sec-ch-ua'] = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="99"`
        requestHeaders['sec-ch-ua-mobile'] = '?0'
        requestHeaders['sec-ch-ua-platform'] = '"Windows"'
        callback({ requestHeaders })
      }
    )

    installWebSecurity(view.webContents, 'telegram')
    const installTranslation = async () => {
      try {
        if (this.views.get(accountId) !== view || view.webContents.isDestroyed()) return
        await boundedOperation(view.webContents.executeJavaScript(telegramInjectionScript, true), 5000, '翻译组件仍在加载。')
        if (this.views.get(accountId) !== view || view.webContents.isDestroyed()) return
        await this.applyPreferences(accountId, this.preferences.get(accountId) || {})
        const ready = await boundedOperation(view.webContents.executeJavaScript('typeof window.__RT_SEND_COMMIT__ === "function" && typeof window.__RT_SEND_SELECT__ === "function"'), 1000, '翻译组件仍在加载。')
        if (ready) view.webContents.send('translator:send-guard-ready')
      } catch (error) {
        console.error('Telegram injection failed')
      }
    }
    view.webContents.on('dom-ready', installTranslation)
    view.webContents.on('did-finish-load', installTranslation)
    view.webContents.on('context-menu', (_event, params) => {
      const items = telegramContextMenu(view.webContents, params, () => this.mainWindow?.webContents.send('translator:error', '此操作未完成，请重试。'))
      if (items.length) Menu.buildFromTemplate(items).popup({ window: this.mainWindow })
    })
    return view
  }

  private layout(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.activeId) return
    const view = this.views.get(this.activeId)
    if (!view || view.webContents.isDestroyed()) return
    const [width, height] = this.mainWindow.getContentSize()
    const bounds = clampViewBounds(this.bounds, width, height)
    if (bounds) view.setBounds(bounds)
  }
}
