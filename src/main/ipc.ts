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
import { JsonStore } from './storage/jsonStore'
import { SendTasks, SendNotStartedError, type SendTaskData } from './translation/sendTasks'

interface TranslatePayload {
  text: string
  conversationId?: string
  conversationName?: string
  messageId?: string
  requestId?: string
  context?: TranslationRequest['context']
}

type OnlineIdentity = { userId: string; email?: string; username?: string; accessToken?: string } | null

const CLOUD_API_BASE = 'https://realtime-translator-api.lna927438.workers.dev'

export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()
  const profile = new ProfileStore()
  const auth = new AuthStore()
  const sendTasks = new SendTasks(new JsonStore<SendTaskData>('outgoing-tasks-v1.json', { tasks: [] }, true))
  let onlineIdentity: OnlineIdentity = null
  let identityRevision = 0
  let identityWrites: Promise<unknown> = Promise.resolve()

  const taskIdentity = () => {
    const owner = onlineIdentity?.userId
    const revision = identityRevision
    if (!owner || !onlineIdentity?.accessToken) throw new Error('请先登录在线账号。')
    return { owner, authorized: () => onlineIdentity?.userId === owner && identityRevision === revision }
  }

  const assertTaskSender = (event: Electron.IpcMainInvokeEvent, task: { platform: string; accountId: string }) => {
    const expected = task.platform === 'whatsapp'
      ? whatsapp.ownsSender(task.accountId, event.sender.id)
      : event.sender.id === mainWindow.webContents.id
    if (!expected) throw new SendNotStartedError('发送窗口与任务账号不匹配。')
  }

  const requireAuth = async () => {
    if (onlineIdentity?.userId) return { authenticated: true, source: 'supabase', user: onlineIdentity }
    const state = await auth.status()
    if (!state.authenticated) throw new Error('登录状态已失效，请重新登录。')
    return state
  }

  const cloudRequest = async (path: string): Promise<any> => {
    const accessToken = String(onlineIdentity?.accessToken || '').trim()
    if (!accessToken) throw new Error('在线登录令牌缺失，请重新登录。')
    const response = await fetch(`${CLOUD_API_BASE}${path}`, {
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    const payload: any = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload?.message || `云端 API 请求失败 (${response.status})`))
    return payload
  }

  const cloudBackedProfile = async () => {
    const local = await profile.get()
    if (!onlineIdentity?.userId) return local
    const payload = await cloudRequest('/api/me')
    const wallet = payload?.wallet || {}
    const remoteProfile = payload?.profile || {}
    const remaining = Math.max(0, Number(wallet.balance || 0))
    const used = Math.max(0, Number(wallet.lifetime_debited || 0))
    const credited = Math.max(0, Number(wallet.lifetime_credited || 0))
    return {
      ...local,
      username: String(remoteProfile.username || onlineIdentity.username || local.username || ''),
      email: String(payload?.user?.email || remoteProfile.email || onlineIdentity.email || local.email || ''),
      planName: String(remoteProfile.plan_code || local.planName || 'free'),
      totalCharacters: Math.max(remaining + used, credited),
      usedCharacters: used,
      remainingCharacters: remaining,
      registeredAt: remoteProfile.created_at ? Date.parse(remoteProfile.created_at) : local.registeredAt,
      updatedAt: wallet.updated_at ? Date.parse(wallet.updated_at) : Date.now(),
      ledger: local.ledger
    }
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

  ipcMain.handle('auth:set-online-session', async (event, identity: OnlineIdentity) => {
    if (event.sender.id !== mainWindow.webContents.id) throw new Error('登录会话只能由主窗口更新。')
    const previous = onlineIdentity
    onlineIdentity = identity?.userId ? identity : null
    if (previous?.userId !== onlineIdentity?.userId) {
      identityRevision += 1
      whatsapp.resetViews()
      signal.setOnlineUser(onlineIdentity?.userId || '')
    }
    translator.setOnlineSession(onlineIdentity?.userId, onlineIdentity?.accessToken)
    if (onlineIdentity && (previous?.userId !== onlineIdentity.userId || previous?.username !== onlineIdentity.username || previous?.email !== onlineIdentity.email)) {
      const updated = { username: onlineIdentity.username, email: onlineIdentity.email }
      identityWrites = identityWrites.catch(() => {}).then(() => profile.updateIdentity(updated))
      await identityWrites
    }
    whatsapp.resumeTranslations()
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
    identityRevision += 1
    translator.setOnlineSession(null, null)
    whatsapp.resetViews()
    signal.setOnlineUser('')
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

  ipcMain.handle('profile:get', async () => { await requireAuth(); return cloudBackedProfile() })
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
  ipcMain.handle('send:prepare', async (event, input: { platform: 'whatsapp' | 'signal'; accountId: string; conversationId: string; targetKey?: string; signalAccount?: string; recipient?: string; text: string; context?: TranslationRequest['context'] }) => {
    const { owner, authorized } = taskIdentity()
    assertTaskSender(event, input)
    const record = (await accounts.list()).find(item => item.id === input.accountId && item.platform === input.platform)
    if (!record) throw new Error('发送账号不存在。')
    if (input.platform === 'signal' && (!input.signalAccount || record.signalAccount !== input.signalAccount || input.conversationId !== `signal:${input.recipient}`)) throw new Error('Signal 收件人或发送账号不匹配。')
    const runtime = await accountRuntime(input.accountId, input.conversationId)
    if (!authorized()) throw new Error('登录状态已变化。')
    return sendTasks.prepare(owner, { platform: input.platform, accountId: input.accountId,
      conversationId: input.conversationId, targetKey: input.targetKey, signalAccount: input.signalAccount, recipient: input.recipient,
      translate: runtime.sendAutoTranslate, blockChinese: runtime.blockChineseSend,
      request: { text: String(input.text || ''), accountId: input.accountId, conversationId: input.conversationId,
        sourceLanguage: runtime.localLanguage, targetLanguage: runtime.targetLanguage,
        context: input.platform === 'signal' ? signal.contextForTask(input.accountId, input.recipient || '') : input.context || [] } })
  })
  ipcMain.handle('send:translate', async (event, id: string) => {
    const { owner, authorized } = taskIdentity()
    assertTaskSender(event, await sendTasks.get(owner, id))
    const task = await sendTasks.translate(owner, id, request => translator.translate(request), authorized)
    mainWindow.webContents.send('translator:status', { accountId: task.accountId, state: 'working', message: '译文已确认，正在准备发送。', settled: true })
    return task
  })
  ipcMain.handle('send:submit', async (event, id: string) => {
    const { owner, authorized } = taskIdentity()
    const original = await sendTasks.get(owner, id)
    assertTaskSender(event, original)
    return sendTasks.submit(owner, id, async task => {
      try {
        const current = await cloudRequest('/api/me')
        if (current?.profile?.status !== 'active' || current?.user?.id !== owner || !authorized()) throw new Error('账号状态不可用或登录已变化，已阻止发送。')
      } catch (error: any) { throw new SendNotStartedError(String(error?.message || error)) }
      if (task.platform === 'whatsapp') return whatsapp.submitTask(task, authorized)
      return signal.submitTask(task, authorized)
    }, authorized)
  })
  ipcMain.handle('send:pending', async (event, accountId: string, conversationId: string, targetKey?: string) => {
    const { owner } = taskIdentity()
    const task = await sendTasks.pending(owner, accountId, conversationId, targetKey)
    if (task) assertTaskSender(event, task)
    return task
  })
  ipcMain.handle('send:confirm-not-sent', async (event, id: string) => {
    const { owner } = taskIdentity()
    assertTaskSender(event, await sendTasks.get(owner, id))
    return sendTasks.confirmNotSent(owner, id)
  })
  ipcMain.handle('send:cancel', async (event, id: string) => {
    const { owner } = taskIdentity()
    assertTaskSender(event, await sendTasks.get(owner, id))
    return sendTasks.cancel(owner, id)
  })
  ipcMain.handle('send:confirm-sent', async (event, id: string) => {
    const { owner } = taskIdentity()
    assertTaskSender(event, await sendTasks.get(owner, id))
    return sendTasks.confirmSent(owner, id)
  })

  ipcMain.on('whatsapp:conversation', (_e, accountId: string | undefined, info: { id?: string; name?: string }) => announceConversation(accountId, info?.id, info?.name))

  ipcMain.handle('settings:get', async () => {
    await requireAuth()
    const value = await settings.get()
    return value.provider === 'openai'
      ? { ...value, openaiApiKey: 'cloud-managed', openaiModel: 'gpt-5.6-luna' }
      : value
  })
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
    return translator.translate({ text: payload.text, requestId: payload.requestId, sourceLanguage: 'auto', targetLanguage: current.localLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context })
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    await requireAuth()
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({ text: payload.text, requestId: payload.requestId, sourceLanguage: current.localLanguage, targetLanguage: current.targetLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context })
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

  ipcMain.on('translator:status', (_e, accountId: string | undefined, status: any) => mainWindow.webContents.send('translator:status', { accountId, state: status?.state || 'ready', message: status?.message || '翻译器已就绪', at: Number(status?.at || Date.now()) }))
  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
