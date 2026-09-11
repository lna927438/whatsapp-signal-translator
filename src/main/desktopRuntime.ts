import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import { join } from 'path'
import type { AppSettings } from './types'
let preferences: Partial<AppSettings> = {}
let tray: Tray | undefined
let window: BrowserWindow | undefined
let quitting = false
export function applyDesktopOptions(value: Partial<AppSettings>) {
  if (process.platform === 'win32' || process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: value.autoStart === true })
  preferences = { ...value }
  if (value.closeToTray && !tray) {
    const icon = nativeImage.createFromPath(join(__dirname, '../../resources/brand/hellodog-icon.png')).resize({ width: 20, height: 20 })
    if (icon.isEmpty()) throw new Error('托盘图标不可用，关闭窗口将改为任务栏最小化。')
    tray = new Tray(icon); tray.setToolTip('HelloDog')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 HelloDog', click: () => { window?.show(); window?.focus() } }, { label: '退出 HelloDog', click: () => { quitting = true; app.quit() } }]))
    tray.on('double-click', () => { window?.show(); window?.focus() })
  } else if (!value.closeToTray && tray) { tray.destroy(); tray = undefined }
  preferences = { ...value }
}
export function attachDesktopRuntime(main: BrowserWindow) {
  window = main
  app.on('before-quit', () => { quitting = true })
  main.on('close', event => { if (!quitting && preferences.closeToTray !== false) { event.preventDefault(); if (tray) main.hide(); else main.minimize() } })
}
export function shouldStartMinimized() { return preferences.startMinimized === true }
export function notifyAccount(accountId: string, label: string) {
  if (!window || preferences.notifications === 'off' || (preferences.notifications !== 'always' && window.isFocused()) || !Notification.isSupported()) return
  const notification = new Notification({ title: 'HelloDog · 新消息', body: label + ' 有新消息', silent: preferences.notificationSound !== true })
  notification.on('click', () => { window?.show(); window?.focus(); window?.webContents.send('ui:account-action', { action: 'focus', accountId }) })
  notification.show()
}
