import { randomUUID } from 'crypto'
import { JsonStore } from './jsonStore'
import type { CharacterLedgerEntry, TranslationProviderName, UserProfile } from '../types'

interface StoredProfile {
  username?: string
  email?: string
  planName?: string
  totalCharacters?: number
  usedCharacters?: number
  registeredAt?: number
  updatedAt?: number
  ledger?: CharacterLedgerEntry[]
}

interface ConsumeMeta {
  provider?: TranslationProviderName
  accountId?: string
  conversationId?: string
  note?: string
}

const DEFAULT_TOTAL_CHARACTERS = 1_000_000
const MAX_LEDGER_ENTRIES = 300
let writeChain: Promise<void> = Promise.resolve()

export class ProfileStore {
  private readonly store = new JsonStore<StoredProfile>('profile.json', {})

  private normalize(raw: StoredProfile): UserProfile {
    const now = Date.now()
    const totalCharacters = Math.max(0, Math.floor(Number(raw.totalCharacters ?? DEFAULT_TOTAL_CHARACTERS)))
    const usedCharacters = Math.max(0, Math.floor(Number(raw.usedCharacters ?? 0)))
    return {
      username: String(raw.username || ''),
      email: String(raw.email || ''),
      planName: String(raw.planName || '高级套餐'),
      totalCharacters,
      usedCharacters,
      remainingCharacters: Math.max(0, totalCharacters - usedCharacters),
      registeredAt: Number(raw.registeredAt || now),
      updatedAt: Number(raw.updatedAt || now),
      ledger: Array.isArray(raw.ledger) ? raw.ledger.slice(0, MAX_LEDGER_ENTRIES) : []
    }
  }

  private stored(profile: UserProfile): StoredProfile {
    return {
      username: profile.username,
      email: profile.email,
      planName: profile.planName,
      totalCharacters: profile.totalCharacters,
      usedCharacters: profile.usedCharacters,
      registeredAt: profile.registeredAt,
      updatedAt: profile.updatedAt,
      ledger: profile.ledger.slice(0, MAX_LEDGER_ENTRIES)
    }
  }

  async get(): Promise<UserProfile> {
    const raw = await this.store.read()
    const profile = this.normalize(raw)
    if (!raw.registeredAt) {
      await this.write(this.stored(profile))
    }
    return profile
  }

  async updateIdentity(patch: { username?: string; email?: string; planName?: string }): Promise<UserProfile> {
    let result!: UserProfile
    await this.mutate((profile) => {
      if (patch.username !== undefined) profile.username = String(patch.username).trim().slice(0, 80)
      if (patch.email !== undefined) profile.email = String(patch.email).trim().slice(0, 160)
      if (patch.planName !== undefined) profile.planName = String(patch.planName).trim().slice(0, 80) || profile.planName
      profile.updatedAt = Date.now()
      result = { ...profile, ledger: [...profile.ledger] }
      return profile
    })
    return result
  }

  async addCharacters(characters: number, note = '字符充值'): Promise<UserProfile> {
    const amount = Math.max(0, Math.floor(Number(characters || 0)))
    if (!amount) throw new Error('充值字符数必须大于 0。')
    let result!: UserProfile
    await this.mutate((profile) => {
      profile.totalCharacters += amount
      profile.updatedAt = Date.now()
      profile.ledger.unshift({
        id: randomUUID(),
        type: 'recharge',
        characters: amount,
        createdAt: Date.now(),
        note
      })
      profile.ledger = profile.ledger.slice(0, MAX_LEDGER_ENTRIES)
      result = { ...profile, remainingCharacters: profile.totalCharacters - profile.usedCharacters, ledger: [...profile.ledger] }
      return profile
    })
    return result
  }

  async consumeCharacters(characters: number, meta: ConsumeMeta = {}): Promise<UserProfile> {
    const amount = Math.max(0, Math.floor(Number(characters || 0)))
    if (!amount) return this.get()
    let result!: UserProfile
    await this.mutate((profile) => {
      const remaining = Math.max(0, profile.totalCharacters - profile.usedCharacters)
      if (remaining < amount) {
        throw new Error(`剩余字符不足。当前剩余 ${remaining.toLocaleString('zh-CN')} 字符，本次需要 ${amount.toLocaleString('zh-CN')} 字符。请前往个人中心充值。`)
      }
      profile.usedCharacters += amount
      profile.updatedAt = Date.now()
      profile.ledger.unshift({
        id: randomUUID(),
        type: 'translation',
        characters: -amount,
        createdAt: Date.now(),
        note: meta.note || 'API 新翻译',
        provider: meta.provider,
        accountId: meta.accountId,
        conversationId: meta.conversationId
      })
      profile.ledger = profile.ledger.slice(0, MAX_LEDGER_ENTRIES)
      result = { ...profile, remainingCharacters: profile.totalCharacters - profile.usedCharacters, ledger: [...profile.ledger] }
      return profile
    })
    return result
  }

  async ensureAvailable(characters: number, reservedCharacters = 0): Promise<UserProfile> {
    const profile = await this.get()
    const amount = Math.max(0, Math.floor(Number(characters || 0)))
    const reserved = Math.max(0, Math.floor(Number(reservedCharacters || 0)))
    const available = Math.max(0, profile.remainingCharacters - reserved)
    if (available < amount) {
      throw new Error(`剩余字符不足。当前可用 ${available.toLocaleString('zh-CN')} 字符，本次需要 ${amount.toLocaleString('zh-CN')} 字符。请前往个人中心充值。`)
    }
    return profile
  }

  private async mutate(mutator: (profile: UserProfile) => UserProfile): Promise<void> {
    let error: unknown
    writeChain = writeChain.then(async () => {
      try {
        const raw = await this.store.read()
        const profile = this.normalize(raw)
        const next = mutator(profile)
        next.remainingCharacters = Math.max(0, next.totalCharacters - next.usedCharacters)
        await this.store.write(this.stored(next))
      } catch (e) {
        error = e
      }
    })
    await writeChain
    if (error) throw error
  }

  private async write(value: StoredProfile): Promise<void> {
    writeChain = writeChain.then(() => this.store.write(value))
    await writeChain
  }
}
