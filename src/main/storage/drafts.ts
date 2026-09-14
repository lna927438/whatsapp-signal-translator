import { createHash } from 'crypto'
import { JsonStore } from './jsonStore'
export interface DraftTarget { accountId: string; conversationId: string; targetKey?: string }
type Draft = DraftTarget & { owner: string; text: string; updatedAt: number }
export class Drafts {
  private store = new JsonStore<Record<string, Draft>>('drafts-v1.json', {}, true)
  private chain: Promise<unknown> = Promise.resolve()
  private key(owner: string, target: DraftTarget) {
    if (!owner || !target?.accountId || !target.conversationId) throw new Error('草稿缺少账号或对话。')
    return createHash('sha256').update(JSON.stringify([owner, target.accountId, target.targetKey || target.conversationId])).digest('hex')
  }
  async get(owner: string, target: DraftTarget) {
    await this.chain.catch(() => undefined)
    return (await this.store.read())[this.key(owner, target)]?.text || ''
  }
  save(owner: string, target: DraftTarget, text: string, expected?: string) {
    const key = this.key(owner, target)
    if (typeof text !== 'string' || text.length > 20000) throw new Error('草稿过长。')
    const work = this.chain.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      if (expected !== undefined && data[key]?.text.trim() !== expected.trim()) return
      if (text) data[key] = { ...target, owner, text, updatedAt: Date.now() }
      else delete data[key]
      await this.store.write(data)
    })
    this.chain = work
    return work
  }
  async flush() { await this.chain }
}
