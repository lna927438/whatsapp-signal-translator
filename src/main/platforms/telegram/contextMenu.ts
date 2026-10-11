import { clipboard, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { t } from '../../uiLocale'
import { externalUrl } from '../../securityPolicy'
import { openExternalSafe } from '../../webSecurity'

const externalLink = (value: string) => Boolean(externalUrl(value))
const downloadable = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'blob:' && url.origin === 'https://web.telegram.org' || url.protocol === 'data:' && /^data:image\//i.test(value) } catch { return false } }

/** Browser actions target this account's contents, never the focused host window. */
export function telegramContextMenu(contents: WebContents, params: ContextMenuParams, onError?: () => void): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const run = (action: () => void | Promise<void>) => () => {
    if (contents.isDestroyed()) return
    try { void Promise.resolve(action()).catch(() => onError?.()) } catch { onError?.() }
  }
  const add = (label: string, action: () => void | Promise<void>, enabled = true) => items.push({ label: t(label), enabled, click: run(action) })
  const separate = () => { if (items.length && items.at(-1)?.type !== 'separator') items.push({ type: 'separator' }) }
  if (params.mediaType === 'image' || params.mediaType === 'canvas') {
    add('复制图片', () => contents.copyImageAt(params.x, params.y), params.hasImageContents)
    if (params.srcURL && downloadable(params.srcURL)) add('图片另存为…', () => contents.downloadURL(params.srcURL))
  } else if (['audio', 'video'].includes(params.mediaType) && downloadable(params.srcURL)) {
    add('媒体另存为…', () => contents.downloadURL(params.srcURL))
  }
  if (params.linkURL && externalLink(params.linkURL)) {
    separate()
    add('在浏览器中打开链接', () => openExternalSafe(params.linkURL))
    add('复制链接地址', () => clipboard.writeText(params.linkURL))
  }
  if (params.isEditable) {
    separate()
    add('撤销', () => contents.undo(), params.editFlags.canUndo)
    add('重做', () => contents.redo(), params.editFlags.canRedo)
    separate()
    add('剪切', () => contents.cut(), params.editFlags.canCut)
    add('复制', () => contents.copy(), params.editFlags.canCopy)
    add('粘贴', () => contents.paste(), params.editFlags.canPaste)
    add('粘贴为纯文本', () => contents.pasteAndMatchStyle(), params.editFlags.canPaste)
    separate()
    add('全选', () => contents.selectAll(), params.editFlags.canSelectAll)
  } else if (params.selectionText) {
    separate(); add('复制所选文字', () => contents.copy())
  }
  return items
}
