import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, dialog } from 'electron'
import { join } from 'path'
import type { AppSettings } from './types'
import { RestartCoordinator } from './restartCoordinator'
import { setMainUiLanguage, t } from './uiLocale'
import { UnreadState, unreadBitmap } from './unreadState'
const unread = new UnreadState()
export function accountUnreadSnapshot() { return unread.snapshot() }
export function updateAccountUnread(id:string,count:number) { const increased=unread.set(id,count); refreshUnreadBadge(); return increased }
export function clearAccountUnread(id?:string) { unread.remove(id); refreshUnreadBadge() }
function refreshUnreadBadge() {
  if (!window || window.isDestroyed()) return
  const count=unread.total
  if (process.platform==='win32') window.setOverlayIcon(count ? nativeImage.createFromBitmap(unreadBitmap(count),{width:32,height:32}) : null, count ? t('{0} 条未读消息', count) : '')
  else app.setBadgeCount?.(count)
  if (tray) {
    tray.setToolTip(count ? t('HelloDog · {0} 条未读消息',count) : 'HelloDog')
    tray.setImage(count ? nativeImage.createFromBitmap(unreadBitmap(count),{width:32,height:32}).resize({width:20,height:20}) : nativeImage.createFromPath(join(__dirname,'../../resources/brand/hellodog-icon.png')).resize({width:20,height:20}))
  }
  if (!count) window.flashFrame(false)
}
let preferences: Partial<AppSettings> = {}
let tray: Tray | undefined
let window: BrowserWindow | undefined
let quitting = false
let checkingQuit = false
let quitCheck: (() => Promise<number>) | undefined
let restartPreparation: (() => Promise<void>) | undefined
export function configureRestart(prepare: () => Promise<void>) { restartPreparation = prepare }
const restart = new RestartCoordinator(async () => {
  if (!restartPreparation) throw new Error(t('软件正在启动，请稍后重试。'))
  await restartPreparation()
}, () => {
  // Electron retains this launch's arguments, including the isolated test profile.
  app.relaunch()
  quitting = true
  app.quit()
})
export function restartDesktop() { return restart.run() }
export function configureQuitGuard(check: () => Promise<number>) { quitCheck = check }
export function applyDesktopOptions(value: Partial<AppSettings>) {
  setMainUiLanguage(value.uiLanguage)
  if ((process.platform === 'win32' || process.platform === 'darwin') && !process.argv.includes('--isolated-test') && !(!app.isPackaged && process.env.HELLODOG_TEST_USER_DATA)) app.setLoginItemSettings({ openAtLogin: value.autoStart === true })
  preferences = { ...value }
  if (value.closeToTray && !tray) {
    const icon = nativeImage.createFromPath(join(__dirname, '../../resources/brand/hellodog-icon.png')).resize({ width: 20, height: 20 })
    if (icon.isEmpty()) throw new Error(t('托盘图标不可用，关闭窗口将改为任务栏最小化。'))
    tray = new Tray(icon); tray.setToolTip('HelloDog')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: t('打开 HelloDog'), click: () => { window?.show(); window?.focus() } }, { label: t('退出 HelloDog'), click: () => { app.quit() } }]))
    tray.on('double-click', () => { window?.show(); window?.focus() })
  } else if (!value.closeToTray && tray) { tray.destroy(); tray = undefined }
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([{ label: t('打开 HelloDog'), click: () => { window?.show(); window?.focus() } }, { label: t('退出 HelloDog'), click: () => { app.quit() } }]))
  preferences = { ...value }
  refreshUnreadBadge()
}
export function attachDesktopRuntime(main: BrowserWindow) {
  window = main
  main.on('focus',()=>main.flashFrame(false))
  refreshUnreadBadge()
  app.on('before-quit', event => {
    if (quitting || !quitCheck) { quitting = true; return }
    event.preventDefault()
    if (checkingQuit) return
    checkingQuit = true
    void (async () => {
      const count = await quitCheck!()
      if (count) {
        const answer = await dialog.showMessageBox(main, { type: 'warning', title: t('还有未完成任务'), message: t('有 {0} 条任务需要继续处理或核对。', count), detail: t('任务和草稿已保存。退出后停止收消息；重新打开会核对原请求，发送结果不明的消息不会自动再次发送。'), buttons: [t('继续后台运行'), t('保留记录并退出')], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) return
      }
      quitting = true; app.quit()
    })().catch(() => { void dialog.showMessageBox(main, { type: 'error', message: t('恢复记录尚未保存，暂未退出。请稍后重试。') }) }).finally(() => { checkingQuit = false })
  })
  main.on('close', event => {
    if (quitting) return
    if (preferences.closeToTray !== false) { event.preventDefault(); if (tray) main.hide(); else main.minimize() }
    else if (quitCheck) { event.preventDefault(); app.quit() }
  })
}
export function shouldStartMinimized() { return preferences.startMinimized === true }
export function notifyAccount(accountId: string, label: string, options?: { always?: boolean; silent?: boolean; hideNames?: boolean }) {
  if (!window || preferences.notifications === 'off' || (!options?.always && preferences.notifications !== 'always' && window.isFocused()) || !Notification.isSupported()) return
  const notification = new Notification({ title: t('HelloDog · 新消息'), icon: join(__dirname, '../../resources/brand/hellodog-icon.png'), body: preferences.hideNotificationNames || options?.hideNames ? t('有新的聊天消息') : label + t(' 有新消息'), silent: options?.silent ?? preferences.notificationSound !== true })
  notification.on('click', () => { window?.show(); window?.focus(); window?.webContents.send('ui:account-action', { action: 'focus', accountId }) })
  notification.show()
  if (!window.isFocused()) window.flashFrame(true)
}
