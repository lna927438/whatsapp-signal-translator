import { app, ipcMain as electronIpcMain, dialog, clipboard, net } from 'electron'
import { createSecureIpc } from './secureIpc'
import { t } from './uiLocale'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { Drafts, type DraftTarget } from './storage/drafts'
import { makeSettingsBackup, parseSettingsBackup } from './storage/settingsBackup'
import { SettingsStore } from './storage/settingsStore'
import { AccountManager } from './accounts/accountManager'
import { SendTasks } from './translation/sendTasks'
import { TranslationEngine } from './translation/translationEngine'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'
import { runtimeSnapshot, getAccountStates, setAccountState, watchPower, markSwitch } from './runtimeHealth'
import { configureQuitGuard, configureRestart, restartDesktop, applyDesktopOptions } from './desktopRuntime'
import { boundedOperation } from './boundedOperation'
import { UpdateManager } from './updates'
import { setCloudRoute } from './network/cloudConnection'
import { RecoveryCoordinator } from './recoveryCoordinator'

export function registerReliabilityIpc(window: BrowserWindow, accounts: AccountManager, settings: SettingsStore,
  tasks: SendTasks, translator: TranslationEngine, whatsapp: WhatsAppAdapter, signal: SignalAdapter,
  owner: () => string, desktop?: { resume: () => Promise<void>; mode: (id:string,mode:'paused'|'receiving')=>Promise<void>; pending:()=>number; prepareRestart?:()=>Promise<void>; refresh?:()=>void; insertDraft?:(id:string,text:string)=>Promise<void> }) {
  const ipcMain = createSecureIpc(electronIpcMain, window, whatsapp)
  const drafts = new Drafts(), updates = new UpdateManager()
  translator.onContentCleanup(entry => tasks.expireContent(entry.owner, entry.accountId, entry.conversationId, entry.identity),
    async user => new Set((await tasks.unfinished(user)).flatMap(task => [task.id, task.request.requestId || '', task.request.messageId || ''])),
    (user, cutoff) => tasks.expireOlderContent(user, cutoff))
  let reconciling = false
  const reconcileSends = async () => {
    if (reconciling) return
    reconciling = true
    try {
      const user = owner()
      const pending = (await tasks.unfinished(user)).filter(task => ['uncertain', 'submitting'].includes(task.state))
      for (const task of pending.slice(-30)) {
        if (user !== owner()) return
        const result = await boundedOperation(task.platform === 'signal' ? signal.reconcileTask(task) : whatsapp.reconcileTask(task), 2000, '发送结果仍待确认').catch(() => undefined)
        if (result && user === owner()) {
          const settled = await tasks.resolveWithEvidence(user, task.id, result)
          if (settled.state !== 'sent') continue
          await drafts.save(user, { accountId: task.accountId, conversationId: task.conversationId, targetKey: task.targetKey }, '', task.request.text)
          if (!window.isDestroyed()) window.webContents.send('ui:account-action', { action: 'send-resolved', accountId: task.accountId })
        }
      }
    } finally { reconciling = false }
  }
  signal.onSendConfirmed?.(async (user, id, message) => { await tasks.resolveWithEvidence(user, id, message); if (!window.isDestroyed()) window.webContents.send('ui:account-action', { action: 'send-resolved', accountId: (await tasks.get(user, id)).accountId }) })
  signal.onMessageExpired?.((user, message) => tasks.expireMessage(user, message.taskId!))
  const reconcileTimer = setInterval(() => { void reconcileSends().catch(() => undefined) }, 6000)
  const cleanupTimer = setInterval(() => { void translator.sweepContent().catch(() => undefined); void signal.expireMessages?.().catch(() => undefined) }, 2000)
  cleanupTimer.unref?.()
  reconcileTimer.unref?.()
  window.on?.('closed', () => { clearInterval(reconcileTimer); clearInterval(cleanupTimer) })
  const main = (event: IpcMainInvokeEvent) => { if (event.sender.id !== window.webContents.id) throw new Error('此操作只能由主窗口执行。'); return owner() }
  const draftOwner = async (event: IpcMainInvokeEvent, target: DraftTarget) => {
    const user = owner()
    const record = (await accounts.list()).find(item => item.id === target?.accountId)
    if (!record || (record.platform === 'whatsapp' ? !whatsapp.ownsSender(record.id, event.sender.id) : event.sender.id !== window.webContents.id)) throw new Error('草稿账号与窗口不匹配。')
    if (user !== owner()) throw new Error('登录状态已变化。')
    return user
  }
  const recovery = new RecoveryCoordinator()
  let recoveryWork: Promise<void> | undefined
  const recover = (): Promise<void> => {
    if (recoveryWork) return recoveryWork
    const user = owner()
    recoveryWork = (async () => {
    const results = await recovery.run(user, {
      '翻译结果': () => translator.reconcilePending(),
      'WhatsApp': () => whatsapp.resumeTranslations(),
      'Signal 接收': () => signal.resumeReceiving(),
      'Signal 窗口': () => desktop?.resume(),
      '发送结果': reconcileSends,
      '本机内容清理': () => translator.sweepContent(),
    })
    if (user !== owner()) throw new Error('登录状态已变化。')
    if (!window.isDestroyed()) window.webContents.send('billing:changed')
    if (results.some(item => !item.ok)) throw new Error(results.filter(item => !item.ok).map(item => item.name).join('、') + '尚未恢复，其他服务已独立尝试恢复。原任务保留，不会自动重复发送。')
    })().finally(() => { recoveryWork = undefined })
    return recoveryWork
  }
  watchPower(window, recover)
  configureRestart(() => boundedOperation((async () => {
    await window.webContents.executeJavaScript('window.__HELLODOG_PREPARE_RESTART__?.()')
    await whatsapp.prepareRestart()
    await desktop?.prepareRestart?.()
    await Promise.all([tasks.flush(), translator.flush(), drafts.flush(), signal.flushHistory()])
    await window.webContents.session.flushStorageData()
  })(), 20000, '保存等待超时，暂未重启。草稿和原任务仍保留，请稍后重试。'))
  ipcMain.handle('app:restart', event => {
    if (event.sender.id !== window.webContents.id) throw new Error('此操作只能由主窗口执行。')
    return restartDesktop()
  })
  configureQuitGuard(async () => {
    await Promise.all([tasks.flush(), translator.flush(), drafts.flush(), signal.flushHistory()])
    let user: string
    try { user = owner() } catch { return 0 }
    return (await tasks.unfinished(user)).length + await translator.pendingCount() + (desktop?.pending() || 0)
  })
  ipcMain.handle('draft:get', async (event, target: DraftTarget) => drafts.get(await draftOwner(event, target), target))
  ipcMain.handle('draft:save', async (event, target: DraftTarget, text: string) => drafts.save(await draftOwner(event, target), target, text))
  ipcMain.handle('whatsapp:edit-composer',async(event,accountId:string,value:any)=>{
    owner()
    if(!whatsapp.ownsSender(accountId,event.sender.id))throw new Error('输入框与账号不匹配。')
    return whatsapp.editComposer(accountId,value)
  })
  ipcMain.handle('reliability:history', async event => { main(event); return (await translator.history()).slice(0, 500).map(({ owner: _owner, ...item }) => item) })
  ipcMain.handle('reliability:retention', async (event, days?: number) => { main(event); return translator.retentionInfo(days) })
  ipcMain.handle('reliability:set-retention', async (event, days: number) => {
    const user = main(event), preview = await translator.retentionInfo(days)
    const answer = await dialog.showMessageBox(window, { type:'question', message: days ? t('将此 HelloDog 用户的本机翻译内容保留 {0} 天？', days) : t('保留此 HelloDog 用户的本机翻译内容？'),
      detail: t('当前将清理 {0} 条已完成记录的原文和译文。保留请求编号、字符数和扣费结果。草稿、待确认请求和平台聊天不在此范围。已清理内容不会自动恢复或重新扣费。', preview.affected), buttons:[t('取消'),t('保存')], defaultId:0, cancelId:0 })
    if (user !== owner()) throw new Error('登录状态已变化。')
    if (answer.response !== 1) return false
    await translator.setRetention(days); whatsapp.refreshTranslations(); desktop?.refresh?.(); return true
  })
  ipcMain.handle('reliability:recover', async event => { main(event); await recover(); return true })
  ipcMain.handle('reliability:resolve-send', async (event, id: string, action: string) => {
    const user = main(event)
    const task = await tasks.get(user, id)
    if (user !== owner()) throw new Error('登录状态已变化。')
    if (action === 'retry') {
      if (task.platform !== 'whatsapp' || !['draft','translating','ready'].includes(task.state)) throw new Error('此任务正在处理或确认，不能重复发送。')
      if (!await whatsapp.retryTask(task)) {
        const message='请先打开原账号的原对话，再重试这条消息。'
        window.webContents.send('translator:error',message)
        throw new Error(message)
      }
      return true
    }
    if (!['sent', 'not-sent', 'cancel'].includes(action)) throw new Error('无效的任务操作。')
    const result = action === 'sent' ? await tasks.confirmSent(user, id)
      : action === 'not-sent' ? await tasks.confirmNotSent(user, id) : await tasks.cancel(user, id)
    window.webContents.send('ui:account-action', { action: 'send-resolved', accountId: task.accountId })
    return result
  })
  ipcMain.handle('reliability:switch-duration', (event, ms: number) => { main(event); if (Number.isFinite(ms) && ms >= 0 && ms < 60000) markSwitch(ms) })
  ipcMain.handle('reliability:retry-original', async (event, id: string) => { main(event); return translator.retryOriginal(id) })
  ipcMain.handle('reliability:correct', async (event, id: string, text: string) => { main(event); await translator.correct(id, text); whatsapp.refreshTranslations(); desktop?.refresh?.(); return true })
  ipcMain.handle('reliability:restore-correction', async (event, id: string) => { main(event); await translator.restoreCorrection(id); whatsapp.refreshTranslations(); desktop?.refresh?.(); return true })
  ipcMain.handle('reliability:new-translation', async (event, id: string, input: any) => {
    main(event)
    if (input?.confirmed !== true || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000 || typeof input.targetLanguage !== 'string') throw new Error('请先确认新翻译的内容和目标语言。')
    const original = (await translator.history()).find(item => item.requestId === id)
    if (!original) throw new Error('原翻译记录不存在。')
    if (original.contentExpired) throw new Error('原消息已过期，不能重新翻译。')
    if (input.tone !== undefined && !['natural','business'].includes(input.tone)) throw new Error('语气选项无效。')
    if (['queued','pending'].includes(original.state)) throw new Error('请先核对原请求，避免为结果未明的同一操作创建新翻译。')
    return translator.translate({ ...original.request, requestId: 'revision-' + randomUUID(), messageId: undefined, text: input.text, targetLanguage: input.targetLanguage,
      quality: input.tone ? { ...original.request.quality, tone: input.tone } : original.request.quality })
  })
  ipcMain.handle('reliability:status', async event => {
    const user = main(event)
    const records = await accounts.list(), history = await translator.history()
    return { online: net.isOnline(), metrics: runtimeSnapshot(), accounts: records.map(record => ({ id: record.id,
      state: record.runtimeMode === 'paused' ? 'paused' : getAccountStates()[record.id]?.state || 'closed',
      checkedAt: getAccountStates()[record.id]?.checkedAt,
      proxy: record.platform === 'signal' ? 'unsupported' : record.proxy?.enabled ? 'configured' : 'direct',
      pendingTranslations: history.filter(item => item.request.accountId === record.id && ['pending', 'queued'].includes(item.state)).length
    })), pendingSends: (await tasks.unfinished(user)).map(item => ({ id: item.id, platform: item.platform, accountId: item.accountId, state: item.state, updatedAt: item.updatedAt, conversationId: item.conversationId, text: item.request.text })), version: app.getVersion() }
  })
  const setMode = async (id: string, mode: 'paused' | 'receiving') => {
    const record = (await accounts.list()).find(item => item.id === id)
    if (!record) throw new Error('账号不存在。')
    if (mode === 'paused' && (await tasks.unfinished(owner())).some(task => task.accountId === id && ['translating', 'submitting'].includes(task.state))) throw new Error('账号仍在处理发送任务，请完成或核对后再暂停。')
    await accounts.update(id, { runtimeMode: mode })
    try {
      if (record.platform === 'whatsapp') {
        if (mode === 'paused') whatsapp.remove(id)
        else { await whatsapp.applyPreferences(id, { ...record, runtimeMode: mode }); await whatsapp.focus(id) }
      } else { await signal.resumeReceiving(); await desktop?.mode(id,mode) }
      setAccountState(id, mode === 'paused' ? 'paused' : getAccountStates()[id]?.state || 'loading')
    } catch (error) { await accounts.update(id, { runtimeMode: record.runtimeMode || 'receiving' }); throw error }
    return true
  }
  ipcMain.handle('reliability:account-mode', async (event, id: string, mode: 'paused' | 'receiving') => { main(event); if (!['paused', 'receiving'].includes(mode)) throw new Error('运行模式无效。'); return setMode(id, mode) })
  ipcMain.handle('reliability:bulk-mode', async (event, ids: string[], mode: 'paused' | 'receiving') => {
    main(event)
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || !['paused', 'receiving'].includes(mode)) throw new Error('请选择有效的账号范围。')
    const selected = (await accounts.list()).filter(item => ids.includes(item.id))
    if (selected.length !== ids.length) throw new Error('账号范围已变化，请重新选择。')
    const answer = await dialog.showMessageBox(window, { type: 'question', message: t(mode === 'paused' ? '暂停这 {0} 个账号？' : '恢复这 {0} 个账号？', selected.length), detail: selected.map(item => item.label).join('\n'), buttons: [t('取消'), t('确认')], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return []
    const results: Array<{ id: string; ok: boolean }> = []
    for (const id of ids) { try { await setMode(id, mode); results.push({ id, ok: true }) } catch { results.push({ id, ok: false }) } }
    return results
  })
  ipcMain.handle('reliability:quick-reply', async (event, id: string, text: string) => {
    main(event)
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('快捷回复无效。')
    const record = (await accounts.list()).find(item => item.id === id)
    if (!record || record.runtimeMode === 'paused') throw new Error('请先打开聊天账号。')
    if (record.platform === 'whatsapp') {
      const contents = whatsapp.contents(id)
      if (!contents || !await contents.executeJavaScript(`window.__RT_INSERT_DRAFT__?.(${JSON.stringify(text)})`, true)) throw new Error('请先打开目标对话。为保留已有草稿，快捷回复只填入空输入框。')
    } else if(record.signalEngine==='desktop') {
      if(!desktop?.insertDraft)throw new Error('Signal 快捷回复暂不可用。')
      await desktop.insertDraft(id,text)
    } else window.webContents.send('ui:account-action', { action: 'quick-reply', accountId: id, text })
    return true
  })
  ipcMain.on('whatsapp:connection', (event, id: string, state: string) => {
    if (whatsapp.ownsSender(id, event.sender.id) && ['offline', 'page-ready', 'login-required', 'loading'].includes(state)) setAccountState(id, state)
  })
  ipcMain.handle('signal:history', async (event, account: string) => { main(event); return signal.loadHistory(account) })
  ipcMain.handle('settings:export-backup', async event => {
    main(event)
    const result = await dialog.showSaveDialog(window, { defaultPath: 'HelloDog-settings.json', filters: [{ name: t('设置备份'), extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify(makeSettingsBackup(await settings.get()), null, 2), 'utf8')
    return true
  })
  ipcMain.handle('settings:restore-backup', async event => {
    main(event)
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: t('设置备份'), extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return false
    if ((await stat(result.filePaths[0])).size > 1024 * 1024) throw new Error('备份文件过大。')
    const backup = parseSettingsBackup(await readFile(result.filePaths[0], 'utf8'))
    const answer = await dialog.showMessageBox(window, { type: 'question', message: t('恢复以下全局设置？'), detail: JSON.stringify(backup.settings, null, 2) + '\n' + t('账号、登录、密钥、草稿和聊天记录不在恢复范围内。'), buttons: [t('取消'), t('恢复')], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return false
    const previous = await settings.get()
    const value = { ...previous, ...backup.settings }
    try { applyDesktopOptions(value); await settings.save(value); setCloudRoute(value.cloudRoute); whatsapp.resumeTranslations(); desktop?.refresh?.(); window.webContents.send('settings:ui-language-changed', value.uiLanguage || 'system') }
    catch (error) { applyDesktopOptions(previous); await settings.save(previous); throw error }
    return true
  })
  ipcMain.handle('reliability:diagnostics', async event => {
    main(event)
    const records = await accounts.list(), receipts = await translator.history(), metrics = translator.metrics()
    return JSON.stringify({ product: 'HelloDog', version: app.getVersion(), platform: process.platform, generatedAt: new Date().toISOString(),
      runtime: runtimeSnapshot(), translation: { active: metrics.activeRequests, queue: metrics.queueDepth, cacheHits: metrics.cacheHits, providerCalls: metrics.providerCalls, lastLatencyMs: metrics.lastLatencyMs },
      accounts: records.map((item, index) => ({ label: `账号 ${index + 1}`, platform: item.platform, paused: item.runtimeMode === 'paused', proxyConfigured: item.proxy?.enabled === true })),
      requests: { pending: receipts.filter(item => item.state === 'pending').length, failed: receipts.filter(item => item.state === 'failed').length },
      privacy: '不含密钥、联系人、原文、译文、账号标识或原始日志。' }, null, 2)
  })
  ipcMain.handle('reliability:copy-diagnostics', (event, preview: string) => { main(event); if (typeof preview !== 'string' || preview.length > 20000) throw new Error('诊断预览无效。'); clipboard.writeText(preview); return true })
  ipcMain.handle('updates:info', event => { main(event); return updates.info() })
  ipcMain.handle('updates:notice', event => { main(event); return updates.notice() })
  ipcMain.handle('updates:snooze', (event,version:string) => { main(event); return updates.snooze(version) })
  ipcMain.handle('updates:check', async (event, channel: 'stable' | 'beta') => { main(event); if (!['stable','beta'].includes(channel)) throw new Error('更新渠道无效。'); await settings.save({ ...await settings.get(), updateChannel: channel }); return updates.check(channel) })
  ipcMain.handle('updates:download', event => { main(event); return updates.download() })
  ipcMain.handle('updates:recovery', event => { main(event); return updates.openRecovery() })
  ipcMain.handle('updates:open', async event => { const user = main(event); if ((await tasks.unfinished(user)).length || await translator.pendingCount()) throw new Error('请先完成或核对未完成的任务，再打开安装包。'); return updates.openInstaller() })
  return { recover, drafts, updates }
}
