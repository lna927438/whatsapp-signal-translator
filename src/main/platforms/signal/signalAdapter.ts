import { BrowserWindow } from 'electron'
import { SignalCli } from './signalCli'
import type { SignalRuntimeStatus } from './signalRuntime'
import type { RuntimeSettings } from '../../types'
import { TranslationEngine } from '../../translation/translationEngine'
import { SettingsStore } from '../../storage/settingsStore'
import { AccountManager } from '../../accounts/accountManager'

const CHINESE_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

export interface SignalMessage {
  account: string
  peer: string
  fromMe: boolean
  original: string
  translated?: string
  timestamp: number
}

export class SignalAdapter {
  private readonly cli = new SignalCli()
  private readonly translator: TranslationEngine
  private readonly settings = new SettingsStore()
  private readonly accounts = new AccountManager()
  private mainWindow?: BrowserWindow

  constructor(translator: TranslationEngine) {
    this.translator = translator
    this.cli.on('receive', (params) => void this.onReceive(params))
    this.cli.on('runtime', (status: SignalRuntimeStatus) => {
      this.mainWindow?.webContents.send('signal:runtime', status)
    })
    this.cli.on('stderr', (message: string) => {
      this.mainWindow?.webContents.send('signal:diagnostic', message)
    })
  }

  attachMainWindow(window: BrowserWindow): void { this.mainWindow = window }
  async start(): Promise<void> { await this.cli.start() }
  stop(): void { this.cli.stop() }

  async runtimeStatus(): Promise<SignalRuntimeStatus> {
    return this.cli.runtimeStatus()
  }

  async prepareRuntime(): Promise<SignalRuntimeStatus> {
    return this.cli.prepareRuntime()
  }

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
    const result = await this.cli.call('listContacts', {
      account,
      recipients: [],
      allRecipients: true,
      detailed: true,
      internal: false
    })
    return Array.isArray(result) ? result : []
  }

  async send(recordId: string, account: string, recipient: string, original: string): Promise<SignalMessage> {
    await this.start()
    const runtime = await this.runtimeForRecord(recordId)
    if (!runtime.sendAutoTranslate && runtime.blockChineseSend && CHINESE_RE.test(original)) {
      throw new Error('已开启“禁止发送中文”，请先开启发送翻译或改为目标语言。')
    }

    const translated = runtime.sendAutoTranslate
      ? await this.translator.translate({ text: original, sourceLanguage: runtime.localLanguage, targetLanguage: runtime.targetLanguage })
      : original

    if (runtime.blockChineseSend && CHINESE_RE.test(translated)) {
      throw new Error('翻译结果仍包含中文，已阻止发送。请检查目标语言或 API 设置。')
    }

    const result = await this.cli.call('send', { account, recipients: [recipient], message: translated })
    const msg: SignalMessage = {
      account,
      peer: recipient,
      fromMe: true,
      original,
      translated,
      timestamp: Number(result?.timestamp || Date.now())
    }
    this.mainWindow?.webContents.send('signal:message', msg)
    return msg
  }

  private async runtimeForRecord(recordId?: string): Promise<RuntimeSettings> {
    const base = await this.settings.runtime()
    if (!recordId) return base
    const all = await this.accounts.list()
    const record = all.find((item) => item.id === recordId)
    if (!record) return base
    return {
      ...base,
      localLanguage: record.localLanguage || base.localLanguage,
      targetLanguage: record.targetLanguage || base.targetLanguage,
      receiveAutoTranslate: record.receiveAutoTranslate ?? base.receiveAutoTranslate,
      sendAutoTranslate: record.sendAutoTranslate ?? base.sendAutoTranslate,
      blockChineseSend: record.blockChineseSend ?? base.blockChineseSend,
      groupTranslate: record.groupTranslate ?? base.groupTranslate,
      fontSize: Number(record.fontSize || base.fontSize),
      translationColor: record.translationColor || base.translationColor
    }
  }

  private async runtimeForSignalAccount(signalAccount: string): Promise<RuntimeSettings> {
    const all = await this.accounts.list()
    const record = all.find((item) => item.platform === 'signal' && item.signalAccount === signalAccount)
    return this.runtimeForRecord(record?.id)
  }

  private async onReceive(params: any): Promise<void> {
    const envelope = params?.envelope || params?.result?.envelope
    if (!envelope) return
    const account = params?.account || params?.result?.account || ''
    const data = envelope.dataMessage || envelope.syncMessage?.sentMessage
    const text = data?.message
    if (!text) return
    const source = envelope.sourceNumber || envelope.source || data.destinationNumber || data.destination || ''
    const runtime = await this.runtimeForSignalAccount(account)
    const translated = runtime.receiveAutoTranslate
      ? await this.translator.translate({ text, sourceLanguage: 'auto', targetLanguage: runtime.localLanguage }).catch(() => undefined)
      : undefined
    const msg: SignalMessage = {
      account,
      peer: source,
      fromMe: Boolean(envelope.syncMessage?.sentMessage),
      original: text,
      translated,
      timestamp: Number(data.timestamp || envelope.timestamp || Date.now())
    }
    this.mainWindow?.webContents.send('signal:message', msg)
  }
}
