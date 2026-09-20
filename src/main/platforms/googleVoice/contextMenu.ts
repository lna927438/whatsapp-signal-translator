import { Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { t } from '../../uiLocale'

const voicePage = (value: string): boolean => {
  try {
    const url = new URL(value)
    return /^https:\/\/voice\.google\.com(?::443)?(?:[/?#]|$)/i.test(value) &&
      url.origin === 'https://voice.google.com' && !url.username && !url.password
  } catch { return false }
}

const imageSource = (value: string): boolean => {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'blob:') return url.origin === 'https://voice.google.com'
    return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;base64)?,/i.test(value)
  } catch { return false }
}

/** Native browser actions never target whichever account happens to gain focus.
 * The caller supplies live owner/registration authorization. This helper also
 * revokes a menu on navigation, including navigating away and back to one URL.
 */
export function installGoogleVoiceContextMenu(wc: WebContents, isCurrent: () => boolean): () => void {
  let disposed = false, epoch = 0
  const menus = new Set<Menu>()
  const closeMenus = () => {
    for (const menu of menus) { try { menu.closePopup() } catch { /* already closed */ } }
    menus.clear()
  }
  const invalidate = () => { epoch++; closeMenus() }
  const navigating = (event: Electron.Event & { isMainFrame?: boolean }, _url: string, _sameDocument: boolean, isMainFrame: boolean) => {
    if (event.isMainFrame ?? isMainFrame) invalidate()
  }
  const navigatedInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => { if (isMainFrame) invalidate() }
  const contextMenu = (_event: Electron.Event, params: ContextMenuParams) => {
    invalidate()
    let url: string, frame: Electron.WebFrameMain
    const menuEpoch = epoch
    try {
      if (disposed || wc.isDestroyed() || !isCurrent()) return
      url = wc.getURL(); frame = wc.mainFrame
      if (!voicePage(url) || frame.detached || params.frame !== frame || frame.url !== url || params.pageURL !== url) return
      if (params.frameURL && params.frameURL !== url) return
    } catch { return }
    const current = () => {
      try {
        return !disposed && epoch === menuEpoch && !wc.isDestroyed() && isCurrent() &&
          wc.getURL() === url && voicePage(wc.getURL()) && wc.mainFrame === frame && !frame.detached && frame.url === url
      } catch { return false }
    }
    const items: MenuItemConstructorOptions[] = []
    const add = (label: string, action: () => void | Promise<void>, enabled: boolean) => {
      items.push({ label: t(label), enabled, click: () => {
        if (!enabled || !current()) return
        try { void Promise.resolve(action()).catch(() => undefined) } catch { /* stale image/editor or closed download */ }
      } })
    }
    const separate = () => { if (items.length) items.push({ type: 'separator' }) }
    if (params.mediaType === 'image' || params.mediaType === 'canvas') {
      const x = params.x, y = params.y, src = params.srcURL
      add('复制图片', () => wc.copyImageAt(x, y), params.hasImageContents === true && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0)
      if (src && imageSource(src)) add('图片另存为…', () => wc.downloadURL(src), true)
    }
    if (params.isEditable) {
      separate()
      add('撤销', () => wc.undo(), params.editFlags.canUndo === true)
      add('重做', () => wc.redo(), params.editFlags.canRedo === true)
      separate()
      add('剪切', () => wc.cut(), params.editFlags.canCut === true)
      add('复制', () => wc.copy(), params.editFlags.canCopy === true)
      add('粘贴', () => wc.paste(), params.editFlags.canPaste === true)
      add('粘贴为纯文本', () => wc.pasteAndMatchStyle(), params.editFlags.canPaste === true)
      separate()
      add('全选', () => wc.selectAll(), params.editFlags.canSelectAll === true)
    } else if (params.selectionText) {
      separate(); add('复制所选文字', () => wc.copy(), params.editFlags.canCopy === true)
    }
    if (!items.length || !current()) return
    let menu: Menu | undefined
    try {
      menu = Menu.buildFromTemplate(items); menus.add(menu)
      menu.popup({ frame, callback: () => { if (menu) menus.delete(menu) } })
    } catch { if (menu) { menus.delete(menu); try { menu.closePopup() } catch { /* already closed */ } } }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true; invalidate()
    wc.removeListener('context-menu', contextMenu)
    wc.removeListener('did-start-navigation', navigating)
    wc.removeListener('did-navigate-in-page', navigatedInPage)
    wc.removeListener('render-process-gone', invalidate)
    wc.removeListener('destroyed', dispose)
  }
  wc.on('context-menu', contextMenu)
  wc.on('did-start-navigation', navigating)
  wc.on('did-navigate-in-page', navigatedInPage)
  wc.on('render-process-gone', invalidate)
  wc.once('destroyed', dispose)
  return dispose
}
