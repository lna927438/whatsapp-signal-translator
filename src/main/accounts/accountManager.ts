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
      contactLanguages[key] = { language, name: name || existing?.name, source, updatedAt: Date.now() }
      accounts[i] = { ...accounts[i], contactLanguages }
      await this.store.write(accounts)
      return this.publicRecord(accounts[i])
    })
  }

  private publicRecord(record: AccountRecord & { proxySecret?: string }): AccountRecord {
    const { proxySecret, ...result } = record
    return { ...result, proxy: result.proxy ? { ...result.proxy, hasPassword: Boolean(proxySecret) } : undefined }
  }

  async proxyPassword(id: string): Promise<string> {
    const record = (await this.store.read()).find(item => item.id === id)
    if (!record?.proxySecret) return ''
    return safeStorage.decryptString(Buffer.from(record.proxySecret, 'base64'))
  }

  private preparePatch(input: any): Partial<AccountRecord> & { proxySecret?: string } {
    const out: any = {}
    for (const key of ['label','signalAccount','localLanguage','targetLanguage','receiveAutoTranslate','sendAutoTranslate','blockChineseSend','groupTranslate','fontSize','translationColor','translationsVisible','zoomFactor','toolbarCollapsed']) {
      if (input[key] !== undefined) out[key] = input[key]
    }
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
