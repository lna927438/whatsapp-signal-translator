import { accountNames } from '../../shared/accountConfig'
import { normalizeQuality } from '../../shared/translationPolicy'
import { safeStorage } from 'electron'
import { normalizeProxy } from '../network/accountProxy'
import { randomUUID } from 'crypto'
import type { AccountRecord, ContactLanguagePreference, Platform } from '../types'
import { JsonStore } from '../storage/jsonStore'

export class AccountManager {
  private readonly store = new JsonStore<Array<AccountRecord & { proxySecret?: string }>>('accounts.json', [])
  private writeChain: Promise<unknown> = Promise.resolve()

  async list(): Promise<AccountRecord[]> {
    return (await this.store.read()).map(({ proxySecret, ...record }) => ({ ...record, proxy: record.proxy ? { ...record.proxy, hasPassword: Boolean(proxySecret) } : undefined }))
  }

  async add(platform: Platform, label?: string, signalAccount?: string, options: Partial<AccountRecord> & { proxy?: any } = {}): Promise<AccountRecord> {
    return this.serialized(async () => {
      const accounts = await this.store.read()
      const count = accounts.filter((a) => a.platform === platform).length + 1
      const record: AccountRecord = {
        id: randomUUID(),
        platform,
        label: label?.trim() || `${platform === 'whatsapp' ? 'WhatsApp' : 'Signal'} ${count}`,
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

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord | undefined> {
    return this.serialized(async () => {
      const accounts = await this.store.read()
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      accounts[i] = { ...accounts[i], ...this.preparePatch(patch), id: accounts[i].id, platform: accounts[i].platform }
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
    const { proxySecret, ...result } = record
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
    if (input.note !== undefined) { if (typeof input.note !== 'string' || input.note.length > 80) throw new Error('账号备注最多 80 个字符。'); out.note = input.note.trim() }
    if (input.caption !== undefined) { if (typeof input.caption !== 'string' || input.caption.length > 120) throw new Error('红色备注最多 120 个字符。'); out.caption = input.caption.trim() }
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
