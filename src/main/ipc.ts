import { t } from './uiLocale'
import { createHash } from 'crypto'
import { applyDesktopOptions, notifyAccount } from './desktopRuntime'
import { ipcMain as electronIpcMain, app, Menu, clipboard, dialog, shell } from 'electron'
import { createSecureIpc } from './secureIpc'
import { OnlineSessionStore } from './storage/onlineSessionStore'
import type { BrowserWindow } from 'electron'
import type { AppSettings, RuntimeSettings, TranslationRequest } from './types'
import { AccountManager } from './accounts/accountManager'
import { SettingsStore } from './storage/settingsStore'
import { requestAuthChallenge } from './authChallenge'
import { ProfileStore } from './storage/profileStore'
import { AuthStore } from './storage/authStore'
import { TranslationEngine } from './translation/translationEngine'
import { detectContactLanguage } from './translation/languageDetection'
import { languages } from './translation/languages'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'
import { JsonStore } from './storage/jsonStore'
import { ContactNotes } from './storage/contactNotes'
import { SendTasks, SendNotStartedError, type SendTaskData } from './translation/sendTasks'
import { cloudRead, measureCloudRoutes, setCloudRoute, postNoticeReceipt } from './network/cloudConnection'
import { ClientNotifications } from './clientNotifications'
import { registerReliabilityIpc } from './reliabilityIpc'
import { mergeQuality } from '../shared/translationPolicy'
import { normalizeSignalPeer } from '../shared/signalProtocol'
import { BackgroundAccountStatus } from './network/backgroundAccountStatus'
import { SessionRefresh } from './network/sessionRefresh'
import { OutgoingCredit } from './translation/outgoingCredit'
import { registerSignalFeatures } from './platforms/signal/signalFeatures'
import { signalNeedsTranslation, type SignalPayload } from '../shared/signalMedia'
import { SignalDesktopHost } from './platforms/signal/signalDesktopHost'
import { validateTranslation } from './translation/translationValidation'
import { reusableDisplayOriginal } from '../shared/translationResult'
import { alreadyInTargetLanguage, hasBlockedChinese } from './translation/outgoingPolicy'
import { accountUnreadSnapshot, updateAccountUnread, clearAccountUnread, clearAccountNotifications } from './desktopRuntime'
import { join } from 'path'
import { VoiceRecognition } from './translation/voiceRecognition'
import { GoogleVoiceWorkspace } from './platforms/googleVoice/workspace'
import { GoogleVoiceRecords, type GoogleVoiceData } from './platforms/googleVoice/windowRecords'
import { GoogleVoiceEmbeddedTranslation, type GoogleVoiceEmbeddedDraftData } from './platforms/googleVoice/embeddedTranslation'
import { createGoogleVoiceTranslator } from './platforms/googleVoice/translationBridge'
import { GoogleVoiceDispatchLedger, type GoogleVoiceDispatchData } from './platforms/googleVoice/dispatchLedger'

interface TranslatePayload {
  text: string
  manual?: boolean
  outgoing?: boolean
  conversationId?: string
  conversationName?: string
  messageId?: string
  requestId?: string
  context?: TranslationRequest['context']
}

type OnlineIdentity = { userId: string; email?: string; username?: string; accessToken?: string } | null


