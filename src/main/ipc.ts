import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings, RuntimeSettings } from './types'
import { AccountManager } from './accounts/accountManager'
import { SettingsStore } from './storage/settingsStore'
import { TranslationEngine } from './translation/translationEngine'
import { languages } from './translation/languages'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'

export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()

  const accountRuntime = async (accountId?: string): Promise<RuntimeSettings> => {
    const base = await settings.runtime()
    if (!accountId) return base
    const all = await accounts.list()
    const account = all.find((item) => item.id === accountId)
    if (!account) return base
    return {
      ...base,
      localLanguage: account.localLanguage || base.localLanguage,
      targetLanguage: account.targetLanguage || base.targetLanguage,
      receiveAutoTranslate: account.receiveAutoTranslate ?? base.receiveAutoTranslate,
      sendAutoTranslate: account.sendAutoTranslate ?? base.sendAutoTranslate,
      blockChineseSend: account.blockChineseSend ?? base.blockChineseSend,
      groupTranslate: account.groupTranslate ?? base.groupTranslate,
      fontSize: Number(account.fontSize || base.fontSize || 13),
      translationColor: account.translationColor || base.translationColor || '#c8d4e4'
    }
  }

  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:add', async (_e, args: { platform: 'whatsapp' | 'signal'; label?: string; signalAccount?: string }) => accounts.add(args.platform, args.label, args.signalAccount))
  ipcMain.handle('accounts:update', async (_e, id: string, patch: any) => accounts.update(id, patch))
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    const all = await accounts.list()
    const item = all.find((account) => account.id === id)
    if (item?.platform === 'whatsapp') whatsapp.remove(id)
    await accounts.remove(id)
    return true
  })

  ipcMain.handle('platform:focus', async (_e, args: { platform: 'whatsapp' | 'signal'; accountId?: string }) => {
    if (args.platform === 'whatsapp' && args.accountId) await whatsapp.focus(args.accountId)
    else whatsapp.hideAll()
    return true
  })
  ipcMain.handle('ui:set-overlay-open', (_e, open: boolean) => {
    whatsapp.setOverlayOpen(Boolean(open))
    return true
  })

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', async (_e, value) => {
    await settings.save(value)
    return true
  })
  ipcMain.handle('translator:get-runtime-settings', (_e, accountId?: string) => accountRuntime(accountId))
  ipcMain.handle('translator:languages', () => languages)
  ipcMain.handle('translator:translate-incoming', async (_e, accountId: string | undefined, text: string) => {
    const current = await accountRuntime(accountId)
    return translator.translate({ text, sourceLanguage: 'auto', targetLanguage: current.localLanguage })
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, accountId: string | undefined, text: string) => {
    const current = await accountRuntime(accountId)
    return translator.translate({ text, sourceLanguage: current.localLanguage, targetLanguage: current.targetLanguage })
  })
  ipcMain.handle('translator:test', async (_e, text: string, targetLanguage: string) => translator.translate({ text, sourceLanguage: 'auto', targetLanguage }))
  ipcMain.handle('translator:test-config', async (_e, value: AppSettings, text: string, targetLanguage: string) => {
    try {
      const translated = await translator.testWithSettings(value, {
        text,
        sourceLanguage: 'auto',
        targetLanguage
      })
      return { ok: true, translated, message: 'API 连接和翻译测试成功。' }
    } catch (error: any) {
      return { ok: false, message: String(error?.message || error) }
    }
  })

  ipcMain.handle('signal:runtime-status', () => signal.runtimeStatus())
  ipcMain.handle('signal:prepare-runtime', () => signal.prepareRuntime())
  ipcMain.handle('signal:list-accounts', () => signal.listAccounts())
  ipcMain.handle('signal:start-link', () => signal.startLink())
  ipcMain.handle('signal:finish-link', (_e, uri: string, name?: string) => signal.finishLink(uri, name))
  ipcMain.handle('signal:list-contacts', (_e, account: string) => signal.listContacts(account))
  ipcMain.handle('signal:send', (_e, recordId: string, account: string, recipient: string, text: string) => signal.send(recordId, account, recipient, text))

  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
