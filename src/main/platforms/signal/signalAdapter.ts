import { notifyAccount, updateAccountUnread } from '../../desktopRuntime'
import { BrowserWindow } from 'electron'
import { SignalCli, signalDataDirectory } from './signalCli'
import { unlink } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import type { SignalRuntimeStatus } from './signalRuntime'
import type { AccountRecord, RuntimeSettings, TranslationContextItem } from '../../types'
import { TranslationEngine } from '../../translation/translationEngine'
import { detectContactLanguage } from '../../translation/languageDetection'
import { alreadyInTargetLanguage } from '../../translation/outgoingPolicy'
import { SettingsStore } from '../../storage/settingsStore'
import { AccountManager } from '../../accounts/accountManager'
import { JsonStore } from '../../storage/jsonStore'
import { setAccountState } from '../../runtimeHealth'
import { mergeQuality } from '../../../shared/translationPolicy'
import { readSignalTyping, SignalTypingState } from '../../../shared/signalTyping'
import { signalContacts, signalEnvelopePeer, signalSendParameters, signalSendTimestamp } from '../../../shared/signalProtocol'
import { SignalPreferencesStore } from '../../storage/signalPreferences'
import { SignalMediaStore } from './signalMediaStore'
import { clearSignalMediaGrants } from './signalMediaProtocol'
import { normalizeAttachments, type SignalAttachment } from '../../../shared/signalMedia'

import { SendNotStartedError, SendPendingError, type SendTask } from '../../translation/sendTasks'

export interface SignalMessage {
  update?: boolean
  taskId?: string
  account: string
  peer: string
  fromMe: boolean
  original: string
  translated?: string
  displayTranslated?: string
  timestamp: number
  senderName?: string
  attachmentCount?: number
  attachments?: SignalAttachment[]
  delivery?: 'sent' | 'delivered' | 'read'
  recipients?: string[]
  deliveredTo?: string[]
  readBy?: string[]
  expiresInSeconds?: number
  expiresAt?: number
  system?: boolean
  expired?: boolean
  retentionCleared?: boolean
  expiredAttachmentIds?: string[]
}

export class SignalAdapter {
  private typing = new SignalTypingState()
  typingSnapshot() { return this.typing.snapshot() }
  private startedAt = Date.now()
  private readonly receivedIds = new Set<string>()
  private readonly cli = new SignalCli()
  private readonly translator: TranslationEngine
  private readonly settings = new SettingsStore()
  private readonly accounts = new AccountManager()
  readonly preferences = new SignalPreferencesStore()
  readonly media = new SignalMediaStore()
  private readonly recent = new Map<string, TranslationContextItem[]>()
  private readonly expirations = new Map<string, number>()
  private readonly contactIdentities = new Map<string, string>()
  private readonly contactArchives = new Map<string, boolean>()
  private readonly groupMembers = new Map<string, string[]>()
  private canonicalPeer(account: string, peer: string) { return this.contactIdentities.get(account + ':' + peer) || peer }
  private messageExpired?: (owner: string, message: SignalMessage) => Promise<void>
  onMessageExpired(callback: (owner: string, message: SignalMessage) => Promise<void>) { this.messageExpired = callback }
  private mainWindow?: BrowserWindow
  private onlineUser = ''
  private identityRevision = 0
  private subscriptions = new Map<string, number>()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectDelay = 3000
  private stopped = false
  private sendConfirmed?: (owner: string, id: string, message: SignalMessage) => Promise<void>
  onSendConfirmed(callback: (owner: string, id: string, message: SignalMessage) => Promise<void>) { this.sendConfirmed = callback }
  private subscriptionWrites: Promise<unknown> = Promise.resolve()
  private historyStore = new JsonStore<Array<SignalMessage & { owner: string }>>('signal-history-v1.json', [], true)
  private historyWrites: Promise<unknown> = Promise.resolve()

