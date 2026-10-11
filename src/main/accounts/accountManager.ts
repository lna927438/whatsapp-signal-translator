import { accountNames } from '../../shared/accountConfig'
import { orderedAccounts } from '../../shared/accountOrder'
import { normalizeQuality } from '../../shared/translationPolicy'
import { translationChannel } from '../../shared/translationChannels'
import { safeStorage } from 'electron'
import { normalizeProxy } from '../network/accountProxy'
import { randomUUID } from 'crypto'
import type { AccountRecord, ContactLanguagePreference, Platform } from '../types'
import { JsonStore } from '../storage/jsonStore'

export class AccountManager {
  private readonly store = new JsonStore<Array<AccountRecord & { proxySecret?: string }>>('accounts.json', [])
  private writeChain: Promise<unknown> = Promise.resolve()

  async list(): Promise<AccountRecord[]> {
    return (await this.store.read()).map(record => this.publicRecord(record))
  }

  async retireLegacyNotes(): Promise<void> {
    await this.serialized(async () => {
      const records = await this.store.read()
      if (!records.some(record => 'note' in record || 'caption' in record)) return
      await this.store.write(records.map(record => { const {note,caption,...rest} = record as typeof record & {note?:unknown;caption?:unknown}; return rest }))
    })
  }

  async add(platform: Platform, label?: string, signalAccount?: string, options: Partial<AccountRecord> & { proxy?: any } = {}): Promise<AccountRecord> {
    if (!['whatsapp', 'signal', 'telegram'].includes(platform)) throw new Error('请选择支持的应用。')
    return this.serialized(async () => {
      const accounts = await this.store.read()
      const count = accounts.filter((a) => a.platform === platform).length + 1
      const record: AccountRecord = {
        id: randomUUID(),
        platform,
        label: label?.trim() || `${platform === 'whatsapp' ? 'WhatsApp' : platform === 'telegram' ? 'Telegram' : 'Signal'} ${count}`,
        signalAccount,
        localLanguage: 'zh-CN',
        targetLanguage: 'en-US',
        receiveAutoTranslate: true,
        sendAutoTranslate: true,
        blockChineseSend: true,
        groupTranslate: false,
        fontSize: 13,
        translationColor: '#c8d4e4',
        contactLanguages: {},
        createdAt: Date.now()
      }
      Object.assign(record, this.preparePatch(options))
      accounts.push(record)
      await this.store.write(accounts)
      return this.publicRecord(record)
    })
  }

  async addBatch(platform: Platform, label: string, count: number, options: any): Promise<AccountRecord[]> {
    if (!['whatsapp', 'signal', 'telegram'].includes(platform)) throw new Error('请选择支持的应用。')
    const names = accountNames(label, count)
    const prepared = this.preparePatch(options)
    return this.serialized(async () => {
      const all = await this.store.read()
      const created = names.map(name => ({ localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, blockChineseSend: true, groupTranslate: false, fontSize: 13, translationColor: '#7eada0', ...prepared, id: randomUUID(), platform, label: name, createdAt: Date.now() }))
      await this.store.write([...all, ...created])
      return created.map(record => this.publicRecord(record))
    })
  }

  async remove(id: string): Promise<void> {
    await this.serialized(async () => {
      const accounts = await this.store.read()
      await this.store.write(accounts.filter((a) => a.id !== id))
    })
  }

