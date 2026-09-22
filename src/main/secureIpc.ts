import { app, type BrowserWindow, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { isAppUrl, isWhatsAppUrl, mainFrame } from './securityPolicy'

type Event = IpcMainEvent | IpcMainInvokeEvent
const accountFirst = new Set(['translator:get-runtime-settings','translator:cached-incoming','translator:translate-incoming',
  'translator:translate-outgoing','send:pending','send:pending-list','whatsapp:edit-composer','whatsapp:unread',
  'whatsapp:conversation','whatsapp:connection','translator:status'])
const taskChannels = new Set(['send:edit-preview','send:back-translate','send:translate','send:submit','send:confirm-not-sent','send:cancel','send:confirm-sent'])
accountFirst.add('voice:recognize')

export function createSecureIpc(raw: IpcMain, window: BrowserWindow, whatsapp: { ownsSender(id: string, sender: number): boolean }) {
  function authorize(event: Event, channel: string, args: unknown[]) {
    if (!mainFrame(event)) throw new Error('已阻止不受信任页面的操作。')
    const url = event.senderFrame?.url || ''
    if (event.sender.id === window.webContents.id && isAppUrl(url, join(__dirname, '../renderer'), !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined)) return
    if (!isWhatsAppUrl(url)) throw new Error('已阻止不受信任页面的操作。')
    if (accountFirst.has(channel)) {
      if (typeof args[0] === 'string' && whatsapp.ownsSender(args[0], event.sender.id)) return
    } else if (['draft:get','draft:save','send:prepare'].includes(channel)) {
      const payload = args[0] as { accountId?: unknown; platform?: unknown } | undefined
      if (typeof payload?.accountId === 'string' && whatsapp.ownsSender(payload.accountId, event.sender.id) &&
        (channel !== 'send:prepare' || payload.platform === 'whatsapp')) return
    } else if (taskChannels.has(channel) && typeof args[0] === 'string' && args[0].length <= 160) {
      // The task handlers must additionally check the stored task's account owner.
      return
    } else if (channel === 'translator:error' && typeof args[0] === 'string' && args[0].length <= 1000) return
    throw new Error('此操作不属于当前账号窗口。')
  }
  return {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) {
      raw.handle(channel, (event, ...args) => { authorize(event, channel, args); return listener(event, ...args) })
    },
    on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) {
      raw.on(channel, (event, ...args) => { try { authorize(event, channel, args); listener(event, ...args) } catch { /* One-way untrusted messages are discarded. */ } })
    }
  }
}
