import { randomUUID } from 'crypto'
import type { AccountRecord, ContactLanguagePreference, Platform } from '../types'
import { JsonStore } from '../storage/jsonStore'

export class AccountManager {
  private readonly store = new JsonStore<AccountRecord[]>('accounts.json', [])
  private writeChain: Promise<unknown> = Promise.resolve()

  async list(): Promise<AccountRecord[]> {
    return this.store.read()
  }

  async add(platform: Platform, label?: string, signalAccount?: string): Promise<AccountRecord> {
    return this.serialized(async () => {
      const accounts = await this.list()
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
      accounts.push(record)
      await this.store.write(accounts)
      return record
    })
  }

  async remove(id: string): Promise<void> {
    await this.serialized(async () => {
      const accounts = await this.list()
      await this.store.write(accounts.filter((a) => a.id !== id))
    })
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord | undefined> {
    return this.serialized(async () => {
      const accounts = await this.list()
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      accounts[i] = { ...accounts[i], ...patch, id: accounts[i].id, platform: accounts[i].platform }
      await this.store.write(accounts)
      return accounts[i]
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
      const accounts = await this.list()
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0) return undefined
      const contactLanguages = { ...(accounts[i].contactLanguages || {}) }
      const existing = contactLanguages[key]
      // A manual choice always wins over automatic learning.
      if (source === 'auto' && existing?.source === 'manual') return accounts[i]
      contactLanguages[key] = { language, name: name || existing?.name, source, updatedAt: Date.now() }
      accounts[i] = { ...accounts[i], contactLanguages }
      await this.store.write(accounts)
      return accounts[i]
    })
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }
}
