import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopAPI', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (args: any) => ipcRenderer.invoke('accounts:add', args),
  updateAccount: (id: string, patch: any) => ipcRenderer.invoke('accounts:update', id, patch),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  focusPlatform: (args: any) => ipcRenderer.invoke('platform:focus', args),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value: any) => ipcRenderer.invoke('settings:save', value),
  getLanguages: () => ipcRenderer.invoke('translator:languages'),
  testTranslation: (text: string, target: string) => ipcRenderer.invoke('translator:test', text, target),
  signalListAccounts: () => ipcRenderer.invoke('signal:list-accounts'),
  signalStartLink: () => ipcRenderer.invoke('signal:start-link'),
  signalFinishLink: (uri: string, name?: string) => ipcRenderer.invoke('signal:finish-link', uri, name),
  signalListContacts: (account: string) => ipcRenderer.invoke('signal:list-contacts', account),
  signalSend: (account: string, recipient: string, text: string) => ipcRenderer.invoke('signal:send', account, recipient, text),
  onSignalMessage: (callback: (msg: any) => void) => { const fn = (_e: any, msg: any) => callback(msg); ipcRenderer.on('signal:message', fn); return () => ipcRenderer.removeListener('signal:message', fn) },
  onTranslatorError: (callback: (msg: string) => void) => { const fn = (_e: any, msg: string) => callback(msg); ipcRenderer.on('translator:error', fn); return () => ipcRenderer.removeListener('translator:error', fn) }
})
