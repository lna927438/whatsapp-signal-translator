import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import { whatsappInjectionScript } from './inject/script'

function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '140.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

export class WhatsAppAdapter {
  private readonly views = new Map<string, WebContentsView>()
  private activeId?: string
  private mainWindow?: BrowserWindow
  private overlayOpen = false

  attachMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    window.on('resize', () => this.layout())
  }

  async focus(accountId: string): Promise<void> {
    if (!this.mainWindow) throw new Error('Main window is not attached')
    this.hideAll()
    let view = this.views.get(accountId)
    if (!view || view.webContents.isDestroyed()) {
      view = this.createView(accountId)
      this.views.set(accountId, view)
      this.mainWindow.contentView.addChildView(view)

      const userAgent = chromeUserAgent()
      view.webContents.setUserAgent(userAgent)
      view.webContents.session.setUserAgent(userAgent, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7')
      await view.webContents.session.clearCache()
      await view.webContents.loadURL('https://web.whatsapp.com/', { userAgent })
    }
    this.activeId = accountId
    view.setVisible(!this.overlayOpen)
    this.layout()
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
    view.setVisible(!open)
    if (!open) this.layout()
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
      } catch (error) {
        console.error('WhatsApp injection failed', error)
      }
    })
    return view
  }

  private layout(): void {
    if (!this.mainWindow || !this.activeId) return
    const view = this.views.get(this.activeId)
    if (!view || view.webContents.isDestroyed()) return
    const [width, height] = this.mainWindow.getContentSize()
    const sidebar = 268
    const toolbar = 84
    view.setBounds({ x: sidebar, y: toolbar, width: Math.max(360, width - sidebar), height: Math.max(300, height - toolbar) })
  }
}
