import { app, BrowserWindow, dialog, shell, desktopCapturer, type WebContents, type Session } from 'electron'
import { join } from 'path'
import { externalUrl, isAppUrl, isWhatsAppUrl, isTelegramUrl, isTelegramOrigin } from './securityPolicy'

export async function openExternalSafe(value: string): Promise<void> {
  const url = externalUrl(value)
  if (!url) throw new Error('此链接类型无法安全打开。')
  await shell.openExternal(url)
}
const sessions = new WeakSet<Session>()
const knownContents = new WeakMap<WebContents, 'app' | 'whatsapp' | 'telegram'>()
const grants = new WeakMap<WebContents, Set<string>>()
const documents = new WeakMap<WebContents, object>()
function trusted(contents: WebContents | null, origin?: string): boolean {
  if (!contents || contents.isDestroyed()) return false
  const kind = knownContents.get(contents)
  if (kind === 'whatsapp') return isWhatsAppUrl(contents.getURL()) && (!origin || isWhatsAppUrl(origin))
  if (kind === 'telegram') return isTelegramUrl(contents.getURL()) && (!origin || isTelegramOrigin(origin))
  return kind === 'app' && isAppUrl(contents.getURL(), join(__dirname, '../renderer'), !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined) &&
    (!origin || origin === 'file://' || origin === 'file:' || isAppUrl(origin, join(__dirname, '../renderer'), !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined))
}
export function installWebSecurity(contents: WebContents, kind: 'app' | 'whatsapp' | 'telegram'): void {
  if (knownContents.has(contents)) return
  knownContents.set(contents, kind)
  documents.set(contents, {})
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { grants.delete(contents); documents.set(contents, {}) }
  })
  contents.once('destroyed', () => { grants.delete(contents); documents.delete(contents) })
  contents.setWindowOpenHandler(({ url }) => { void openExternalSafe(url).catch(() => undefined); return { action: 'deny' } })
  const allowed = (url: string) => kind === 'telegram' ? isTelegramUrl(url) : kind === 'whatsapp' ? isWhatsAppUrl(url) : isAppUrl(url, join(__dirname, '../renderer'), !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined)
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url, _inPlace, isMain) => { if (isMain && !allowed(url)) event.preventDefault() })
  contents.on('will-attach-webview', event => event.preventDefault())
  const session = contents.session
  if (sessions.has(session)) return
  sessions.add(session)
  session.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (!wc || !trusted(wc, origin) || details.isMainFrame === false) return false
    if (permission === 'clipboard-sanitized-write') return true
    // A microphone grant must never authorize a later camera request.
    const key = permission === 'media' ? 'media:' + details.mediaType : permission
    return Boolean(grants.get(wc)?.has(key))
  })
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!trusted(wc, details.requestingUrl) || details.isMainFrame === false) { callback(false); return }
    if (permission === 'clipboard-sanitized-write') { callback(true); return }
    if (!['media','display-capture'].includes(permission)) { callback(false); return }
    const requestingUrl = wc.getURL()
    const document = documents.get(wc)
    const types = (('mediaTypes' in details ? details.mediaTypes : []) || []).filter(type => type === 'audio' || type === 'video')
    if (permission === 'media' && !types.length) { callback(false); return }
    const purpose = permission === 'display-capture' ? '共享屏幕' : types.includes('video') ? (types.includes('audio') ? '使用摄像头和麦克风' : '使用摄像头') : '使用麦克风'
    const options = { type: 'question' as const, title: 'HelloDog · 通话权限', message: `允许当前聊天${purpose}？`, detail: '仅允许你信任的通话。关闭账号窗口后，需要重新授权。', buttons: ['不允许','允许'], defaultId: 0, cancelId: 0, noLink: true }
    const parent = BrowserWindow.fromWebContents(wc)
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(result => {
      const ok = result.response === 1 && !wc.isDestroyed() && documents.get(wc) === document && wc.getURL() === requestingUrl && trusted(wc)
      if (ok) {
        const selected = grants.get(wc) || new Set<string>()
        for (const key of permission === 'media' ? types.map(type => 'media:' + type) : [permission]) selected.add(key)
        grants.set(wc, selected)
      }
      callback(ok)
    }).catch(() => callback(false))
  })
  session.setDisplayMediaRequestHandler((request, callback) => {
    const wc = request.frame ? WebContentsForFrame(request.frame) : null
    if (!wc || request.frame !== wc.mainFrame || !trusted(wc, request.securityOrigin) || !request.userGesture) { callback({}); return }
    const document = documents.get(wc)
    void desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: { width: 0, height: 0 } }).then(async sources => {
      const choices = sources.slice(0, 12)
      const result = await dialog.showMessageBox({ type: 'question', title: '选择共享内容', message: '只会共享你选择的屏幕或窗口。', buttons: ['取消', ...choices.map(s => s.name)], defaultId: 0, cancelId: 0, noLink: true })
      const selected = choices[result.response - 1]
      callback(selected && documents.get(wc) === document && trusted(wc, request.securityOrigin) ? { video: selected } : {})
    }).catch(() => callback({}))
  }, { useSystemPicker: true })
  session.on('will-download', (_event, item, wc) => {
    if (!trusted(wc)) { item.cancel(); return }
    const filename = item.getFilename().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'attachment'
    item.setSaveDialogOptions({ title: '保存聊天附件', defaultPath: join(app.getPath('downloads'), filename) })
  })
}
// Electron resolves a capture request back to its owning contents without trusting URL text alone.
import { webContents } from 'electron'
function WebContentsForFrame(frame: Electron.WebFrameMain) { return webContents.fromFrame(frame) }