  async reorder(platform: Platform, ids: string[]): Promise<AccountRecord[]> {
    if (!['whatsapp', 'signal', 'telegram'].includes(platform) || !Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('账号顺序无效，请重试。')
    return this.serialized(async () => {
      const accounts = await this.store.read(), platformRows = accounts.filter(account => account.platform === platform)
      if (ids.length !== platformRows.length || platformRows.some(account => !ids.includes(account.id))) throw new Error('账号列表已变化，请重试。')
      const order = new Map(ids.map((id, index) => [id, index]))
      for (const account of platformRows) account.tabOrder = order.get(account.id)
      await this.store.write(accounts)
      return accounts.map(record => this.publicRecord(record))
    })
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord | undefined> {
    return this.serialized(async () => {
      const accounts = await this.store.read()
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      const previousPinned = accounts[i].pinned
      accounts[i] = { ...accounts[i], ...this.preparePatch(patch), id: accounts[i].id, platform: accounts[i].platform }
      if (patch.pinned !== undefined && accounts[i].pinned !== previousPinned) {
        const others = orderedAccounts(accounts.filter(account => account.platform === accounts[i].platform && account.id !== id))
        const ordered = accounts[i].pinned ? [accounts[i], ...others] : [...others, accounts[i]]
        ordered.forEach((account, index) => { account.tabOrder = index })
      }
      await this.store.write(accounts)
      return this.publicRecord(accounts[i])
    })
  }

  async updateContactLanguage(
    id: string,
    conversationId: string,
    language: string,
    name?: string,
    source: ContactLanguagePreference['source'] = 'manual'
  ): Promise<AccountRecord | undefined> {
    const key = String(conversationId || '').trim()
    if (!key || !language) return undefined
    return this.serialized(async () => {
      const accounts = await this.store.read()
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      const contactLanguages = { ...(accounts[i].contactLanguages || {}) }
      const existing = contactLanguages[key]
      // A manual choice always wins over automatic learning.
      if (source === 'auto' && existing?.source === 'manual') return this.publicRecord(accounts[i])
      contactLanguages[key] = { ...existing, language, name: name || existing?.name, source, updatedAt: Date.now() }
      accounts[i] = { ...accounts[i], contactLanguages }
      await this.store.write(accounts)
      return this.publicRecord(accounts[i])
    })
  }

  private publicRecord(record: AccountRecord & { proxySecret?: string }): AccountRecord {
    const { proxySecret, note, caption, ...result } = record as typeof record & {note?:unknown;caption?:unknown}
    return { ...result, proxy: result.proxy ? { ...result.proxy, hasPassword: Boolean(proxySecret) } : undefined }
  }

  async updateContactQuality(id: string, conversationId: string, quality: unknown): Promise<AccountRecord> {
    const key = String(conversationId || '').trim()
    if (!key || key.length > 300) throw new Error('请先选择联系人。')
    const value = normalizeQuality(quality)
    return this.serialized(async () => {
      const rows = await this.store.read(), record = rows.find(item => item.id === id)
      if (!record) throw new Error('账号不存在。')
      record.contactLanguages = { ...record.contactLanguages, [key]: { ...record.contactLanguages?.[key], translationQuality: value, updatedAt: Date.now() } }
      await this.store.write(rows)
      return this.publicRecord(record)
    })
  }

  async proxyPassword(id: string): Promise<string> {
    const record = (await this.store.read()).find(item => item.id === id)
    if (!record?.proxySecret) return ''
    return safeStorage.decryptString(Buffer.from(record.proxySecret, 'base64'))
  }

  private preparePatch(input: any): Partial<AccountRecord> & { proxySecret?: string } {
    const out: any = {}
    if (input.translationProvider !== undefined) out.translationProvider = translationChannel(input.translationProvider)
    if (input.signalEngine !== undefined) { if (!['cli','desktop'].includes(input.signalEngine)) throw new Error('Signal 客户端类型无效。'); out.signalEngine = input.signalEngine }
    if (input.translationQuality !== undefined) out.translationQuality = normalizeQuality(input.translationQuality)
    if ('historyMode' in input) out.historyMode = ['new','manual','visible'].includes(input.historyMode as string) ? input.historyMode : undefined
    if (input.runtimeMode !== undefined) {
      if (!['receiving', 'paused'].includes(input.runtimeMode)) throw new Error('运行模式无效。')
      out.runtimeMode = input.runtimeMode
    }
    for (const key of ['pinned','group','label','signalAccount','localLanguage','targetLanguage','receiveAutoTranslate','sendAutoTranslate','blockChineseSend','groupTranslate','fontSize','translationColor','translationsVisible','zoomFactor','toolbarCollapsed']) {
      if (input[key] !== undefined) out[key] = input[key]
    }
    if (input.translationColor !== undefined && !/^#[0-9a-f]{6}$/i.test(input.translationColor)) throw new Error('请选择有效的译文颜色。')
    if (out.group !== undefined) out.group = String(out.group).trim().slice(0, 30)
    if (out.pinned !== undefined) out.pinned = out.pinned === true
    if (out.label !== undefined) { out.label = String(out.label).trim().slice(0, 60); if (!out.label) throw new Error('请输入账号名称。') }
    if (input.proxy !== undefined) {
      out.proxy = normalizeProxy(input.proxy)
      if (input.proxy.clearPassword) out.proxySecret = ''
      if (input.proxy.password) {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，无法保存代理密码。')
        out.proxySecret = safeStorage.encryptString(String(input.proxy.password)).toString('base64')
      }
    }
    return out
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }
}
