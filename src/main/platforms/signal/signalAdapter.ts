import { notifyAccount } from '../../desktopRuntime'
import { BrowserWindow } from 'electron'
import { SignalCli } from './signalCli'
import type { SignalRuntimeStatus } from './signalRuntime'
import type { AccountRecord, RuntimeSettings, TranslationContextItem } from '../../types'
import { TranslationEngine } from '../../translation/translationEngine'
import { detectContactLanguage } from '../../translation/languageDetection'
import { SettingsStore } from '../../storage/settingsStore'
import { AccountManager } from '../../accounts/accountManager'

import { SendNotStartedError, type SendTask } from '../../translation/sendTasks'

export interface SignalMessage {
  taskId?: string
  account: string
  peer: string
  fromMe: boolean
  original: string
  translated?: string
  timestamp: number
}

export class SignalAdapter {
  private startedAt = Date.now()
  private readonly receivedIds = new Set<string>()
  private readonly cli = new SignalCli()
  private readonly translator: TranslationEngine
  private readonly settings = new SettingsStore()
  private readonly accounts = new AccountManager()
  private readonly recent = new Map<string, TranslationContextItem[]>()
  private mainWindow?: BrowserWindow
  private onlineUser = ''
  private identityRevision = 0

  constructor(translator: TranslationEngine) {
    this.translator = translator
    this.cli.on('receive', (params) => void this.onReceive(params))
    this.cli.on('runtime', (status: SignalRuntimeStatus) => this.mainWindow?.webContents.send('signal:runtime', status))
    this.cli.on('stderr', (message: string) => this.mainWindow?.webContents.send('signal:diagnostic', message))
  }

  attachMainWindow(window: BrowserWindow): void { this.mainWindow = window }
  setOnlineUser(userId: string): void {
    if (userId === this.onlineUser) return
    this.onlineUser = userId
    this.identityRevision += 1
    this.cli.stop()
    this.recent.clear()
  }
  async start(): Promise<void> {
    const revision = this.identityRevision
    if (!this.onlineUser) throw new Error('请先登录在线账号。')
    await this.cli.start()
    if (!this.onlineUser || revision !== this.identityRevision) {
      this.cli.stop()
      throw new Error('登录状态已变化。')
    }
  }
  stop(): void { this.cli.stop() }

  async runtimeStatus(): Promise<SignalRuntimeStatus> { return this.cli.runtimeStatus() }
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

  async finishLink(deviceLinkUri: string, deviceName = '实时翻译器'): Promise<{ number?: string }> {
    await this.start()
    return this.cli.call('finishLink', { deviceLinkUri, deviceName }, 180000)
  }

  async listContacts(account: string): Promise<any[]> {
    await this.start()
    const result = await this.cli.call('listContacts', { account, recipients: [], allRecipients: true, detailed: true, internal: false })
    return Array.isArray(result) ? result : []
  }

  contextForTask(recordId: string, peer: string): TranslationContextItem[] { return this.context(recordId, peer) }

  async submitTask(task: SendTask, authorized: () => boolean): Promise<SignalMessage> {
    try {
      await this.start()
      const record = (await this.accounts.list()).find(item => item.id === task.accountId)
      if (!authorized() || !record || record.signalAccount !== task.signalAccount || !task.recipient
        || task.conversationId !== `signal:${task.recipient}`) throw new Error('登录账号或 Signal 发送账号已变化，已阻止发送。')
    } catch (error: any) { throw new SendNotStartedError(String(error?.message || error)) }

    // Dispatch exactly once. RPC timeout/connection loss is an unknown result,
    // not evidence that the recipient did not receive it.
    const result = await this.cli.call('send', { account: task.signalAccount, recipients: [task.recipient!], message: task.translated })
    const msg: SignalMessage = { taskId: task.id, account: task.signalAccount!, peer: task.recipient!, fromMe: true,
      original: task.request.text, translated: task.translated, timestamp: Number(result?.timestamp || Date.now()) }
    if (authorized()) {
      this.remember(task.accountId, task.recipient!, { role: 'outgoing', text: task.translated! })
      this.mainWindow?.webContents.send('signal:message', msg)
    }
    return msg
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
    return all.find((item) => item.platform === 'signal' && item.signalAccount === signalAccount)
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
    if (!this.onlineUser) return
    const stillCurrent = () => Boolean(this.onlineUser) && revision === this.identityRevision
    const envelope = params?.envelope || params?.result?.envelope
    if (!envelope) return
    const account = params?.account || params?.result?.account || ''
    const data = envelope.dataMessage || envelope.syncMessage?.sentMessage
    const text = data?.message
    if (!text) return
    const source = envelope.sourceNumber || envelope.source || data.destinationNumber || data.destination || ''
    const record = await this.recordForSignalAccount(account)
    if (!stillCurrent()) return
    const recordId = record?.id || ''
    const conversationId = `signal:${source}`

    if (recordId) {
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
    const request = { text, sourceLanguage: 'auto', targetLanguage: runtime.localLanguage, accountId: recordId, conversationId, messageId, context }
    let translated = await this.translator.cached(request).catch(() => undefined)
    if (translated === undefined && runtime.receiveAutoTranslate && !envelope.syncMessage?.sentMessage
      && runtime.historyMode !== 'manual' && (runtime.historyMode === 'visible' || timestamp >= this.startedAt)
      && (!data.groupInfo || runtime.groupTranslate)) translated = await this.translator.translate(request).catch(() => undefined)
    this.receivedIds.add(receiptKey)
    if (this.receivedIds.size > 20000) this.receivedIds.delete(this.receivedIds.values().next().value!)

    if (!stillCurrent()) return
    if (recordId) this.remember(recordId, source, { role: envelope.syncMessage?.sentMessage ? 'outgoing' : 'incoming', text })
    const msg: SignalMessage = {
      account,
      peer: source,
      fromMe: Boolean(envelope.syncMessage?.sentMessage),
      original: text,
      translated,
      timestamp: Number(data.timestamp || envelope.timestamp || Date.now())
    }
    this.mainWindow?.webContents.send('signal:message', msg)
    if (!msg.fromMe && recordId) notifyAccount(recordId, record?.label || 'Signal')
  }
}
