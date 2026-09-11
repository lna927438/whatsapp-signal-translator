import { contextBridge, ipcRenderer } from 'electron'

const accountArg = process.argv.find((value) => value.startsWith('--rt-account-id='))
const accountId = accountArg?.slice('--rt-account-id='.length)

contextBridge.exposeInMainWorld('realtimeTranslator', {
  getRuntimeSettings: (conversationId?: string) => ipcRenderer.invoke('translator:get-runtime-settings', accountId, conversationId),
  cachedIncoming: (payload: any) => ipcRenderer.invoke('translator:cached-incoming', accountId, payload),
  translateIncoming: (payload: any) => ipcRenderer.invoke('translator:translate-incoming', accountId, payload),
  translateOutgoing: (payload: any) => ipcRenderer.invoke('translator:translate-outgoing', accountId, payload),
  reportUnread: (count: number) => ipcRenderer.send('whatsapp:unread', accountId, count),
  reportConversation: (info: any) => ipcRenderer.send('whatsapp:conversation', accountId, info),
  prepareSend: (payload: any) => ipcRenderer.invoke('send:prepare', { ...payload, platform: 'whatsapp', accountId }),
  editSendPreview: (id: string, text: string) => ipcRenderer.invoke('send:edit-preview', id, text),
  backTranslateSend: (id: string, text: string) => ipcRenderer.invoke('send:back-translate', id, text),
  translateSend: (id: string) => ipcRenderer.invoke('send:translate', id),
  submitSend: (id: string) => ipcRenderer.invoke('send:submit', id),
  pendingSend: (conversationId: string, targetKey: string) => ipcRenderer.invoke('send:pending', accountId, conversationId, targetKey),
  confirmNotSent: (id: string) => ipcRenderer.invoke('send:confirm-not-sent', id),
  cancelSend: (id: string) => ipcRenderer.invoke('send:cancel', id),
  confirmSent: (id: string) => ipcRenderer.invoke('send:confirm-sent', id),
  reportStatus: (status: any) => ipcRenderer.send('translator:status', accountId, status),
  notifyError: (message: string) => ipcRenderer.send('translator:error', message)
})
