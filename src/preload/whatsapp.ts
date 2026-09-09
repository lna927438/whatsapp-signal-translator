import { contextBridge, ipcRenderer } from 'electron'

const accountArg = process.argv.find((value) => value.startsWith('--rt-account-id='))
const accountId = accountArg?.slice('--rt-account-id='.length)

contextBridge.exposeInMainWorld('realtimeTranslator', {
  getRuntimeSettings: () => ipcRenderer.invoke('translator:get-runtime-settings', accountId),
  translateIncoming: (text: string) => ipcRenderer.invoke('translator:translate-incoming', accountId, text),
  translateOutgoing: (text: string) => ipcRenderer.invoke('translator:translate-outgoing', accountId, text),
  sendNativeEnter: () => ipcRenderer.invoke('whatsapp:send-native-enter', accountId),
  commitTranslatedSend: (text: string) => ipcRenderer.invoke('whatsapp:commit-translated-send', accountId, text),
  notifyError: (message: string) => ipcRenderer.send('translator:error', message)
})
