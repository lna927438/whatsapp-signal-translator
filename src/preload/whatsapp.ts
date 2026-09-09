import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('realtimeTranslator', {
  getRuntimeSettings: () => ipcRenderer.invoke('translator:get-runtime-settings'),
  translateIncoming: (text: string) => ipcRenderer.invoke('translator:translate-incoming', text),
  translateOutgoing: (text: string) => ipcRenderer.invoke('translator:translate-outgoing', text),
  notifyError: (message: string) => ipcRenderer.send('translator:error', message)
})
