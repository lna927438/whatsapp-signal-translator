import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { AccountManager } from './accounts/accountManager'
import { SettingsStore } from './storage/settingsStore'
import { TranslationEngine } from './translation/translationEngine'
import { languages } from './translation/languages'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'

export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()

  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:add', async (_e, args: { platform: 'whatsapp' | 'signal'; label?: string; signalAccount?: string }) => accounts.add(args.platform, args.label, args.signalAccount))
  ipcMain.handle('accounts:update', async (_e, id: string, patch: any) => accounts.update(id, patch))
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    const all = await accounts.list(); const item = all.find((a) => a.id === id)
    if (item?.platform === 'whatsapp') whatsapp.remove(id)
    await accounts.remove(id)
    return true
  })

  ipcMain.handle('platform:focus', async (_e, args: { platform: 'whatsapp' | 'signal'; accountId?: string }) => {
    if (args.platform === 'whatsapp' && args.accountId) await whatsapp.focus(args.accountId)
    else whatsapp.hideAll()
    return true
  })

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', async (_e, value) => { await settings.save(value); return true })
  ipcMain.handle('translator:get-runtime-settings', () => settings.runtime())
  ipcMain.handle('translator:languages', () => languages)
  ipcMain.handle('translator:translate-incoming', async (_e, text: string) => {
    const s = await settings.get()
    return translator.translate({ text, sourceLanguage: 'auto', targetLanguage: s.localLanguage })
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, text: string) => {
    const s = await settings.get()
    return translator.translate({ text, sourceLanguage: s.localLanguage, targetLanguage: s.targetLanguage })
  })
  ipcMain.handle('translator:test', async (_e, text: string, targetLanguage: string) => translator.translate({ text, sourceLanguage: 'auto', targetLanguage }))

  ipcMain.handle('signal:list-accounts', () => signal.listAccounts())
  ipcMain.handle('signal:start-link', () => signal.startLink())
  ipcMain.handle('signal:finish-link', (_e, uri: string, name?: string) => signal.finishLink(uri, name))
  ipcMain.handle('signal:list-contacts', (_e, account: string) => signal.listContacts(account))
  ipcMain.handle('signal:send', (_e, account: string, recipient: string, text: string) => signal.send(account, recipient, text))

  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
