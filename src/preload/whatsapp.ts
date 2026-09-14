import { contextBridge, ipcRenderer } from 'electron'
import { installSendBootstrapGuard } from './sendBootstrapGuard'

let sendGuardReady = false
ipcRenderer.on('translator:send-guard-ready', () => { sendGuardReady = true })
installSendBootstrapGuard(() => sendGuardReady, () => ipcRenderer.send('translator:error', '翻译保护正在准备中，已阻止发送。请稍后重试，原文仍在输入框中。'))

const accountArg = process.argv.find((value) => value.startsWith('--rt-account-id='))
const accountId = accountArg?.slice('--rt-account-id='.length)

contextBridge.exposeInMainWorld('realtimeTranslator', {
  getContactNote: (peer: string) => ipcRenderer.invoke('whatsapp:contact-note', accountId, peer),
  saveContactNote: (peer: string, text: string, revision: number) => ipcRenderer.invoke('whatsapp:save-contact-note', accountId, peer, text, revision),
  getDraft: (target: any) => ipcRenderer.invoke('draft:get', { ...target, accountId }),
  saveDraft: (target: any, text: string) => ipcRenderer.invoke('draft:save', { ...target, accountId }, text),
  editComposer: (value: any) => ipcRenderer.invoke('whatsapp:edit-composer', accountId, value),
  reportConnection: (state: string) => ipcRenderer.send('whatsapp:connection', accountId, state),
  getRuntimeSettings: (conversationId?: string) => ipcRenderer.invoke('translator:get-runtime-settings', accountId, conversationId),
  cachedIncoming: (payload: any) => ipcRenderer.invoke('translator:cached-incoming', accountId, payload),
  translateIncoming: (payload: any) => ipcRenderer.invoke('translator:translate-incoming', accountId, payload),
  translateOutgoing: (payload: any) => ipcRenderer.invoke('translator:translate-outgoing', accountId, payload),
  reportUnread: (count: number) => ipcRenderer.send('whatsapp:unread', accountId, count),
  reportConversation: (info: any) => ipcRenderer.send('whatsapp:conversation', accountId, info),
  prepareSend: (payload: any) => ipcRenderer.invoke('send:prepare', { ...payload, platform: 'whatsapp', accountId }),
  prepareQueuedSend: (payload: any) => ipcRenderer.invoke('send:prepare', { ...payload, platform: 'whatsapp', accountId }),
  pendingSends: () => ipcRenderer.invoke('send:pending-list', accountId),
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