  constructor(translator: TranslationEngine) {
    this.translator = translator
    this.cli.on('receive', (params) => { void this.onReceive(params).catch(() => this.mainWindow?.webContents.send('signal:diagnostic', '消息暂未保存，请保留应用数据并检查磁盘空间。')) })
    this.cli.on('started', () => { this.subscriptions.clear(); this.reconnectDelay = 3000; clearTimeout(this.reconnectTimer) })
    this.cli.on('exit', () => { this.subscriptions.clear(); void this.accounts.list().then(items => items.filter(item => item.platform === 'signal').forEach(item => setAccountState(item.id, 'disconnected'))).catch(() => undefined); this.scheduleReconnect() })
    this.cli.on('runtime', (status: SignalRuntimeStatus) => this.mainWindow?.webContents.send('signal:runtime', status))
    this.cli.on('stderr', (message: string) => this.mainWindow?.webContents.send('signal:diagnostic', message))
  }

  attachMainWindow(window: BrowserWindow): void { this.mainWindow = window }
  setOnlineUser(userId: string): void {
    if (userId === this.onlineUser) return
    clearSignalMediaGrants()
    this.onlineUser = userId
    this.stopped = !userId
    clearTimeout(this.reconnectTimer)
    this.identityRevision += 1
    this.typing.clear()
    this.cli.stop()
    this.subscriptions.clear(); this.receivedIds.clear()
    this.recent.clear()
    this.expirations.clear(); this.contactIdentities.clear(); this.contactArchives.clear(); this.groupMembers.clear()
  }
  async start(): Promise<void> {
    this.stopped = false
    const revision = this.identityRevision
    if (!this.onlineUser) throw new Error('请先登录在线账号。')
    await this.cli.start()
    if (this.stopped || !this.onlineUser || revision !== this.identityRevision) {
      this.cli.stop()
      throw new Error('登录状态已变化。')
    }
    await this.syncSubscriptions()
  }
  stop(): void { this.stopped = true; clearTimeout(this.reconnectTimer); this.cli.stop() }
  private scheduleReconnect() {
    if (!this.onlineUser || this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (!this.onlineUser || this.stopped) return
      void this.resumeReceiving().catch(() => this.scheduleReconnect())
    }, this.reconnectDelay)
    this.reconnectTimer.unref?.()
    this.reconnectDelay = Math.min(60000, this.reconnectDelay * 2)
  }
  async flushHistory() { await this.historyWrites }
  async resumeReceiving() {
    if (this.stopped || !this.onlineUser) return
    const revision = this.identityRevision
    const records = (await this.accounts.list()).filter(item => item.platform === 'signal' && item.signalEngine !== 'desktop' && item.signalAccount && item.runtimeMode !== 'paused')
    if (this.stopped || revision !== this.identityRevision) return
    if (records.length && (await this.cli.runtimeStatus()).state === 'ready') {
      if (!this.stopped && revision === this.identityRevision) await this.start()
    }
    else if (!records.length) { this.cli.stop(); this.subscriptions.clear() }
  }
  private syncSubscriptions() {
    const revision = this.identityRevision
    const work = this.subscriptionWrites.catch(() => undefined).then(async () => {
      if (revision !== this.identityRevision) return
      const records = (await this.accounts.list()).filter(item => item.platform === 'signal' && item.signalEngine !== 'desktop' && item.signalAccount)
      for (const [account, subscription] of this.subscriptions) {
        if (!records.some(item => item.signalAccount === account && item.runtimeMode !== 'paused')) { await this.cli.call('unsubscribeReceive', { subscription }); this.subscriptions.delete(account) }
      }
      for (const record of records) {
        if (record.runtimeMode === 'paused') { setAccountState(record.id, 'paused'); continue }
        if (!this.subscriptions.has(record.signalAccount!)) {
          try {
            const subscription = await this.cli.call('subscribeReceive', { account: record.signalAccount })
            if (!Number.isInteger(subscription)) throw new Error('Signal 消息订阅未确认。')
            if (revision !== this.identityRevision) return
            this.subscriptions.set(record.signalAccount!, subscription)
            void this.announceUnread(record.signalAccount!).catch(()=>undefined)
          } catch {
            setAccountState(record.id, 'disconnected')
            continue
          }
        }
        setAccountState(record.id, 'receiving')
      }
    })
    this.subscriptionWrites = work
    return work
  }
  async loadHistory(account: string) {
    const owner = this.onlineUser
    await this.historyWrites.catch(() => undefined)
    const record = await this.recordForSignalAccount(account)
    if (!record || owner !== this.onlineUser) return []
    await this.expireMessages()
    const history = (await this.historyStore.read()).filter(item => item.owner === owner && item.account === account && !item.expired && (!item.expiresAt || item.expiresAt > Date.now()))
    const receipts = await this.translator.history()
    if (owner !== this.onlineUser) return []
    return history.map(({ owner: _owner, ...message }) => {
      const receipt = receipts.find(item => item.request.accountId === record.id && (message.taskId ? item.requestId === message.taskId : item.request.messageId === `${message.peer}:${message.timestamp}`) && item.translated !== undefined)
      return receipt ? { ...message, translated: receipt.correction ?? receipt.translated } : message
    })
  }
  private rememberMessage(owner: string, message: SignalMessage) {
    const work = this.historyWrites.catch(() => undefined).then(async () => {
      const data = await this.historyStore.read()
      const index = data.findIndex(item => item.owner === owner && item.account === message.account && item.peer === message.peer && item.timestamp === message.timestamp && item.fromMe === message.fromMe)
      const existing = index >= 0 ? data[index] : undefined
      const value = { ...existing, ...message, ...(existing?.taskId && !message.taskId ? { taskId: existing.taskId, original: existing.original, translated: existing.translated } : {}), owner }
      if (existing?.expired) { value.original = ''; value.translated = undefined; value.displayTranslated = undefined; value.attachments = []; value.expired = true }
      if (index >= 0) data[index] = value; else data.push(value)
      await this.historyStore.write(data.slice(-20000))
      const { owner: _owner, ...saved } = value
      return saved
    })
    this.historyWrites = work
    return work
  }

  async expireMessages() {
    const owner = this.onlineUser
    if (!owner) return
    const records = await this.accounts.list()
    const work = this.historyWrites.catch(() => undefined).then(async () => {
      const data = await this.historyStore.read()
      let changed = false
      for (const item of data.filter(item => item.owner === owner && item.expiresAt && item.expiresAt <= Date.now() && !item.retentionCleared).slice(0, 30)) {
        const record = records.find(record => record.platform === 'signal' && record.signalAccount === item.account)
        if (!record) continue
        const ids = item.expiredAttachmentIds || (item.attachments || []).map(attachment => attachment.id)
        item.original = ''; item.translated = undefined; item.displayTranslated = undefined; item.attachments = []; item.attachmentCount = 0; item.expired = true; item.expiredAttachmentIds = ids
        await this.translator.expireSignalMessage?.(owner, record.id, item.peer, item.taskId || `${item.peer}:${item.timestamp}`)
        if (item.taskId) await this.messageExpired?.(owner, item)
        this.recent.delete(this.key(record.id, item.peer))
        const root = resolve(join(signalDataDirectory(), 'attachments'))
        for (const id of ids) {
          if (data.some(other => other !== item && !other.expired && other.attachments?.some(attachment => attachment.id === id))) continue
          await this.media.remove(owner, record.id, id)
          const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_')
          for (const name of [safe, safe + '.preview']) {
            const file = resolve(root, name)
            if (!safe || dirname(file) !== root) continue
            await unlink(file).catch((error:any) => { if (error.code !== 'ENOENT') throw error })
          }
        }
        item.retentionCleared = true; changed = true
        if (owner === this.onlineUser) this.mainWindow?.webContents.send('signal:message', { ...item, owner: undefined, update: true })
      }
      if (changed) await this.historyStore.write(data)
    })
    this.historyWrites = work; await work
  }

  async runtimeStatus(): Promise<SignalRuntimeStatus> { return this.cli.runtimeStatus() }
  async refreshAccount(id:string) {
    const owner=this.onlineUser, record=(await this.accounts.list()).find(item=>item.id===id&&item.platform==='signal'&&item.signalEngine!=='desktop')
    if(!record || !owner || owner!==this.onlineUser)throw new Error('Signal 账号不可用。')
    if(record.runtimeMode==='paused')throw new Error('请先恢复此账号。')
    await this.start()
    if(record.signalAccount){await this.syncContacts(record.signalAccount);await this.announceUnread(record.signalAccount)}
  }
  async prepareRuntime(): Promise<SignalRuntimeStatus> { return this.cli.prepareRuntime() }

  async listAccounts(): Promise<string[]> {
    await this.start()
    const result = await this.cli.call('listAccounts', {})
    if (!Array.isArray(result)) return []
    return result.map((value) => typeof value === 'string' ? value : (value.number || value.account || '')).filter(Boolean)
  }

  async startLink(): Promise<{ deviceLinkUri: string }> {
    await this.start()
    return this.cli.call('startLink', {})
  }

  async finishLink(deviceLinkUri: string, deviceName = 'HelloDog'): Promise<{ number?: string }> {
    await this.start()
    const result = await this.cli.call('finishLink', { deviceLinkUri, deviceName }, 180000)
    if (!result?.number) throw new Error('Signal 尚未确认关联账号，请刷新账号列表。')
    void this.cli.call('sendSyncRequest', { account: result.number }).catch(() => undefined)
    return result
  }

  async listContacts(account: string): Promise<any[]> {
    if ((await this.recordForSignalAccount(account))?.runtimeMode === 'paused') throw new Error('此 Signal 账号已暂停，请先恢复收消息。')
    await this.start()
    const revision = this.identityRevision
    const result = await Promise.allSettled([
      this.cli.call('listContacts', { account, allRecipients: true, detailed: true }),
      this.cli.call('listGroups', { account })
    ])
    if (revision !== this.identityRevision) return []
    if (result.every(item => item.status === 'rejected')) throw new Error('暂时无法读取 Signal 联系人，请检查该账号是否仍在手机的已关联设备中。')
    const contacts = result[0].status === 'fulfilled' && Array.isArray(result[0].value) ? result[0].value : []
    const groups = result[1].status === 'fulfilled' && Array.isArray(result[1].value) ? result[1].value : []
    const normalized = signalContacts(contacts, groups)
    for (const item of normalized) {
      this.contactArchives.set(account + ':' + item.id, item.archived === true)
      for (const alias of item.aliases) { this.expirations.set(account + ':' + alias, item.expiration || 0); this.contactIdentities.set(account + ':' + alias, item.id) }
    }
    for (const item of normalized) if (item.kind === 'group') this.groupMembers.set(account + ':' + item.id,
      (item.members || []).map(member => this.canonicalPeer(account, member.id)).filter(peer => peer !== this.canonicalPeer(account, account)))
    return normalized
  }

  async syncContacts(account: string) {
    if ((await this.recordForSignalAccount(account))?.runtimeMode === 'paused') throw new Error('此 Signal 账号已暂停，请先恢复收消息。')
    await this.start()
    await this.cli.call('sendSyncRequest', { account })
    return true
  }

  async request(account: string, method: string, params: Record<string, unknown> = {}) {
    const revision = this.identityRevision, owner = this.onlineUser
    const record = await this.recordForSignalAccount(account)
    if (!owner || !record || record.runtimeMode === 'paused') throw new Error('请先打开此 Signal 账号。')
    await this.start()
    if (owner !== this.onlineUser || revision !== this.identityRevision) throw new Error('登录状态已变化。')
    return this.cli.call(method, { ...params, account })
  }

  async markRead(account: string, peer: string) {
    const owner = this.onlineUser, history = await this.loadHistory(account)
    peer = this.canonicalPeer(account, peer)
    const samePeer = (id: string) => this.canonicalPeer(account, id) === peer
    const latest = history.filter(item => samePeer(item.peer)).reduce((max, item) => Math.max(max, item.timestamp), 0)
    if (!owner || owner !== this.onlineUser) throw new Error('登录状态已变化。')
    const prefs = await this.preferences.get(owner, account)
    const previous = prefs.conversations[peer]?.lastReadAt || 0
    const next = await this.preferences.conversation(owner, account, peer, { lastReadAt: latest, markedUnread: false })
    if (prefs.readReceipts && !peer.startsWith('group:')) {
      const timestamps = history.filter(item => samePeer(item.peer) && !item.fromMe && !item.system && item.timestamp > previous).map(item => item.timestamp).slice(-100)
      if (timestamps.length) void this.request(account, 'sendReceipt', { recipient: peer, targetTimestamp: timestamps, type: 'read' }).catch(() => undefined)
    }
    // Expiry starts when read locally; don't retain disappearing text indefinitely.
    const work = this.historyWrites.catch(() => undefined).then(async () => {
      const data = await this.historyStore.read()
      for (const item of data) if (item.owner === owner && item.account === account && samePeer(item.peer) && !item.fromMe && !item.system && item.expiresInSeconds && !item.expiresAt) {
        item.expiresAt = Date.now() + item.expiresInSeconds * 1000
        if (owner === this.onlineUser) this.mainWindow?.webContents.send('signal:message', { ...item, owner: undefined, update: true })
      }
      await this.historyStore.write(data)
    })
    this.historyWrites = work; await work
    await this.announceUnread(account)
    return next
  }

  private async announceUnread(account: string) {
    const owner = this.onlineUser, record = await this.recordForSignalAccount(account)
    if (!owner || !record) return
    const preferences = await this.preferences.get(owner, account)
    const count = (await this.historyStore.read()).filter(item => item.owner === owner && item.account === account && !item.fromMe && !item.system && !item.expired
      && (!item.expiresAt || item.expiresAt > Date.now()) && item.timestamp > (preferences.conversations[this.canonicalPeer(account, item.peer)]?.lastReadAt || 0)).length
    if (owner === this.onlineUser) { updateAccountUnread(record.id,count); this.mainWindow?.webContents.send('accounts:unread', { accountId: record.id, count }) }
  }

  contextForTask(recordId: string, peer: string): TranslationContextItem[] { return this.context(recordId, peer) }

  async submitTask(task: SendTask, authorized: () => boolean): Promise<SignalMessage> {
    let files: Array<{ path: string; attachment: SignalAttachment }> = []
    try {
      await this.start()
      const record = (await this.accounts.list()).find(item => item.id === task.accountId)
      if (!authorized() || !record || record.runtimeMode === 'paused' || record.signalAccount !== task.signalAccount || !task.recipient
        || task.conversationId !== `signal:${task.recipient}`) throw new Error('登录账号或 Signal 发送账号已变化，已阻止发送。')
      await this.media.validate(task.owner, task.accountId, task.signalPayload)
      files = await Promise.all((task.signalPayload?.attachments || []).map(id => this.media.get(task.owner, task.accountId, id)))
    } catch (error: any) { throw new SendNotStartedError(String(error?.message || error)) }

    // Dispatch exactly once. RPC timeout/connection loss is an unknown result,
    // not evidence that the recipient did not receive it.
    const owner = this.onlineUser
    const seconds = this.expirations.get(task.signalAccount! + ':' + task.recipient!) || 0
    const recipients = this.groupMembers.get(task.signalAccount! + ':' + task.recipient!)?.slice()
    const messageFromResult = (value: unknown): SignalMessage => {
      const timestamp = signalSendTimestamp(value)
      return { taskId: task.id, account: task.signalAccount!, peer: task.recipient!, fromMe: true,
        original: task.request.text, translated: task.translated, timestamp, delivery: 'sent',
        attachments: files.map(file => file.attachment), attachmentCount: files.length,
        recipients,
        expiresInSeconds: seconds || undefined, expiresAt: seconds ? timestamp + seconds * 1000 : undefined }
    }
    let result: any
    try {
      if (!authorized() || owner !== this.onlineUser) throw new SendNotStartedError('登录状态已变化。')
      result = await this.cli.call('send', { ...signalSendParameters(task.signalAccount!, task.recipient!, task.translated!),
        ...(files.length ? { attachment: files.map(file => file.path), ...(task.signalPayload?.voiceNote ? { voiceNote: true } : {}) } : {}) }, files.length ? 120000 : 30000, value => {
        if (!authorized() || owner !== this.onlineUser) return
        void (async () => {
          const message = messageFromResult(value)
          await this.rememberMessage(owner, message)
          if (!authorized()) return
          await this.sendConfirmed?.(owner, task.id, message)
          this.mainWindow?.webContents.send('signal:message', message)
          void this.translateMessage(task.accountId,message).catch(()=>undefined)
        })().catch(() => undefined)
      })
    } catch (error: any) {
      if (/timeout|连接已断开|stopped|exited/i.test(error.message)) throw new SendPendingError()
      throw error
    }
    const msg = messageFromResult(result)
    if (authorized()) {
      const owner = this.onlineUser
      await this.rememberMessage(owner, msg)
      if (!authorized() || owner !== this.onlineUser) return msg
      this.remember(task.accountId, task.recipient!, { role: 'outgoing', text: task.translated! })
      this.mainWindow?.webContents.send('signal:message', msg)
      void this.translateMessage(task.accountId,msg).catch(()=>undefined)
    }
    return msg
  }

  async reconcileTask(task: SendTask): Promise<unknown | null> {
    await this.historyWrites.catch(() => undefined)
    return (await this.historyStore.read()).find(item => item.owner === task.owner && item.taskId === task.id && item.account === task.signalAccount && item.fromMe) || null
  }

  private async runtimeForRecord(recordId?: string, conversationId?: string): Promise<RuntimeSettings> {
    const base = await this.settings.runtime()
    if (!recordId) return base
    const all = await this.accounts.list()
    const record = all.find((item) => item.id === recordId)
    if (!record) return base
    const contact = conversationId ? record.contactLanguages?.[conversationId] : undefined
    return {
      ...base,
      translationQuality: mergeQuality(mergeQuality(base.translationQuality, record.translationQuality),contact?.translationQuality),
      historyMode: record.historyMode || base.historyMode,
      translationsVisible: record.translationsVisible !== false,
      localLanguage: record.localLanguage || base.localLanguage,
      targetLanguage: contact?.language || record.targetLanguage || base.targetLanguage,
      receiveAutoTranslate: record.receiveAutoTranslate ?? base.receiveAutoTranslate,
      sendAutoTranslate: record.sendAutoTranslate ?? base.sendAutoTranslate,
      blockChineseSend: record.blockChineseSend ?? base.blockChineseSend,
      groupTranslate: record.groupTranslate ?? base.groupTranslate,
      fontSize: Number(record.fontSize || base.fontSize),
      translationColor: record.translationColor || base.translationColor,
      conversationId,
      conversationName: contact?.name,
      contactLanguageSource: contact?.source || 'default'
    }
  }

  private async recordForSignalAccount(signalAccount: string): Promise<AccountRecord | undefined> {
    const all = await this.accounts.list()
    return all.find((item) => item.platform === 'signal' && item.signalEngine !== 'desktop' && item.signalAccount === signalAccount)
  }

  /** Resolve a persisted message, not text supplied by the renderer. Display
   * translations are independent of the native send and never resend it. */
  async translateMessage(recordId:string, identity:{account:string;peer:string;timestamp:number;fromMe:boolean}, manual=false):Promise<string|undefined> {
    const owner=this.onlineUser, record=await this.recordForSignalAccount(identity.account)
    if(!owner||record?.id!==recordId||owner!==this.onlineUser)throw new Error('Signal 消息与账号不匹配。')
    await this.historyWrites.catch(() => undefined)
    const message=(await this.historyStore.read()).find(item=>item.owner===owner&&item.account===identity.account&&item.peer===identity.peer&&item.timestamp===identity.timestamp&&item.fromMe===Boolean(identity.fromMe))
    if(!message||message.expired||message.system||(message.expiresAt||Infinity)<=Date.now())return
    if(message.fromMe&&message.taskId&&message.translated&&message.translated!==message.original)return message.translated
    const runtime=await this.runtimeForRecord(recordId,'signal:'+message.peer)
    if(!manual&&runtime.translationsVisible===false)return
    if(!message.original||!/\p{L}/u.test(message.original))return
    const request={text:message.original,sourceLanguage:'auto',targetLanguage:runtime.localLanguage,accountId:recordId,conversationId:'signal:'+message.peer,messageId:message.taskId||`${message.peer}:${message.timestamp}`,context:this.context(recordId,message.peer),quality:runtime.translationQuality}
    if(alreadyInTargetLanguage({...request,quality:undefined}))return
    let translated=await this.translator.cached(request)
    if(translated===undefined&&(manual||runtime.receiveAutoTranslate&&runtime.historyMode!=='manual'&&(runtime.historyMode==='visible'||message.timestamp>=this.startedAt)&&(!message.peer.startsWith('group:')||runtime.groupTranslate)))translated=await this.translator.translateIncoming(request,manual)
    if(owner!==this.onlineUser)throw new Error('登录状态已变化。')
    if(translated!==undefined && (message.expiresAt||Infinity)>Date.now()){
      const saved=await this.rememberMessage(owner,{...message,...(message.fromMe?{displayTranslated:translated}:{translated})})
      if(!saved.expired&&owner===this.onlineUser)this.mainWindow?.webContents.send('signal:message',{...saved,update:true})
      return saved.expired?undefined:translated
    }
  }

  private key(recordId: string, peer: string): string { return `${recordId}\u241f${peer}` }

  private context(recordId: string, peer: string): TranslationContextItem[] {
    return (this.recent.get(this.key(recordId, peer)) || []).slice(-4)
  }

  private remember(recordId: string, peer: string, item: TranslationContextItem): void {
    const key = this.key(recordId, peer)
    const items = [...(this.recent.get(key) || []), item].slice(-6)
    this.recent.set(key, items)
  }

  private async onReceive(params: any): Promise<void> {
    const revision = this.identityRevision
    const owner = this.onlineUser
    if (!this.onlineUser) return
    const stillCurrent = () => Boolean(this.onlineUser) && revision === this.identityRevision
    const envelope = params?.envelope || params?.result?.envelope
    if (!envelope) return
    const account = params?.account || params?.result?.account || ''
    if(envelope.typingMessage) {
      const record=await this.recordForSignalAccount(account), value=readSignalTyping(account,envelope)
      if(!stillCurrent()||!record||record.runtimeMode==='paused'||!value)return
      value.peer=this.canonicalPeer(account,value.peer);value.sender=this.canonicalPeer(account,value.sender)
      this.typing.update(value)
      this.mainWindow?.webContents.send('signal:typing',value)
      return
    }
    if (envelope.receiptMessage) {
      const receipt = envelope.receiptMessage
      const sender = this.canonicalPeer(account, signalEnvelopePeer(envelope))
      if (!sender) return
      const work = this.historyWrites.catch(() => undefined).then(async () => {
        const data = await this.historyStore.read()
        for (const item of data) if (item.owner === owner && item.account === account && item.fromMe && receipt.timestamps?.includes(item.timestamp)) {
          const group = item.peer.startsWith('group:')
          const recipients = group ? item.recipients || this.groupMembers.get(account + ':' + item.peer) || [] : [this.canonicalPeer(account, item.peer)]
          if (!recipients.includes(sender)) continue
          if (receipt.isRead || receipt.isViewed) item.readBy = [...new Set([...(item.readBy || []), sender])]
          if (receipt.isDelivery || receipt.isRead || receipt.isViewed) item.deliveredTo = [...new Set([...(item.deliveredTo || []), sender])]
          if (recipients.every(peer => item.readBy?.includes(peer))) item.delivery = 'read'
          else if (item.delivery !== 'read' && recipients.every(peer => item.deliveredTo?.includes(peer))) item.delivery = 'delivered'
          if (stillCurrent()) this.mainWindow?.webContents.send('signal:message', { ...item, owner: undefined, update: true })
        }
        await this.historyStore.write(data)
      })
      this.historyWrites = work; await work; return
    }
    const data = envelope.dataMessage || envelope.syncMessage?.sentMessage
    const attachmentCount = Array.isArray(data?.attachments) ? data.attachments.length : 0
    const text = data?.message || (attachmentCount ? '' : data?.isExpirationUpdate ? `限时消息已${data.expiresInSeconds ? '设为 ' + data.expiresInSeconds + ' 秒' : '关闭'}` : '')
    if (!text && !attachmentCount) return
    const source = signalEnvelopePeer(envelope)
    if (!source) return
    if (data.isExpirationUpdate || data.expiresInSeconds) this.expirations.set(account + ':' + source, Number(data.expiresInSeconds) || 0)
    const record = await this.recordForSignalAccount(account)
    if (!stillCurrent() || !record || record.runtimeMode === 'paused') return
    const recordId = record.id
    const conversationId = `signal:${source}`
    if(!envelope.syncMessage?.sentMessage){
      const sender=this.canonicalPeer(account,String(envelope.sourceNumber||envelope.sourceUuid||envelope.source||'').replace(/^aci:/,''))
      const stopped={account,peer:this.canonicalPeer(account,source),sender,started:false,timestamp:Number(data.timestamp||envelope.timestamp||Date.now()),expiresAt:Date.now()+15000}
      this.typing.update(stopped);this.mainWindow?.webContents.send('signal:typing',stopped)
    }

    if (recordId && !envelope.syncMessage?.sentMessage) {
      const detected = detectContactLanguage(text)
      if (detected) {
        const runtimeBefore = await this.runtimeForRecord(recordId, conversationId)
        if (detected !== runtimeBefore.localLanguage) {
          await this.accounts.updateContactLanguage(recordId, conversationId, detected, source, 'auto')
          this.mainWindow?.webContents.send('accounts:contact-language', {
            accountId: recordId,
            conversationId,
            language: detected,
            name: source,
            source: 'auto'
          })
        }
      }
    }

    const runtime = await this.runtimeForRecord(recordId, conversationId)
    const context = recordId ? this.context(recordId, source) : []
    if (!stillCurrent()) return
    const timestamp = Number(data.timestamp || envelope.timestamp || Date.now())
    const messageId = `${source}:${timestamp}`
    const receiptKey = `${recordId}:${messageId}:${Boolean(envelope.syncMessage?.sentMessage)}`
    if (this.receivedIds.has(receiptKey)) return
    // Display requests are resolved from the saved message below.
    const originalMessage: SignalMessage = { account, peer: source, fromMe: Boolean(envelope.syncMessage?.sentMessage), original: text, timestamp, senderName: envelope.sourceName || undefined, attachmentCount,
      system: data.isExpirationUpdate === true, expiresInSeconds: Number(data.expiresInSeconds) || undefined,
      attachments: data.viewOnce ? [] : normalizeAttachments(data.attachments) }
    if (originalMessage.fromMe && originalMessage.expiresInSeconds) originalMessage.expiresAt = Number(data.expirationStartTimestamp || timestamp) + originalMessage.expiresInSeconds * 1000
    if (data.viewOnce) originalMessage.original = '[阅后即焚附件，请在手机中查看]'
    this.receivedIds.add(receiptKey)
    let saved: SignalMessage
    try { saved = await this.rememberMessage(owner, originalMessage) } catch (error) { this.receivedIds.delete(receiptKey); throw error }
    if (!stillCurrent()) return
    this.mainWindow?.webContents.send('signal:message', saved)
    const preferences = await this.preferences.get(owner, account)
    const preferencePeer = this.canonicalPeer(account, source)
    const peerPreference = preferences.conversations[preferencePeer]
    if (!originalMessage.fromMe && !preferences.keepArchived && (peerPreference?.archived ?? this.contactArchives.get(account + ':' + preferencePeer))) await this.preferences.conversation(owner, account, preferencePeer, { archived: false })
    await this.announceUnread(account)
    if (!saved.fromMe && preferences.notifications !== 'off' && !(peerPreference?.mutedUntil && peerPreference.mutedUntil > Date.now())) notifyAccount(recordId, record.label, { always: preferences.notifications === 'always', silent: !preferences.sound, hideNames: preferences.hideNames })
    if (recordId) this.remember(recordId, source, {role:saved.fromMe?'outgoing':'incoming',text})
    await this.translateMessage(recordId,saved).catch(()=>undefined)
    if (this.receivedIds.size > 20000) this.receivedIds.delete(this.receivedIds.values().next().value!)

  }
}
