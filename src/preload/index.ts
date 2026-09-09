import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopAPI', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (args: any) => ipcRenderer.invoke('accounts:add', args),
  updateAccount: (id: string, patch: any) => ipcRenderer.invoke('accounts:update', id, patch),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  focusPlatform: (args: any) => ipcRenderer.invoke('platform:focus', args),
  setOverlayOpen: (open: boolean) => ipcRenderer.invoke('ui:set-overlay-open', open),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value: any) => ipcRenderer.invoke('settings:save', value),
  getLanguages: () => ipcRenderer.invoke('translator:languages'),
  testTranslation: (text: string, target: string) => ipcRenderer.invoke('translator:test', text, target),
  testTranslationConfig: (settings: any, text: string, target: string) => ipcRenderer.invoke('translator:test-config', settings, text, target),
  signalRuntimeStatus: () => ipcRenderer.invoke('signal:runtime-status'),
  signalPrepareRuntime: () => ipcRenderer.invoke('signal:prepare-runtime'),
  signalListAccounts: () => ipcRenderer.invoke('signal:list-accounts'),
  signalStartLink: () => ipcRenderer.invoke('signal:start-link'),
  signalFinishLink: (uri: string, name?: string) => ipcRenderer.invoke('signal:finish-link', uri, name),
  signalListContacts: (account: string) => ipcRenderer.invoke('signal:list-contacts', account),
  signalSend: (recordId: string, account: string, recipient: string, text: string) => ipcRenderer.invoke('signal:send', recordId, account, recipient, text),
  onSignalRuntime: (callback: (status: any) => void) => {
    const fn = (_e: any, status: any) => callback(status)
    ipcRenderer.on('signal:runtime', fn)
    return () => ipcRenderer.removeListener('signal:runtime', fn)
  },
  onSignalDiagnostic: (callback: (message: string) => void) => {
    const fn = (_e: any, message: string) => callback(message)
    ipcRenderer.on('signal:diagnostic', fn)
    return () => ipcRenderer.removeListener('signal:diagnostic', fn)
  },
  onSignalMessage: (callback: (msg: any) => void) => {
    const fn = (_e: any, msg: any) => callback(msg)
    ipcRenderer.on('signal:message', fn)
    return () => ipcRenderer.removeListener('signal:message', fn)
  },
  onTranslatorStatus: (callback: (status: any) => void) => {
    const fn = (_e: any, status: any) => callback(status)
    ipcRenderer.on('translator:status', fn)
    return () => ipcRenderer.removeListener('translator:status', fn)
  },
  onTranslatorError: (callback: (msg: string) => void) => {
    const fn = (_e: any, msg: string) => callback(msg)
    ipcRenderer.on('translator:error', fn)
    return () => ipcRenderer.removeListener('translator:error', fn)
  }
})
