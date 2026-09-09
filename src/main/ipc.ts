import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings, RuntimeSettings, TranslationRequest } from './types'
import { AccountManager } from './accounts/accountManager'
import { SettingsStore } from './storage/settingsStore'
import { ProfileStore } from './storage/profileStore'
import { TranslationEngine } from './translation/translationEngine'
import { detectContactLanguage } from './translation/languageDetection'
import { languages } from './translation/languages'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'

interface TranslatePayload {
  text: string
  conversationId?: string
  conversationName?: string
  messageId?: string
  context?: TranslationRequest['context']
}

export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()
  const profile = new ProfileStore()

  const accountRuntime = async (accountId?: string, conversationId?: string): Promise<RuntimeSettings> => {
    const base = await settings.runtime()
    if (!accountId) return base
    const all = await accounts.list()
    const account = all.find((item) => item.id === accountId)
    if (!account) return base
    const contact = conversationId ? account.contactLanguages?.[conversationId] : undefined
    return {
      ...base,
      localLanguage: account.localLanguage || base.localLanguage,
      targetLanguage: contact?.language || account.targetLanguage || base.targetLanguage,
      receiveAutoTranslate: account.receiveAutoTranslate ?? base.receiveAutoTranslate,
      sendAutoTranslate: account.sendAutoTranslate ?? base.sendAutoTranslate,
      blockChineseSend: account.blockChineseSend ?? base.blockChineseSend,
      groupTranslate: account.groupTranslate ?? base.groupTranslate,
      fontSize: Number(account.fontSize || base.fontSize || 13),
      translationColor: account.translationColor || base.translationColor || '#c8d4e4',
      conversationId,
      conversationName: contact?.name,
      contactLanguageSource: contact?.source || 'default'
    }
  }

  const normalizePayload = (value: string | TranslatePayload): TranslatePayload =>
    typeof value === 'string' ? { text: value } : { ...value, text: String(value?.text || '') }

  const announceConversation = (accountId: string | undefined, conversationId?: string, conversationName?: string) => {
    if (!accountId || !conversationId) return
    mainWindow.webContents.send('whatsapp:conversation', { accountId, conversationId, conversationName })
  }

  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:add', async (_e, args: { platform: 'whatsapp' | 'signal'; label?: string; signalAccount?: string }) => accounts.add(args.platform, args.label, args.signalAccount))
  ipcMain.handle('accounts:update', async (_e, id: string, patch: any) => accounts.update(id, patch))
  ipcMain.handle('accounts:set-contact-language', async (_e, accountId: string, conversationId: string, language: string, name?: string) => {
    const updated = await accounts.updateContactLanguage(accountId, conversationId, language, name, 'manual')
    mainWindow.webContents.send('accounts:contact-language', { accountId, conversationId, language, name, source: 'manual' })
    return updated
  })
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    const all = await accounts.list()
    const item = all.find((account) => account.id === id)
    if (item?.platform === 'whatsapp') whatsapp.remove(id)
    await accounts.remove(id)
    return true
  })

  ipcMain.handle('profile:get', () => profile.get())
  ipcMain.handle('profile:update', async (_e, patch: { username?: string; email?: string; planName?: string }) => profile.updateIdentity(patch))
  ipcMain.handle('profile:topup', async (_e, characters: number, note?: string) => profile.addCharacters(characters, note || '字符充值'))

  ipcMain.handle('platform:focus', async (_e, args: { platform: 'whatsapp' | 'signal'; accountId?: string }) => {
    if (args.platform === 'whatsapp' && args.accountId) await whatsapp.focus(args.accountId)
    else whatsapp.hideAll()
    return true
  })
  ipcMain.handle('ui:set-overlay-open', (_e, open: boolean) => {
    whatsapp.setOverlayOpen(Boolean(open))
    return true
  })
  ipcMain.handle('whatsapp:send-native-enter', (_e, accountId?: string) => whatsapp.sendNativeEnter(accountId))
  ipcMain.handle('whatsapp:commit-translated-send', (_e, accountId: string | undefined, text: string) => whatsapp.commitTranslatedSend(accountId, text))

  ipcMain.on('whatsapp:conversation', (_e, accountId: string | undefined, info: { id?: string; name?: string }) => {
    announceConversation(accountId, info?.id, info?.name)
  })

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', async (_e, value) => {
    await settings.save(value)
    return true
  })
  ipcMain.handle('translator:get-runtime-settings', (_e, accountId?: string, conversationId?: string) => accountRuntime(accountId, conversationId))
  ipcMain.handle('translator:metrics', () => translator.metrics())
  ipcMain.handle('translator:languages', () => languages)
  ipcMain.handle('translator:translate-incoming', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    const payload = normalizePayload(raw)
    if (accountId && payload.conversationId) {
      const detected = detectContactLanguage(payload.text)
      if (detected) {
        const runtimeBefore = await accountRuntime(accountId, payload.conversationId)
        if (detected !== runtimeBefore.localLanguage) {
          await accounts.updateContactLanguage(accountId, payload.conversationId, detected, payload.conversationName, 'auto')
          mainWindow.webContents.send('accounts:contact-language', {
            accountId,
            conversationId: payload.conversationId,
            language: detected,
            name: payload.conversationName,
            source: 'auto'
          })
        }
      }
      announceConversation(accountId, payload.conversationId, payload.conversationName)
    }
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({
      text: payload.text,
      sourceLanguage: 'auto',
      targetLanguage: current.localLanguage,
      accountId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      context: payload.context
    })
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({
      text: payload.text,
      sourceLanguage: current.localLanguage,
      targetLanguage: current.targetLanguage,
      accountId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      context: payload.context
    })
  })
  ipcMain.handle('translator:test', async (_e, text: string, targetLanguage: string) => translator.translate({ text, sourceLanguage: 'auto', targetLanguage }))
  ipcMain.handle('translator:test-config', async (_e, value: AppSettings, text: string, targetLanguage: string) => {
    try {
      const translated = await translator.testWithSettings(value, { text, sourceLanguage: 'auto', targetLanguage })
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

  ipcMain.on('translator:status', (_e, accountId: string | undefined, status: any) => {
    mainWindow.webContents.send('translator:status', {
      accountId,
      state: status?.state || 'ready',
      message: status?.message || '翻译器已就绪',
      at: Number(status?.at || Date.now())
    })
  })
  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
