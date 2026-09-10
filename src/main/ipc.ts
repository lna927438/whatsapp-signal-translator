import { ipcMain, app, Menu, clipboard, dialog, shell } from 'electron'
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
import { cloudRead, measureCloudRoutes, setCloudRoute } from './network/cloudConnection'

interface TranslatePayload {
  text: string
  conversationId?: string
  conversationName?: string
  messageId?: string
  requestId?: string
  context?: TranslationRequest['context']
}

type OnlineIdentity = { userId: string; email?: string; username?: string; accessToken?: string } | null


export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const accounts = new AccountManager()
  const settings = new SettingsStore()
  const profile = new ProfileStore()
  const auth = new AuthStore()
  const sendTasks = new SendTasks(new JsonStore<SendTaskData>('outgoing-tasks-v1.json', { tasks: [] }, true))
  let onlineIdentity: OnlineIdentity = null
  let identityRevision = 0
  let identityWrites: Promise<unknown> = Promise.resolve()
  void settings.get().then(value => setCloudRoute(value.cloudRoute))
  const requireMain = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender.id !== mainWindow.webContents.id) throw new Error('此操作只能从 HelloDog 主窗口执行。')
  }

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
    return cloudRead(path, accessToken)
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
      translationsVisible: account.translationsVisible !== false,
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
  whatsapp.setPasswordReader(id => accounts.proxyPassword(id))
  ipcMain.handle('accounts:add', async (event, args: any) => {
    requireMain(event); await requireAuth()
    if (!['whatsapp', 'signal'].includes(args.platform)) throw new Error('不支持的应用类型。')
    if (args.platform === 'signal' && args.options?.proxy?.enabled) throw new Error('Signal 独立代理暂不支持。')
    return accounts.add(args.platform, args.label, args.signalAccount, args.options)
  })
  ipcMain.handle('accounts:test-proxy', async (event, input: any, id?: string) => {
    requireMain(event); await requireAuth()
    const password = input.password || (id && !input.clearPassword ? await accounts.proxyPassword(id) : '')
    return whatsapp.testProxy(input, password)
  })
  ipcMain.handle('accounts:update', async (event, id: string, patch: any) => {
    requireMain(event); await requireAuth()
    const existing = (await accounts.list()).find(item => item.id === id)
    if (existing?.platform === 'signal' && patch.proxy?.enabled) throw new Error('Signal 独立代理暂不支持。')
    const updated = await accounts.update(id, patch)
    if (patch.proxy !== undefined) whatsapp.remove(id)
    if (updated?.platform === 'whatsapp') await whatsapp.applyPreferences(id, updated)
    return updated
  })
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
    if (args.platform === 'whatsapp' && args.accountId) {
      const account = (await accounts.list()).find(item => item.id === args.accountId && item.platform === 'whatsapp')
      if (!account) throw new Error('账号不存在。')
      await whatsapp.applyPreferences(account.id, account)
      await whatsapp.focus(account.id)
    }
    else whatsapp.hideAll()
    return true
  })
  ipcMain.handle('ui:set-overlay-open', async (_e, open: boolean) => { await requireAuth(); whatsapp.setOverlayOpen(Boolean(open)); return true })
  ipcMain.handle('ui:set-content-bounds', (event, bounds) => { requireMain(event); whatsapp.setContentBounds(bounds) })
  ipcMain.handle('cloud:read', async (event, path: string) => {
    requireMain(event); await requireAuth()
    if (!['/api/me', '/api/wallet', '/api/usage'].includes(path)) throw new Error('不支持此请求。')
    return cloudRequest(path)
  })
  ipcMain.handle('cloud:routes', async event => { requireMain(event); await requireAuth(); return measureCloudRoutes() })
  ipcMain.handle('cloud:set-route', async (event, route) => {
    requireMain(event); await requireAuth()
    const value = route === 'primary' || route === 'backup' ? route : 'auto'
    await settings.save({ ...await settings.get(), cloudRoute: value })
    setCloudRoute(value)
    return value
  })
  ipcMain.handle('cloud:diagnose', async event => {
    requireMain(event); await requireAuth()
    const results = await Promise.allSettled([cloudRequest('/api/me'), cloudRead('/health/translation')])
    return results.map((result, index) => ({
      id: index === 0 ? 'account' : 'provider',
      ok: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? (index === 0 ? { active: result.value?.profile?.status === 'active', balance: result.value?.wallet?.balance } : result.value?.provider) : undefined,
      message: result.status === 'rejected' ? String(result.reason?.message || '连接失败') : undefined
    }))
  })

  const openAccountMenu = async (id: string) => {
    await requireAuth()
    const account = (await accounts.list()).find(item => item.id === id)
    if (!account) return
    const contents = whatsapp.contents(id)
    const notify = (action: string) => mainWindow.webContents.send('ui:account-action', { action, accountId: id })
    const update = async (patch: any) => {
      const value = await accounts.update(id, patch)
      if (value) await whatsapp.applyPreferences(id, value)
      notify('updated')
    }
    const safe = (task: () => Promise<unknown>) => () => { void task().catch(() => mainWindow.webContents.send('translator:error', '操作未完成，请重试。')) }
    Menu.buildFromTemplate([
      { label: '刷新页面', enabled: Boolean(contents), click: () => contents?.reload() },
      { type: 'separator' },
      { label: '账号设置与代理', click: () => notify('configure') },
      { label: '重命名', click: () => notify('rename') },
      { label: '显示译文', type: 'checkbox', checked: account.translationsVisible !== false, click: safe(() => update({ translationsVisible: account.translationsVisible === false })) },
      { label: `页面缩放 ${Math.round((account.zoomFactor || 1) * 100)}%`, enabled: Boolean(contents), submenu: [
        { label: '放大', click: safe(() => update({ zoomFactor: Math.min(1.5, (account.zoomFactor || 1) + 0.1) })) },
        { label: '缩小', click: safe(() => update({ zoomFactor: Math.max(0.5, (account.zoomFactor || 1) - 0.1) })) },
        { label: '重置为 100%', click: safe(() => update({ zoomFactor: 1 })) }
      ] },
      { type: 'separator' },
      { label: '更多操作', submenu: [
        { label: '后退', enabled: contents?.navigationHistory.canGoBack() || false, click: () => contents?.navigationHistory.goBack() },
        { label: '前进', enabled: contents?.navigationHistory.canGoForward() || false, click: () => contents?.navigationHistory.goForward() },
        { label: '复制当前页面地址', enabled: Boolean(contents), click: () => { const url = contents?.getURL(); if (url && /^https?:\/\//.test(url)) clipboard.writeText(url) } },
        { type: 'separator' },
        { label: '检查连接', click: () => notify('diagnose') },
        { label: '诊断日志', click: safe(async () => { const error = await shell.openPath(app.getPath('logs')); if (error) throw new Error(error) }) }
      ] },
      { label: '回到工作台', click: () => notify('home') },
      { label: '关闭此页面', click: () => { whatsapp.remove(id); notify('home') } },
      { type: 'separator' },
      { label: '移除账号', click: safe(async () => {
        const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '移除账号', message: `移除「${account.label}」？`, detail: '仅移除此电脑中的账号入口。请先处理该账号中未完成的发送任务。', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) return
        whatsapp.remove(id); await accounts.remove(id); notify('removed')
      }) }
    ]).popup({ window: mainWindow })
  }
  whatsapp.setMenuHandler(id => { void openAccountMenu(id).catch(() => {}) })
  ipcMain.handle('ui:account-menu', async (event, id: string) => { requireMain(event); return openAccountMenu(id) })
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
  ipcMain.handle('settings:save', async (event, value) => { requireMain(event); await requireAuth(); await settings.save(value); setCloudRoute(value.cloudRoute); whatsapp.resumeTranslations(); return true })
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
