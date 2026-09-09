import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings, RuntimeSettings, TranslationRequest } from './types'
import { AccountManager } from './accounts/accountManager'
import { SettingsStore } from './storage/settingsStore'
import { ProfileStore } from './storage/profileStore'
import { AuthStore } from './storage/authStore'
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

type OnlineIdentity = { userId: string; email?: string; username?: string; accessToken?: string } | null

export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()
  const profile = new ProfileStore()
  const auth = new AuthStore()
  let onlineIdentity: OnlineIdentity = null

  const requireAuth = async () => {
    if (onlineIdentity?.userId) return { authenticated: true, source: 'supabase', user: onlineIdentity }
    const state = await auth.status()
    if (!state.authenticated) throw new Error('登录状态已失效，请重新登录。')
    return state
  }

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

  ipcMain.handle('auth:set-online-session', async (_e, identity: OnlineIdentity) => {
    onlineIdentity = identity?.userId ? identity : null
    translator.setOnlineAccessToken(onlineIdentity?.accessToken || null)
    if (onlineIdentity) {
      await profile.updateIdentity({ username: onlineIdentity.username, email: onlineIdentity.email })
    } else {
      whatsapp.hideAll()
    }
    return { authenticated: Boolean(onlineIdentity), source: 'supabase', user: onlineIdentity ? { ...onlineIdentity, accessToken: undefined } : null }
  })
  ipcMain.handle('auth:status', async () => onlineIdentity?.userId
    ? { authenticated: true, source: 'supabase', user: { ...onlineIdentity, accessToken: undefined } }
    : auth.status())
  ipcMain.handle('auth:register', async (_e, input: { username: string; email: string; password: string; remember?: boolean }) => {
    const result = await auth.register(input)
    await profile.updateIdentity({ username: result.user?.username, email: result.user?.email })
    return result
  })
  ipcMain.handle('auth:login', (_e, input: { identifier: string; password: string; remember?: boolean }) => auth.login(input))
  ipcMain.handle('auth:logout', async () => {
    onlineIdentity = null
    translator.setOnlineAccessToken(null)
    whatsapp.hideAll()
    return auth.logout()
  })
  ipcMain.handle('auth:reset-password', (_e, input: { identifier: string; recoveryCode: string; newPassword: string }) => auth.resetPassword(input))

  ipcMain.handle('accounts:list', async () => { await requireAuth(); return accounts.list() })
  ipcMain.handle('accounts:add', async (_e, args: { platform: 'whatsapp' | 'signal'; label?: string; signalAccount?: string }) => { await requireAuth(); return accounts.add(args.platform, args.label, args.signalAccount) })
  ipcMain.handle('accounts:update', async (_e, id: string, patch: any) => { await requireAuth(); return accounts.update(id, patch) })
  ipcMain.handle('accounts:set-contact-language', async (_e, accountId: string, conversationId: string, language: string, name?: string) => {
    await requireAuth()
    const updated = await accounts.updateContactLanguage(accountId, conversationId, language, name, 'manual')
    mainWindow.webContents.send('accounts:contact-language', { accountId, conversationId, language, name, source: 'manual' })
    return updated
  })
  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    await requireAuth()
    const all = await accounts.list()
    const item = all.find((account) => account.id === id)
    if (item?.platform === 'whatsapp') whatsapp.remove(id)
    await accounts.remove(id)
    return true
  })

  ipcMain.handle('profile:get', async () => { await requireAuth(); return profile.get() })
  ipcMain.handle('profile:update', async (_e, patch: { username?: string; email?: string; planName?: string }) => {
    await requireAuth()
    if (!onlineIdentity && (patch.username !== undefined || patch.email !== undefined)) await auth.updateIdentity({ username: patch.username, email: patch.email })
    return profile.updateIdentity(patch)
  })
  ipcMain.handle('profile:topup', async (_e, characters: number, note?: string) => { await requireAuth(); return profile.addCharacters(characters, note || '字符充值') })

  ipcMain.handle('platform:focus', async (_e, args: { platform: 'whatsapp' | 'signal'; accountId?: string }) => {
    await requireAuth()
    if (args.platform === 'whatsapp' && args.accountId) await whatsapp.focus(args.accountId)
    else whatsapp.hideAll()
    return true
  })
  ipcMain.handle('ui:set-overlay-open', async (_e, open: boolean) => { await requireAuth(); whatsapp.setOverlayOpen(Boolean(open)); return true })
  ipcMain.handle('whatsapp:send-native-enter', async (_e, accountId?: string) => { await requireAuth(); return whatsapp.sendNativeEnter(accountId) })
  ipcMain.handle('whatsapp:commit-translated-send', async (_e, accountId: string | undefined, text: string) => { await requireAuth(); return whatsapp.commitTranslatedSend(accountId, text) })

  ipcMain.on('whatsapp:conversation', (_e, accountId: string | undefined, info: { id?: string; name?: string }) => announceConversation(accountId, info?.id, info?.name))

  ipcMain.handle('settings:get', async () => { await requireAuth(); return settings.get() })
  ipcMain.handle('settings:save', async (_e, value) => { await requireAuth(); await settings.save(value); return true })
  ipcMain.handle('translator:get-runtime-settings', async (_e, accountId?: string, conversationId?: string) => { await requireAuth(); return accountRuntime(accountId, conversationId) })
  ipcMain.handle('translator:metrics', async () => { await requireAuth(); return translator.metrics() })
  ipcMain.handle('translator:languages', async () => { await requireAuth(); return languages })
  ipcMain.handle('translator:translate-incoming', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    await requireAuth()
    const payload = normalizePayload(raw)
    if (accountId && payload.conversationId) {
      const detected = detectContactLanguage(payload.text)
      if (detected) {
        const runtimeBefore = await accountRuntime(accountId, payload.conversationId)
        if (detected !== runtimeBefore.localLanguage) {
          await accounts.updateContactLanguage(accountId, payload.conversationId, detected, payload.conversationName, 'auto')
          mainWindow.webContents.send('accounts:contact-language', { accountId, conversationId: payload.conversationId, language: detected, name: payload.conversationName, source: 'auto' })
        }
      }
      announceConversation(accountId, payload.conversationId, payload.conversationName)
    }
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({ text: payload.text, sourceLanguage: 'auto', targetLanguage: current.localLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context })
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    await requireAuth()
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({ text: payload.text, sourceLanguage: current.localLanguage, targetLanguage: current.targetLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context })
  })
  ipcMain.handle('translator:test', async (_e, text: string, targetLanguage: string) => { await requireAuth(); return translator.translate({ text, sourceLanguage: 'auto', targetLanguage }) })
  ipcMain.handle('translator:test-config', async (_e, value: AppSettings, text: string, targetLanguage: string) => {
    await requireAuth()
    try { const translated = await translator.testWithSettings(value, { text, sourceLanguage: 'auto', targetLanguage }); return { ok: true, translated, message: '云端翻译连接和测试成功。' } }
    catch (error: any) { return { ok: false, message: String(error?.message || error) } }
  })

  ipcMain.handle('signal:runtime-status', async () => { await requireAuth(); return signal.runtimeStatus() })
  ipcMain.handle('signal:prepare-runtime', async () => { await requireAuth(); return signal.prepareRuntime() })
  ipcMain.handle('signal:list-accounts', async () => { await requireAuth(); return signal.listAccounts() })
  ipcMain.handle('signal:start-link', async () => { await requireAuth(); return signal.startLink() })
  ipcMain.handle('signal:finish-link', async (_e, uri: string, name?: string) => { await requireAuth(); return signal.finishLink(uri, name) })
  ipcMain.handle('signal:list-contacts', async (_e, account: string) => { await requireAuth(); return signal.listContacts(account) })
  ipcMain.handle('signal:send', async (_e, recordId: string, account: string, recipient: string, text: string) => { await requireAuth(); return signal.send(recordId, account, recipient, text) })

  ipcMain.on('translator:status', (_e, accountId: string | undefined, status: any) => mainWindow.webContents.send('translator:status', { accountId, state: status?.state || 'ready', message: status?.message || '翻译器已就绪', at: Number(status?.at || Date.now()) }))
  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