export function registerIpc(mainWindow: BrowserWindow, whatsapp: WhatsAppAdapter, signal: SignalAdapter, translator: TranslationEngine): void {
  const ipcMain = createSecureIpc(electronIpcMain, mainWindow, whatsapp)
  ipcMain.handle('auth:challenge',()=>requestAuthChallenge(mainWindow))
  const onlineSessions = new OnlineSessionStore()
  ipcMain.handle('auth:storage-get', (_event, key: string) => onlineSessions.get(key))
  ipcMain.handle('auth:storage-set', (_event, key: string, value: string | null) => onlineSessions.set(key, value))
  translator.onBillingChanged(() => { outgoingCredit.invalidate(); if (!mainWindow.isDestroyed()) mainWindow.webContents.send('billing:changed') })
  const accounts = new AccountManager()
  const contactNotes = new ContactNotes()
  const settings = new SettingsStore()
  const profile = new ProfileStore()
  const auth = new AuthStore()
  const sendTasks = new SendTasks(new JsonStore<SendTaskData>('outgoing-tasks-v1.json', { tasks: [] }, true))
  let onlineIdentity: OnlineIdentity = null
  let identityRevision = 0
  let identityWrites: Promise<unknown> = Promise.resolve()
  const sessions = new SessionRefresh(() => onlineIdentity, request => mainWindow.webContents.send('auth:refresh-requested', request))
  translator.onSessionRefresh((owner, force, rejectedToken) => sessions.token(owner, force, rejectedToken))
  ipcMain.handle('auth:refresh-complete', (event, id: string, ok: boolean, requiresLogin = false) => {
    if (event.sender.id !== mainWindow.webContents.id || typeof id !== 'string' || id.length > 100 || typeof ok !== 'boolean' || typeof requiresLogin !== 'boolean') throw new Error('登录恢复响应无效。')
    sessions.complete(id, ok, requiresLogin)
  })
  const accountStatus = new BackgroundAccountStatus(() => cloudRequest('/api/me'))
  const accountCheckTimer = setInterval(() => { void accountStatus.refresh() }, 60000)
  accountCheckTimer.unref?.()
  mainWindow.on?.('closed', () => clearInterval(accountCheckTimer))
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
  const googleVoiceRecords = new GoogleVoiceRecords(new JsonStore<GoogleVoiceData>('google-voice-windows-v1.json',{windows:[]},true))
  const googleVoice = new GoogleVoiceWorkspace(mainWindow,googleVoiceRecords,taskIdentity,{
    preloadPath:join(__dirname,'../preload/googleVoice.js'),
    onUnread:(accountId,count)=>{
      if(count===null)clearAccountUnread(accountId);else updateAccountUnread(accountId,count)
      if(!mainWindow.isDestroyed())mainWindow.webContents.send('accounts:unread',{accountId,count:count??0})
    },
    notify:(accountId,authorized)=>notifyAccount(accountId,'Google Voice',{hideNames:true,authorized}),
    clearNotifications:clearAccountNotifications
  })
  let workspaceSelection=0
  let workspaceFocusWrites:Promise<unknown>=Promise.resolve()
  const focusWorkspace=(action:()=>Promise<unknown>)=>{
    const selection=++workspaceSelection
    googleVoice.hide();whatsapp.hideAll();signalDesktop.focus('')
    const work=workspaceFocusWrites.catch(()=>undefined).then(async()=>{
      if(selection!==workspaceSelection || mainWindow.isDestroyed())return {state:'cancelled'}
      try{return await action()}finally{
        if(selection!==workspaceSelection){googleVoice.hide();whatsapp.hideAll();signalDesktop.focus('')}
      }
    })
    workspaceFocusWrites=work;return work
  }

  const voice = new VoiceRecognition(app.isPackaged ? join(process.resourcesPath,'voice') : join(app.getAppPath?.()||join(__dirname,'../..'),'resources/voice/bin'),join(app.getPath('temp'),'hellodog-voice'))
  ipcMain.handle('voice:recognize',async(event,id:string,bytes:Uint8Array)=>{
    const identity=taskIdentity()
    const record=(await accounts.list()).find(item=>item.id===id)
    const senderAllowed=()=>event.sender.id===mainWindow.webContents.id&&['whatsapp','signal'].includes(record?.platform||'')||record?.platform==='whatsapp'&&whatsapp.ownsSender(id,event.sender.id)
    if(!record||!senderAllowed())throw new Error('语音不属于当前账号窗口。')
    const text=await voice.recognize(bytes,()=>identity.authorized()&&!event.sender.isDestroyed()&&Boolean(senderAllowed()))
    if(!identity.authorized()||!senderAllowed())throw new Error('登录状态已变化。')
    return {text,audioId:createHash('sha256').update(bytes).digest('hex')}
  })
  ipcMain.handle('voice:translate-file',async(event,id:string,audioId:string,text:string)=>{
    requireMain(event);const identity=taskIdentity()
    const record=(await accounts.list()).find(item=>item.id===id)
    if(!record||typeof audioId!=='string'||!/^[a-f0-9]{64}$/.test(audioId)||typeof text!=='string'||!text.trim()||Array.from(text).length>12000)throw new Error('语音翻译内容无效。')
    const runtime=await accountRuntime(id)
    if(!identity.authorized())throw new Error('登录状态已变化。')
    const answer=await translator.translateIncoming({text:text.trim(),accountId:id,conversationId:'local-voice-files',messageId:audioId,sourceLanguage:'auto',targetLanguage:runtime.localLanguage,quality:runtime.translationQuality},true)
    if(!identity.authorized())throw new Error('登录状态已变化。')
    return answer
  })
  ipcMain.handle('voice:translate',async(event,id:string,peer:string,messageId:string,text:string)=>{
    const identity=taskIdentity();requireMain(event)
    const record=(await accounts.list()).find(item=>item.id===id&&item.platform==='signal')
    if(!record||typeof peer!=='string'||!peer||peer.length>200||typeof messageId!=='string'||messageId.length>1000||typeof text!=='string'||!text.trim()||Array.from(text).length>12000)throw new Error('语音翻译内容无效。')
    const conversationId=normalizeSignalPeer(peer),runtime=await accountRuntime(id,conversationId)
    if(!identity.authorized())throw new Error('登录状态已变化。')
    const identityKey='voice:'+createHash('sha256').update(JSON.stringify([conversationId,messageId])).digest('hex')
    const answer=await translator.translateIncoming({text:text.trim(),accountId:id,conversationId,messageId:identityKey,sourceLanguage:'auto',targetLanguage:runtime.localLanguage,quality:runtime.translationQuality},true)
    if(!identity.authorized())throw new Error('登录状态已变化。')
    return answer
  })

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
    const owner = String(onlineIdentity?.userId || '')
    if (!owner) throw new Error('在线登录令牌缺失，请重新登录。')
    return cloudRead(path, (force, rejectedToken) => sessions.token(owner, force, rejectedToken))
  }
  const outgoingCredit = new OutgoingCredit(() => onlineIdentity?.userId || '', () => cloudRequest('/api/me'), id => translator.outgoingSettlement(id))
  const embeddedVoiceTranslation = new GoogleVoiceEmbeddedTranslation<Electron.IpcMainInvokeEvent>({
    trustedPage:event=>googleVoice.trustedPage(event),
    translate:createGoogleVoiceTranslator(translator,outgoingCredit,()=>settings.runtime(),new GoogleVoiceDispatchLedger(new JsonStore<GoogleVoiceDispatchData>('google-voice-dispatch-v1.json',{records:[]},true))),
    storage:new JsonStore<GoogleVoiceEmbeddedDraftData>('google-voice-embedded-drafts-v1.json',{records:{}},true)
  })
  // This channel has its own registered-webContents, main-frame and owner check.
  // Google pages never receive the trusted shell's general IPC permissions.
  electronIpcMain.handle('google-voice:translate-request',(event,message)=>embeddedVoiceTranslation.request(event,message))
  electronIpcMain.handle('google-voice:unread',(event,message)=>{try{return googleVoice.observeUnread(event,message)}catch{return false}})
  ipcMain.handle('google-voice:list',event=>{requireMain(event);return googleVoice.list()})
  ipcMain.handle('google-voice:add',(event,options?:{label?:string;proxy?:unknown})=>{requireMain(event);return googleVoice.add(options)})
  ipcMain.handle('google-voice:update',(event,id:string,patch:{label?:string;proxy?:unknown})=>{requireMain(event);return googleVoice.update(id,patch)})
  ipcMain.handle('google-voice:test-proxy',(event,input:unknown,id?:string)=>{requireMain(event);return googleVoice.testProxy(input,id)})
  ipcMain.handle('google-voice:check-network',(event,id:string)=>{requireMain(event);return googleVoice.checkNetwork(id)})
  ipcMain.handle('google-voice:reorder',(event,ids:string[])=>{requireMain(event);return googleVoice.reorder(ids)})
  ipcMain.handle('google-voice:focus',async(event,id?:string)=>{requireMain(event);taskIdentity();return focusWorkspace(()=>googleVoice.focus(id))})
  ipcMain.handle('google-voice:close',(event,id:string)=>{requireMain(event);return googleVoice.close(id)})
  ipcMain.handle('google-voice:refresh',(event,id:string)=>{requireMain(event);return focusWorkspace(()=>googleVoice.refresh(id))})
  ipcMain.handle('google-voice:back',(event,id:string)=>{requireMain(event);return googleVoice.back(id)})
  ipcMain.handle('google-voice:permissions',(event,id:string)=>{requireMain(event);return googleVoice.getPermissions(id)})
  ipcMain.handle('google-voice:permission',(event,id:string,permission:'microphone'|'notifications',allowed:boolean)=>{requireMain(event);return googleVoice.setPermissionConsent(id,permission,allowed)})
  ipcMain.handle('google-voice:external',(event,id:string)=>{requireMain(event);return googleVoice.external(id)})
  ipcMain.handle('google-voice:translation-setup',(event,id:string)=>{requireMain(event);return googleVoice.getPermissions(id)})

  const cloudBackedProfile = async () => {
    const local = await profile.get()
    if (!onlineIdentity?.userId) return local
    const payload = await cloudRequest('/api/me')
    const wallet = payload?.wallet || {}
    const remoteProfile = payload?.profile || {}
    for (const key of ['balance', 'lifetime_debited', 'lifetime_credited']) if (!Number.isSafeInteger(wallet[key]) || wallet[key] < 0) throw new Error('云端余额尚未通过校验，请重新同步。')
    if (wallet.lifetime_adjusted_down !== undefined && (!Number.isSafeInteger(wallet.lifetime_adjusted_down) || wallet.lifetime_adjusted_down < 0)) throw new Error('云端余额尚未通过校验，请重新同步。')
    const remaining = wallet.balance
    const used = wallet.lifetime_debited
    const credited = wallet.lifetime_credited
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
      translationQuality: mergeQuality(mergeQuality(base.translationQuality, account.translationQuality), contact?.translationQuality),
      localLanguage: account.localLanguage || base.localLanguage,
      targetLanguage: contact?.language || account.targetLanguage || base.targetLanguage,
      receiveAutoTranslate: account.receiveAutoTranslate ?? base.receiveAutoTranslate,
      sendAutoTranslate: account.sendAutoTranslate ?? base.sendAutoTranslate,
      blockChineseSend: true,
      groupTranslate: account.groupTranslate ?? base.groupTranslate,
      fontSize: Number(account.fontSize || base.fontSize || 13),
      translationColor: account.translationColor || base.translationColor || '#c8d4e4',
      translationsVisible: account.translationsVisible !== false,
      historyMode: account.historyMode || base.historyMode,
      conversationId,
      conversationName: contact?.name,
      contactLanguageSource: contact?.source || 'default'
    }
  }

  const normalizePayload = (value: string | TranslatePayload): TranslatePayload =>
    typeof value === 'string' ? { text: value } : { ...value, text: String(value?.text || '') }
  const { recover, drafts, updates } = registerReliabilityIpc(mainWindow, accounts, settings, sendTasks, translator, whatsapp, signal, () => taskIdentity().owner, {
    resume: async()=>signalDesktop.resume(await accounts.list()), pending:()=>signalDesktop.pendingCount(),
    prepareRestart:()=>signalDesktop.prepareRestart(), refresh:()=>signalDesktop.refresh(),
    insertDraft:(id,text)=>signalDesktop.insertDraft(id,text),
    mode: async(id,mode)=>{if(mode==='paused')await signalDesktop.stop(id);else{const record=(await accounts.list()).find(item=>item.id===id&&item.signalEngine==='desktop');if(record)await signalDesktop.open(record,true)}}
  })
  registerSignalFeatures(mainWindow, signal, () => taskIdentity().owner)
  const notifications = new ClientNotifications(mainWindow, updates, () => onlineIdentity?.userId || '',
    () => cloudRequest('/api/notices'), value => postNoticeReceipt(String(onlineIdentity?.accessToken || ''), value))
  const signalDesktop = new SignalDesktopHost(mainWindow, () => onlineIdentity?.userId || '', async (accountId, raw, startedAt) => {
    const { owner, authorized } = taskIdentity()
    const record = (await accounts.list()).find(item => item.id === accountId && item.platform === 'signal' && item.signalEngine === 'desktop' && item.runtimeMode !== 'paused')
    if (!record) throw new Error('Signal 账号不可用。')
    const conversationId = 'signal-desktop:' + raw.conversationId, runtime = await accountRuntime(accountId, conversationId)
    if (raw.expiresAt !== undefined) {
      await translator.trackContent([{owner, accountId, conversationId, identity:raw.id, expiresAt:raw.expiresAt, reason:'message'}])
      if (raw.expiresAt <= Date.now()) throw new Error('此消息已删除或过期，不能再次翻译。')
    }
    if (raw.direction === 'display') return { enabled:runtime.translationsVisible, fontSize:runtime.fontSize, color:runtime.translationColor, uiLanguage:runtime.uiLanguage }
    if (raw.authorizationOnly) {
      const original = await translator.existingOutgoing(raw.requestId!, accountId, conversationId, raw.text, raw.translated!)
      if (hasBlockedChinese(raw.translated!, original.targetLanguage)) throw new Error('译文仍含中文，已阻止发送并保留草稿。')
      validateTranslation(original, raw.translated!)
      await outgoingCredit.check(owner, original, true, true)
      if (!authorized()) throw new Error('登录状态已变化，消息未发送。')
      return { authorized: true }
    }
    const outgoing = raw.direction === 'outgoing'
    const requestId = (outgoing ? 'send-sd-' : 'sd-') + createHash('sha256').update(JSON.stringify([owner,accountId,raw.id,raw.direction,raw.text,runtime.localLanguage,runtime.targetLanguage,runtime.translationQuality,...(raw.editTimestamp?[raw.editTimestamp]:[])])).digest('hex')
    let request: import('./types').TranslationRequest = { text: raw.text, accountId, conversationId, messageId: raw.id, requestId, sourceLanguage: outgoing ? runtime.localLanguage : 'auto', targetLanguage: outgoing ? runtime.targetLanguage : runtime.localLanguage, quality: runtime.translationQuality }
    if(raw.text.includes('\ufffc')) request.quality={...request.quality,glossary:[{source:'\ufffc',target:'\ufffc'},...(request.quality?.glossary||[]).filter(item=>item.source!=='\ufffc')]}
    if (outgoing) request = await translator.preserveOutgoingRequest(request)
    else request = await translator.preserveIncomingRequest(request)
    if (!authorized()) throw new Error('登录状态已变化。')
    if (outgoing) {
      if (!runtime.sendAutoTranslate || !signalNeedsTranslation(raw.text) || alreadyInTargetLanguage({...request,quality:runtime.translationQuality})) {
        if (hasBlockedChinese(raw.text, runtime.targetLanguage)) throw new Error('仍含中文原文，已阻止发送。请开启发送翻译后重试。')
        return { enabled: false }
      }
      request = await translator.prepareOutgoingRequest(request)
      await outgoingCredit.check(owner, request, true)
      const text = await translator.translate(request)
      if (!authorized()) throw new Error('登录状态已变化。')
      if (hasBlockedChinese(text, runtime.targetLanguage)) throw new Error('译文仍含中文，已阻止发送并保留草稿。')
      validateTranslation(request, text)
      await outgoingCredit.check(owner, request, true, true)
      if (!authorized()) throw new Error('登录状态已变化，消息未发送。')
      return { enabled: true, text, requestId: request.requestId }
    }
    if (!runtime.translationsVisible) return { enabled: false }
    let text = await translator.cached(request)
    if (text === undefined && (raw.manual === true || (runtime.receiveAutoTranslate && runtime.historyMode !== 'manual' && (runtime.historyMode === 'visible' || Number(raw.sentAt) >= startedAt) && (!raw.group || runtime.groupTranslate)))) text = await translator.translateIncoming(request, raw.manual === true)
    if (!authorized()) throw new Error('登录状态已变化。')
    return { enabled: text !== undefined, manual: text === undefined, text, requestId:request.requestId, fontSize:runtime.fontSize, color:runtime.translationColor, uiLanguage:runtime.uiLanguage }
  }, async (owner, accountId, updates) => {
    await translator.trackContent(updates.map(item => ({ owner, accountId, conversationId:'signal-desktop:'+item.conversationId, identity:item.id, expiresAt:item.expiresAt, reason:'message' })))
  })
  ipcMain.handle('signal-desktop:status', async (event, id: string) => { requireMain(event); await requireAuth(); return signalDesktop.status(id) })
  ipcMain.handle('accounts:contact-quality', async (event, id: string, conversation: string, quality: unknown) => {
    requireMain(event); await requireAuth()
    const result = await accounts.updateContactQuality(id, conversation, quality)
    whatsapp.refreshTranslations();signalDesktop.refresh(id)
    return result
  })
  ipcMain.handle('signal-desktop:open', async (event, id: string) => {
    requireMain(event); await requireAuth()
    const record = (await accounts.list()).find(item => item.id === id && item.platform === 'signal')
    if (!record) throw new Error('Signal 账号不存在。')
    if ((await sendTasks.unfinished(taskIdentity().owner)).some(task => task.accountId === id)) throw new Error('请先处理此账号已有的待发送消息，再切换桌面版本。')
    const result = await signalDesktop.open(record)
    await accounts.update(id, { signalEngine:'desktop' }); await signal.resumeReceiving()
    mainWindow.webContents.send('ui:account-action', { accountId:id,action:'updated' })
    return result
  })
  ipcMain.handle('signal-desktop:classic', async (event, id: string) => { requireMain(event); await requireAuth(); await signalDesktop.stop(id); await accounts.update(id,{signalEngine:'cli'}); await signal.resumeReceiving(); mainWindow.webContents.send('ui:account-action',{accountId:id,action:'updated'});return true })

  const announceConversation = (accountId: string | undefined, conversationId?: string, conversationName?: string) => {
    if (!accountId || !conversationId) return
    mainWindow.webContents.send('whatsapp:conversation', { accountId, conversationId, conversationName })
  }

  ipcMain.handle('auth:set-online-session', async (event, identity: OnlineIdentity) => {
    if (event.sender.id !== mainWindow.webContents.id) throw new Error('登录会话只能由主窗口更新。')
    const previous = onlineIdentity
    onlineIdentity = identity?.userId ? identity : null
    if (previous?.userId !== onlineIdentity?.userId) identityRevision += 1
    // Update billing identity synchronously before any native-window teardown
    // awaits, so no browser request can mix a new wallet with an old session.
    translator.setOnlineSession(onlineIdentity?.userId, onlineIdentity?.accessToken)
    sessions.changed()
    outgoingCredit.invalidate()
    accountStatus.setIdentity(onlineIdentity?.userId, onlineIdentity?.accessToken)
    notifications.setIdentity()
    if (previous?.userId !== onlineIdentity?.userId) {
      googleVoice.hide()
      await googleVoice.detachAll()
      clearAccountUnread()
      signalDesktop.stopAll()
      whatsapp.resetViews()
      signal.setOnlineUser(onlineIdentity?.userId || '')
    }
    if (onlineIdentity && (previous?.userId !== onlineIdentity.userId || previous?.username !== onlineIdentity.username || previous?.email !== onlineIdentity.email)) {
      const updated = { username: onlineIdentity.username, email: onlineIdentity.email }
      identityWrites = identityWrites.catch(() => {}).then(() => profile.updateIdentity(updated))
      await identityWrites
    }
    whatsapp.resumeTranslations()
    if (previous?.userId === onlineIdentity?.userId && previous?.accessToken !== onlineIdentity?.accessToken) signalDesktop.refresh()
    if (onlineIdentity?.userId && (previous?.userId !== onlineIdentity.userId || previous?.accessToken !== onlineIdentity.accessToken)) void recover().catch(() => undefined)
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
    googleVoice.hide()
    signalDesktop.stopAll()
    onlineIdentity = null
    sessions.changed()
    outgoingCredit.invalidate()
    notifications.setIdentity()
    accountStatus.setIdentity()
    identityRevision += 1
    translator.setOnlineSession(null, null)
    whatsapp.resetViews()
    signal.setOnlineUser('')
    await googleVoice.detachAll()
    return auth.logout()
  })
  ipcMain.handle('auth:reset-password', (_e, input: { identifier: string; recoveryCode: string; newPassword: string }) => auth.resetPassword(input))

  ipcMain.handle('accounts:list', async () => { await requireAuth(); return accounts.list() })
  ipcMain.handle('accounts:reorder', async (event, platform: any, ids: string[]) => {
    requireMain(event); await requireAuth()
    return accounts.reorder(platform, ids)
  })
  whatsapp.setPasswordReader(id => accounts.proxyPassword(id))
  ipcMain.handle('accounts:add', async (event, args: any) => {
    requireMain(event); await requireAuth()
    if (!['whatsapp', 'signal'].includes(args.platform)) throw new Error('不支持的应用类型。')
    if (args.platform === 'signal' && args.options?.proxy?.enabled) throw new Error('Signal 独立代理暂不支持。')
    return accounts.add(args.platform, args.label, args.signalAccount, args.options)
  })
  ipcMain.handle('accounts:add-batch', async (event, args: any) => {
    requireMain(event); await requireAuth()
    if (!['whatsapp', 'signal'].includes(args.platform)) throw new Error('不支持的应用类型。')
    if (args.platform === 'signal' && args.options?.proxy?.enabled) throw new Error('Signal 独立代理暂不支持。')
    return accounts.addBatch(args.platform, args.label, args.count, args.options || {})
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
    if (updated?.platform === 'signal') await signal.resumeReceiving()
    if (updated?.platform === 'signal' && updated.runtimeMode === 'paused') signalDesktop.stop(id)
    signalDesktop.refresh()
    return updated
  })
  ipcMain.handle('accounts:set-contact-language', async (_e, accountId: string, conversationId: string, language: string, name?: string) => {
    await requireAuth()
    const updated = await accounts.updateContactLanguage(accountId, conversationId, language, name, 'manual')
    signalDesktop.refresh()
    mainWindow.webContents.send('accounts:contact-language', { accountId, conversationId, language, name, source: 'manual' })
    return updated
  })
  ipcMain.handle('accounts:remove', async (event, id: string) => {
    requireMain(event)
    await requireAuth()
    const all = await accounts.list()
    const item = all.find((account) => account.id === id)
    if ((await sendTasks.unfinished(taskIdentity().owner)).some(task => task.accountId === id)) throw new Error('请先完成或核对该账号的待处理发送任务。')
    const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', message: `移除「${item?.label || '此账号'}」入口？`, detail: '此操作与清理译文缓存不同。将保留请求防重记录和恢复数据。', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return false
    if (item?.platform === 'whatsapp') whatsapp.remove(id)
    if (item?.platform === 'signal') await signalDesktop.stop(id)
    await accounts.remove(id)
    clearAccountUnread(id)
    if (item?.platform === 'signal') await signal.resumeReceiving()
    return true
  })

  ipcMain.handle('profile:get', async () => { await requireAuth(); return cloudBackedProfile() })
  ipcMain.handle('profile:update', async (_e, patch: { username?: string; email?: string; planName?: string }) => {
    await requireAuth()
    if (!onlineIdentity && (patch.username !== undefined || patch.email !== undefined)) await auth.updateIdentity({ username: patch.username, email: patch.email })
    return profile.updateIdentity(patch)
  })
  ipcMain.handle('profile:topup', async (_e, characters: number, note?: string) => { await requireAuth(); return profile.addCharacters(characters, note || '字符充值') })

  ipcMain.handle('platform:focus', async (_e, args: { platform: 'whatsapp' | 'signal'; accountId?: string }) => focusWorkspace(async()=>{
    await requireAuth()
    signalDesktop.focus('')
    if (args.platform === 'signal' && args.accountId) {
      const record = (await accounts.list()).find(item => item.id === args.accountId && item.signalEngine === 'desktop')
      if (record && record.runtimeMode !== 'paused') await signalDesktop.open(record)
    }
    if (args.platform === 'whatsapp' && args.accountId) {
      const account = (await accounts.list()).find(item => item.id === args.accountId && item.platform === 'whatsapp')
      if (!account) throw new Error('账号不存在。')
      await whatsapp.applyPreferences(account.id, account)
      await whatsapp.focus(account.id)
    }
    else whatsapp.hideAll()
    return true
  }))
  ipcMain.handle('ui:set-overlay-open', (event, open: boolean) => { requireMain(event); whatsapp.setOverlayOpen(Boolean(open)); signalDesktop.setOverlayOpen(Boolean(open)); googleVoice.setOverlayOpen(Boolean(open)); notifications.setOverlayOpen(Boolean(open)); return true })
  ipcMain.handle('ui:set-content-bounds', (event, bounds) => { requireMain(event); whatsapp.setContentBounds(bounds); signalDesktop.setBounds(bounds); googleVoice.setBounds(bounds) })
  ipcMain.handle('cloud:read', async (event, path: string) => {
    requireMain(event); await requireAuth()
    if (!['/api/me', '/api/wallet', '/api/usage', '/api/account-snapshot'].includes(path)) throw new Error('不支持此请求。')
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

  const refreshes = new Map<string,Promise<boolean>>()
  const refreshAccount = async (id: string) => {
    await requireAuth()
    const account = (await accounts.list()).find(item => item.id === id)
    if (!account) throw new Error('账号不存在。')
    if (refreshes.has(id)) return refreshes.get(id)!
    const work = (async () => {
      mainWindow.webContents.send('ui:account-action',{action:'refreshing',accountId:id})
      try {
        if (account.platform === 'signal' && account.signalEngine === 'desktop') await signalDesktop.reload(account)
        else if (account.platform === 'whatsapp') await whatsapp.reload(id)
        else await signal.refreshAccount(id)
        mainWindow.webContents.send('ui:account-action', { action: 'refreshed', accountId: id })
        return true
      } catch(error) { mainWindow.webContents.send('ui:account-action',{action:'refresh-failed',accountId:id}); throw error }
      finally { refreshes.delete(id) }
    })()
    refreshes.set(id,work);return work
  }
  ipcMain.handle('platform:refresh', (event, id: string) => { requireMain(event); return refreshAccount(id) })
  ipcMain.handle('app:official-website', async event => { requireMain(event); await shell.openExternal('https://hellodog.net/download'); return true })
  ipcMain.handle('app:google-voice', async event => { requireMain(event);const rows=await googleVoice.list();const row=rows[0]||await googleVoice.add();return focusWorkspace(()=>googleVoice.focus(row.id)) })
  ipcMain.handle('accounts:unread-snapshot', async event => { requireMain(event); await requireAuth(); return accountUnreadSnapshot() })
  ipcMain.handle('signal:typing-snapshot', async event => { requireMain(event); await requireAuth(); return signal.typingSnapshot() })
  const openAccountMenu = async (id: string) => {
    await requireAuth()
    const account = (await accounts.list()).find(item => item.id === id)
    if (!account) return
    const contents = whatsapp.contents(id)
    const nativeSignal = account.platform === 'signal' && account.signalEngine === 'desktop'
    const notify = (action: string) => mainWindow.webContents.send('ui:account-action', { action, accountId: id })
    const update = async (patch: any) => {
      const value = await accounts.update(id, patch)
      if (value) await whatsapp.applyPreferences(id, value)
      if (nativeSignal) signalDesktop.refresh(id)
      notify('updated')
    }
    const safe = (task: () => Promise<unknown>) => () => { void task().catch(() => mainWindow.webContents.send('translator:error', t('操作未完成，请重试。'))) }
    Menu.buildFromTemplate([
      { label: t('刷新页面'), enabled: Boolean(contents) || account.platform === 'signal', click: safe(async () => {
        await refreshAccount(id)
      }) },
      { type: 'separator' },
      { label: t('账号设置与代理'), click: () => notify('configure') },
      { label: account.pinned ? t('取消置顶') : t('置顶账号'), click: safe(() => update({ pinned: !account.pinned })) },
      { label: t('重命名'), click: () => notify('rename') },
      { label: t('编辑备注'), click: () => notify('remark') },
      { label: t('编辑红色备注'), click: () => notify('caption') },
      { label: t('显示译文'), type: 'checkbox', checked: account.translationsVisible !== false, click: safe(() => update({ translationsVisible: account.translationsVisible === false })) },
      { label: t('页面缩放 {0}%', Math.round((account.zoomFactor || 1) * 100)), enabled: Boolean(contents), submenu: [
        { label: t('放大'), click: safe(() => update({ zoomFactor: Math.min(1.5, (account.zoomFactor || 1) + 0.1) })) },
        { label: t('缩小'), click: safe(() => update({ zoomFactor: Math.max(0.5, (account.zoomFactor || 1) - 0.1) })) },
        { label: t('重置为 100%'), click: safe(() => update({ zoomFactor: 1 })) }
      ] },
      { type: 'separator' },
      { label: t('更多操作'), submenu: [
        { label: t('后退'), enabled: contents?.navigationHistory.canGoBack() || false, click: () => contents?.navigationHistory.goBack() },
        { label: t('前进'), enabled: contents?.navigationHistory.canGoForward() || false, click: () => contents?.navigationHistory.goForward() },
        { label: t('复制当前页面地址'), enabled: Boolean(contents), click: () => { const url = contents?.getURL(); if (url && /^https?:\/\//.test(url)) clipboard.writeText(url) } },
        { type: 'separator' },
        { label: t('代理与出口 IP'), enabled: account.platform === 'whatsapp', click: () => notify('configure') },
        { label: t('检查连接'), click: () => notify('diagnose') },
        { label: t('诊断日志'), click: safe(async () => { const error = await shell.openPath(app.getPath('logs')); if (error) throw new Error(error) }) }
      ] },
      { label: t('回到工作台'), click: () => notify('home') },
      { label: t('关闭窗口（保留账号）'), click: () => { whatsapp.remove(id); notify('home') } },
      { type: 'separator' },
      { label: t('移除账号入口…'), click: safe(async () => {
        if ((await sendTasks.unfinished(taskIdentity().owner)).some(task => task.accountId === id)) throw new Error(t('请先核对待处理发送任务。'))
        const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: t('移除账号'), message: t('移除「{0}」？', account.label), detail: t('仅移除此电脑中的账号入口。请先处理该账号中未完成的发送任务。'), buttons: [t('取消'), t('移除')], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) return
        whatsapp.remove(id); await signalDesktop.stop(id); await accounts.remove(id); clearAccountUnread(id); if (account.platform === 'signal') await signal.resumeReceiving(); notify('removed')
      }) }
    ]).popup({ window: mainWindow })
  }
  whatsapp.setMenuHandler(id => { void openAccountMenu(id).catch(() => {}) })
  ipcMain.handle('ui:account-menu', async (event, id: string) => { requireMain(event); return openAccountMenu(id) })
  ipcMain.handle('send:prepare', async (event, input: { platform: 'whatsapp' | 'signal'; accountId: string; conversationId: string; targetKey?: string; signalAccount?: string; recipient?: string; signalPayload?: SignalPayload; intentId?: string; text: string; context?: TranslationRequest['context'] }) => {
    const { owner, authorized } = taskIdentity()
    assertTaskSender(event, input)
    if (input.intentId !== undefined && !/^[a-zA-Z0-9-]{12,100}$/.test(input.intentId)) throw new Error('发送编号格式无效。')
    const record = (await accounts.list()).find(item => item.id === input.accountId && item.platform === input.platform)
    if (!record) throw new Error('发送账号不存在。')
    if (record.runtimeMode === 'paused') throw new Error('此账号已暂停，请先恢复收消息。')
    if (input.platform === 'signal' && (!input.signalAccount || record.signalAccount !== input.signalAccount || input.conversationId !== `signal:${input.recipient}`)) throw new Error('Signal 收件人或发送账号不匹配。')
    if (input.platform === 'signal' && normalizeSignalPeer(input.recipient || '') !== input.recipient) throw new Error('请重新选择 Signal 收件人或规范输入手机号。')
    const runtime = await accountRuntime(input.accountId, input.conversationId)
    const signalPayload = input.platform === 'signal' ? await signal.media.validate(owner, input.accountId, input.signalPayload) : undefined
    if (!authorized()) throw new Error('登录状态已变化。')
    return sendTasks.prepare(owner, { platform: input.platform, accountId: input.accountId, intentId: input.intentId,
      conversationId: input.conversationId, targetKey: input.targetKey, signalAccount: input.signalAccount, recipient: input.recipient,
      signalPayload, translate: runtime.sendAutoTranslate && (input.platform !== 'signal' || signalNeedsTranslation(String(input.text || ''))), blockChinese: true,
      request: { text: String(input.text || ''), accountId: input.accountId, conversationId: input.conversationId,
        sourceLanguage: runtime.localLanguage, targetLanguage: runtime.targetLanguage, quality: runtime.translationQuality,
        context: input.platform === 'signal' ? signal.contextForTask(input.accountId, input.recipient || '') : input.context || [] } })
  })
  ipcMain.handle('send:translate', async (event, id: string) => {
    const { owner, authorized } = taskIdentity()
    const original = await sendTasks.get(owner, id)
    assertTaskSender(event, original)
    if (!['sent', 'uncertain', 'submitting'].includes(original.state) && original.translated !== undefined) await outgoingCredit.check(owner, original.request, original.translate)
    const task = await sendTasks.translate(owner, id, async request => {
      const retry = await translator.prepareOutgoingRequest(request)
      if (!authorized()) throw new Error('登录状态已变化。')
      await sendTasks.useTranslationRequest(owner, id, retry)
      await outgoingCredit.check(owner, retry, original.translate)
      return translator.translate(retry)
    }, authorized)
    mainWindow.webContents.send('translator:status', { accountId: task.accountId, state: 'working', message: '正在发送…', settled: true })
    return task
  })
  ipcMain.handle('send:edit-preview', async (event, id: string, text: string) => {
    const { owner } = taskIdentity(); assertTaskSender(event, await sendTasks.get(owner, id))
    return sendTasks.editPreview(owner, id, text)
  })
  ipcMain.handle('send:back-translate', async (event, id: string, text: string) => {
    const { owner } = taskIdentity(); const task = await sendTasks.get(owner, id); assertTaskSender(event, task)
    if (task.state !== 'ready' || typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('当前译文无法回翻。')
    return translator.translate({ text, sourceLanguage: task.request.targetLanguage, targetLanguage: task.request.sourceLanguage || 'zh-CN', accountId: task.accountId, conversationId: task.conversationId, requestId: id + '.back.' + createHash('sha256').update(text).digest('hex').slice(0, 24) })
  })
  ipcMain.handle('send:submit', async (event, id: string) => {
    const { owner, authorized } = taskIdentity()
    const original = await sendTasks.get(owner, id)
    assertTaskSender(event, original)
    try {
    const result = await sendTasks.submit(owner, id, async task => {
      try {
        await outgoingCredit.check(owner, task.request, task.translate, true)
        accountStatus.assertAvailable()
        if (!authorized()) throw new Error('登录状态已变化。')
      } catch (error: any) { throw new SendNotStartedError(String(error?.message || error)) }
      if (task.platform === 'whatsapp') return whatsapp.submitTask(task, authorized)
      return signal.submitTask(task, authorized)
    }, authorized)
    if (result.state === 'sent') await drafts.save(owner, { accountId: result.accountId, conversationId: result.conversationId, targetKey: result.targetKey }, '', result.request.text)
    return result
    } finally { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('translator:status', { accountId: original.accountId, state: 'ready', message: '' }) }
  })
  ipcMain.handle('send:pending-list', async (event, accountId: string) => {
    const { owner } = taskIdentity()
    const record = (await accounts.list()).find(item => item.id === accountId)
    if (!record) throw new Error('账号不存在。')
    assertTaskSender(event, { platform: record.platform, accountId })
    return (await sendTasks.unfinished(owner)).filter(task => task.accountId === accountId)
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

  ipcMain.on('whatsapp:unread', (event, accountId: string, count: number) => {
    if (!whatsapp.ownsSender(accountId, event.sender.id) || !Number.isInteger(count) || count < 0 || count > 99999) return
    const increased = updateAccountUnread(accountId, count)
    mainWindow.webContents.send('accounts:unread', { accountId, count })
    if (increased) void accounts.list().then(items => { const account = items.find(item => item.id === accountId); if (account) notifyAccount(accountId, account.label) }).catch(() => {})
  })
  ipcMain.on('whatsapp:conversation', (_e, accountId: string | undefined, info: { id?: string; name?: string }) => announceConversation(accountId, info?.id, info?.name))

  ipcMain.handle('settings:ui-language', async (event) => { requireMain(event); return (await settings.get()).uiLanguage || 'system' })
  ipcMain.handle('settings:set-ui-language', async (event, value: unknown) => {
    requireMain(event)
    await settings.setUiLanguage(value)
    applyDesktopOptions(await settings.get())
    mainWindow.webContents.send('settings:ui-language-changed', value)
    whatsapp.refreshTranslations(); signalDesktop.refresh()
    return true
  })
  ipcMain.handle('settings:get', async () => {
    await requireAuth()
    return settings.publicSettings()
  })
  ipcMain.handle('settings:save', async (event, value) => { requireMain(event); await requireAuth(); const previous = await settings.get();
    try { applyDesktopOptions(value); await settings.save(value) } catch (error) { applyDesktopOptions(previous); throw error }
    mainWindow.webContents.send('settings:ui-language-changed', value.uiLanguage || 'system')
    setCloudRoute(value.cloudRoute); whatsapp.resumeTranslations(); signalDesktop.refresh(); googleVoice.invalidateContext(); return true })
  ipcMain.handle('translator:get-runtime-settings', async (_e, accountId?: string, conversationId?: string) => { await requireAuth(); return accountRuntime(accountId, conversationId) })
  ipcMain.handle('whatsapp:contact-note', async (event, accountId: string, peer: string) => {
    const { owner, authorized } = taskIdentity()
    if (!whatsapp.ownsSender(accountId, event.sender.id)) throw new Error('账号窗口不匹配。')
    const note = await contactNotes.get(owner, accountId, peer)
    if (!authorized()) throw new Error('登录状态已变化。')
    return note
  })
  ipcMain.handle('whatsapp:save-contact-note', async (event, accountId: string, peer: string, text: string, revision: number) => {
    const { owner, authorized } = taskIdentity()
    if (!whatsapp.ownsSender(accountId, event.sender.id)) throw new Error('账号窗口不匹配。')
    const note = await contactNotes.save(owner, accountId, peer, text, revision)
    if (!authorized()) throw new Error('登录状态已变化。')
    return note
  })
  ipcMain.handle('translator:cache-info', async (event) => { requireMain(event); await requireAuth(); return translator.cacheInfo() })
  ipcMain.handle('translator:clear-cache', async (event) => { requireMain(event); await requireAuth(); await translator.clearCache(); return true })
  ipcMain.handle('translator:metrics', async () => { await requireAuth(); return translator.metrics() })
  ipcMain.handle('translator:languages', async () => { await requireAuth(); return languages })
  ipcMain.handle('translator:cached-incoming', async (event, accountId: string, raw: TranslatePayload) => {
    await requireAuth()
    if (!whatsapp.ownsSender(accountId, event.sender.id)) throw new Error('账号窗口不匹配。')
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    // The durable platform message ID is stronger evidence than a transient
    // DOM direction marker, which may be absent while WhatsApp rerenders.
    if (payload.messageId) {
      const original = await sendTasks.originalForMessage(taskIdentity().owner, accountId, payload.messageId, payload.text)
      if (reusableDisplayOriginal(original, payload.text, current.localLanguage)) return original
    }
    return translator.cached({ text: payload.text, sourceLanguage: 'auto', targetLanguage: current.localLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context, quality: current.translationQuality })
  })
  ipcMain.handle('translator:translate-incoming', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    await requireAuth()
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    // Recheck at the paid boundary as well: a cache read can finish before
    // the send receipt is committed, and the DOM may change in between.
    if (accountId && payload.messageId && whatsapp.ownsSender(accountId, _e.sender.id)) {
      const original = await sendTasks.originalForMessage(taskIdentity().owner, accountId, payload.messageId, payload.text)
      if (reusableDisplayOriginal(original, payload.text, current.localLanguage)) return original
    }
    if (accountId && payload.conversationId && !payload.outgoing) {
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
    return translator.translateIncoming({ text: payload.text, requestId: payload.requestId, sourceLanguage: 'auto', targetLanguage: current.localLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context, quality: current.translationQuality }, payload.manual === true)
  })
  ipcMain.handle('translator:translate-outgoing', async (_e, accountId: string | undefined, raw: string | TranslatePayload) => {
    await requireAuth()
    const payload = normalizePayload(raw)
    const current = await accountRuntime(accountId, payload.conversationId)
    return translator.translate({ text: payload.text, requestId: payload.requestId, sourceLanguage: current.localLanguage, targetLanguage: current.targetLanguage, accountId, conversationId: payload.conversationId, messageId: payload.messageId, context: payload.context, quality: current.translationQuality })
  })
  ipcMain.handle('translator:test', async (_e, text: string, targetLanguage: string) => { await requireAuth(); return translator.translate({ text, sourceLanguage: 'auto', targetLanguage }) })
  ipcMain.handle('translator:test-config', async (_e, value: AppSettings, text: string, targetLanguage: string) => {
    await requireAuth()
    try {
      if (!value || typeof value !== 'object' || JSON.stringify(value).length > 65536) throw new Error('设置内容无效。')
      const candidate = { ...value }, stored = await settings.get()
      for (const key of ['openaiApiKey','deeplApiKey','googleApiKey'] as const) if (['saved-secret','cloud-managed'].includes(candidate[key] || '')) candidate[key] = stored[key]
      const translated = await translator.testWithSettings(candidate, { text, sourceLanguage: 'auto', targetLanguage }); return { ok: true, translated, message: '云端翻译连接和测试成功。' }
    }
    catch (error: any) { return { ok: false, message: String(error?.message || error) } }
  })

  ipcMain.handle('signal:translate-message', async (event, id: string, message: any) => {
    requireMain(event); await requireAuth()
    return signal.translateMessage(id,message,true)
  })
  ipcMain.handle('signal:display-message', async (event,id:string,message:any) => { requireMain(event); await requireAuth(); return signal.translateMessage(id,message,false) })
  ipcMain.handle('signal:runtime-status', async () => { await requireAuth(); return signal.runtimeStatus() })
  ipcMain.handle('signal:prepare-runtime', async () => { await requireAuth(); return signal.prepareRuntime() })
  ipcMain.handle('signal:list-accounts', async () => { await requireAuth(); return signal.listAccounts() })
  ipcMain.handle('signal:start-link', async () => { await requireAuth(); return signal.startLink() })
  ipcMain.handle('signal:finish-link', async (_e, uri: string, name?: string) => { await requireAuth(); return signal.finishLink(uri, name) })
  ipcMain.handle('signal:list-contacts', async (_e, account: string) => { await requireAuth(); return signal.listContacts(account) })
  ipcMain.handle('signal:sync-contacts', async (event, account: string) => { requireMain(event); await requireAuth(); return signal.syncContacts(account) })

  ipcMain.on('translator:status', (_e, accountId: string | undefined, status: any) => mainWindow.webContents.send('translator:status', { accountId, state: status?.state || 'ready', message: status?.message || '翻译器已就绪', at: Number(status?.at || Date.now()) }))
  ipcMain.on('translator:error', (_e, message: string) => mainWindow.webContents.send('translator:error', message))
}
