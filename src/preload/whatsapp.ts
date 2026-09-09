import { contextBridge, ipcRenderer } from 'electron'

const accountArg = process.argv.find((value) => value.startsWith('--rt-account-id='))
const accountId = accountArg?.slice('--rt-account-id='.length)

contextBridge.exposeInMainWorld('realtimeTranslator', {
  getRuntimeSettings: (conversationId?: string) => ipcRenderer.invoke('translator:get-runtime-settings', accountId, conversationId),
  translateIncoming: (payload: any) => ipcRenderer.invoke('translator:translate-incoming', accountId, payload),
  translateOutgoing: (payload: any) => ipcRenderer.invoke('translator:translate-outgoing', accountId, payload),
  reportConversation: (info: any) => ipcRenderer.send('whatsapp:conversation', accountId, info),
  sendNativeEnter: () => ipcRenderer.invoke('whatsapp:send-native-enter', accountId),
  commitTranslatedSend: (text: string) => ipcRenderer.invoke('whatsapp:commit-translated-send', accountId, text),
  reportStatus: (status: any) => ipcRenderer.send('translator:status', accountId, status),
  notifyError: (message: string) => ipcRenderer.send('translator:error', message)
})
