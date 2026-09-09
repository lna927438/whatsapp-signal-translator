import { randomUUID } from 'crypto'
import type { AccountRecord, Platform } from '../types'
import { JsonStore } from '../storage/jsonStore'

export class AccountManager {
  private readonly store = new JsonStore<AccountRecord[]>('accounts.json', [])

  async list(): Promise<AccountRecord[]> {
    return this.store.read()
  }

  async add(platform: Platform, label?: string, signalAccount?: string): Promise<AccountRecord> {
    const accounts = await this.list()
    const count = accounts.filter((a) => a.platform === platform).length + 1
    const record: AccountRecord = {
      id: randomUUID(),
      platform,
      label: label?.trim() || `${platform === 'whatsapp' ? 'WhatsApp' : 'Signal'} ${count}`,
      signalAccount,
      createdAt: Date.now()
    }
    accounts.push(record)
    await this.store.write(accounts)
    return record
  }

  async remove(id: string): Promise<void> {
    const accounts = await this.list()
    await this.store.write(accounts.filter((a) => a.id !== id))
  }

  async update(id: string, patch: Partial<AccountRecord>): Promise<AccountRecord | undefined> {
    const accounts = await this.list()
    const i = accounts.findIndex((a) => a.id === id)
    if (i < 0) return undefined
    accounts[i] = { ...accounts[i], ...patch, id: accounts[i].id, platform: accounts[i].platform }
    await this.store.write(accounts)
    return accounts[i]
  }
}
