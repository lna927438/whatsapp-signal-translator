import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import { whatsappInjectionScript } from './inject/script'

export class WhatsAppAdapter {
  private readonly views = new Map<string, WebContentsView>()
  private activeId?: string
  private mainWindow?: BrowserWindow

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
      await view.webContents.loadURL('https://web.whatsapp.com/')
    }
    this.activeId = accountId
    view.setVisible(true)
    this.layout()
  }

  hideAll(): void {
    for (const v of this.views.values()) if (!v.webContents.isDestroyed()) v.setVisible(false)
    this.activeId = undefined
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
    view.webContents.setWindowOpenHandler(({ url }) => {
      void import('electron').then(({ shell }) => shell.openExternal(url))
      return { action: 'deny' }
    })
    view.webContents.on('did-finish-load', async () => {
      try { await view.webContents.executeJavaScript(whatsappInjectionScript, true) } catch (e) { console.error('WhatsApp injection failed', e) }
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
