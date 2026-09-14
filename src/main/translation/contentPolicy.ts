import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

export interface ContentExpiry {
  owner: string
  accountId: string
  conversationId: string
  identity: string
  expiresAt: number
  reason: 'message' | 'retention'
  cleaned?: boolean
}
interface PolicyData { entries: Record<string, ContentExpiry>; retention: Record<string, number> }
export const retentionDays = [0, 7, 30, 90] as const

// Tombstones contain no message text. Persist the decision BEFORE scrubbing other
// stores, and retry incomplete cleanup after a crash. Changing a language or a
// request ID must never resurrect content removed for the same platform message.
export class TranslationContentPolicy {
  private store = new JsonStore<PolicyData>('translation-content-policy-v1.json', { entries: {}, retention: {} }, true)
  private chain: Promise<unknown> = Promise.resolve()
  private key(owner: string, account: string, identity: string) {
    return createHash('sha256').update(JSON.stringify([owner, account, identity])).digest('hex')
  }
  private mutate<T>(run: (data: PolicyData) => T): Promise<T> {
    const work = this.chain.catch(() => undefined).then(async () => {
      const data = await this.store.read(), result = run(data)
      await this.store.write(data)
      return result
    })
    this.chain = work
    return work
  }
  async read() { await this.chain; return this.store.read() }
  track(updates: ContentExpiry[]) {
    return this.mutate(data => {
      for (const update of updates) {
        const key = this.key(update.owner, update.accountId, update.identity), prior = data.entries[key]
        if (!prior || update.expiresAt < prior.expiresAt) data.entries[key] = { ...update, cleaned: false }
      }
    })
  }
  async assertAvailable(request: TranslationRequest) {
    const identity = request.messageId || request.requestId
    if (!identity) return
    const entry = (await this.read()).entries[this.key(request.cacheUserId || '', request.accountId || '', identity)]
    if (entry && entry.expiresAt <= Date.now()) throw new Error(entry.reason === 'retention'
      ? '本机译文已按保留期清理，不会自动重新翻译。' : '此消息已删除或过期，不能再次翻译。')
  }
  async due() { return Object.values((await this.read()).entries).filter(item => !item.cleaned && item.expiresAt <= Date.now()) }
  cleaned(entry: ContentExpiry) {
    return this.mutate(data => {
      const current = data.entries[this.key(entry.owner, entry.accountId, entry.identity)]
      if (current?.expiresAt === entry.expiresAt) current.cleaned = true
    })
  }
  async getRetention(owner: string) { return (await this.read()).retention[owner] ?? 30 }
  setRetention(owner: string, days: number) {
    if (!retentionDays.includes(days as any)) throw new Error('无效的本机保留期。')
    return this.mutate(data => { data.retention[owner] = days })
  }
  async flush() { await this.chain }
}
