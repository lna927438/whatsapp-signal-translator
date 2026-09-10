import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import { whatsappInjectionScript } from './inject/script'
import { SendNotStartedError, type SendTask } from '../../translation/sendTasks'
import { clampViewBounds, type ViewBounds } from './viewBounds'

function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '140.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}


export class WhatsAppAdapter {
  private readonly views = new Map<string, WebContentsView>()
  private activeId?: string
  private mainWindow?: BrowserWindow
  private overlayOpen = false
  private focusRevision = 0
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
    await contents.executeJavaScript(`window.__RT_APPLY_SETTINGS__?.(${JSON.stringify({ fontSize: value.fontSize, translationColor: value.translationColor, translationsVisible: value.translationsVisible !== false })})`).catch(() => {})
  }

  attachMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    window.on('resize', () => this.layout())
  }

  async focus(accountId: string): Promise<void> {
    if (!this.mainWindow) throw new Error('Main window is not attached')
    this.hideAll()
    const revision = this.focusRevision
    let view = this.views.get(accountId)
    if (!view || view.webContents.isDestroyed()) {
      view = this.createView(accountId)
      this.views.set(accountId, view)
      this.mainWindow.contentView.addChildView(view)

      const userAgent = chromeUserAgent()
      view.webContents.setUserAgent(userAgent)
      view.webContents.session.setUserAgent(userAgent, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7')
      await view.webContents.loadURL('https://web.whatsapp.com/', { userAgent })
    }
    if (revision !== this.focusRevision || view.webContents.isDestroyed()) return
    this.activeId = accountId
    view.setVisible(!this.overlayOpen)
    this.layout()
  }

  hideAll(): void {
    this.focusRevision += 1
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
    view.setVisible(!open)
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

  async submitTask(task: SendTask, authorized: () => boolean): Promise<{ queued: true }> {
    const view = this.views.get(task.accountId)
    const canSend = () => authorized() && this.activeId === task.accountId && !this.overlayOpen
      && Boolean(this.mainWindow?.isFocused()) && view && !view.webContents.isDestroyed()
    if (!canSend() || !view) throw new SendNotStartedError('发送窗口已切换，原对话草稿已保留。')
    const args = JSON.stringify({ id: task.id, conversationId: task.conversationId,
      targetKey: task.targetKey, original: task.request.text, translated: task.translated })
    let dispatched = false
    try {
      // Page guard selects only the snapshotted editor. Input is briefly locked
      // during native insertion; the final guard and button click share one JS turn.
      const selected = await view.webContents.executeJavaScript(`window.__RT_SEND_SELECT__?.(${args})`, true)
      if (!selected || !canSend()) throw new SendNotStartedError('对话或草稿已变化，译文已保存，请回原对话重试。')
      await view.webContents.insertText(task.translated!)
      if (!canSend()) throw new SendNotStartedError('发送窗口已切换，译文已保存。')
      // If the renderer disappears during this call we cannot prove whether it
      // clicked Send. Persist uncertainty, never retry Enter/button automatically.
      dispatched = true
      const result = await view.webContents.executeJavaScript(`window.__RT_SEND_COMMIT__?.(${args})`, true)
      if (result?.dispatched === false) {
        dispatched = false
        throw new SendNotStartedError(result.message || '发送目标已变化，已阻止发送。')
      }
      if (!result?.confirmed) throw new Error('未收到 WhatsApp 对话中的发送确认。')
      return { queued: true }
    } catch (error: any) {
      if (!dispatched) throw new SendNotStartedError(String(error?.message || error))
      throw error
    } finally {
      if (!view.webContents.isDestroyed()) {
        await view.webContents.executeJavaScript(`window.__RT_SEND_RELEASE__?.(${JSON.stringify(task.id)}, ${!dispatched})`).catch(() => {})
      }
    }
  }

  remove(accountId: string): void {
    const view = this.views.get(accountId)
    if (view && !view.webContents.isDestroyed()) {
      this.mainWindow?.contentView.removeChildView(view)
      view.webContents.close()
    }
    this.views.delete(accountId)
    if (this.activeId === accountId) this.activeId = undefined
  }

  private createView(accountId: string): WebContentsView {
    const preload = join(__dirname, '../preload/whatsapp.js')
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:wa:${accountId}`,
        preload,
        additionalArguments: [`--rt-account-id=${accountId}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    const userAgent = chromeUserAgent()
    view.webContents.setUserAgent(userAgent)
    view.webContents.session.setUserAgent(userAgent, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7')

    view.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://web.whatsapp.com/*'] },
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

    view.webContents.setWindowOpenHandler(({ url }) => {
      void import('electron').then(({ shell }) => shell.openExternal(url))
      return { action: 'deny' }
    })
    view.webContents.on('did-finish-load', async () => {
      try {
        await view.webContents.executeJavaScript(whatsappInjectionScript, true)
        await this.applyPreferences(accountId, this.preferences.get(accountId) || {})
      } catch (error) {
        console.error('WhatsApp injection failed', error)
      }
    })
    view.webContents.on('context-menu', () => this.menuHandler?.(accountId))
    return view
  }

  private layout(): void {
    if (!this.mainWindow || !this.activeId) return
    const view = this.views.get(this.activeId)
    if (!view || view.webContents.isDestroyed()) return
    const [width, height] = this.mainWindow.getContentSize()
    const bounds = clampViewBounds(this.bounds, width, height)
    if (bounds) view.setBounds(bounds)
  }
}
