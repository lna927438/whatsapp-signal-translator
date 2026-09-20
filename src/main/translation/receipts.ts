import { JsonStore } from '../storage/jsonStore'
import { createHash } from 'crypto'
import type { TranslationRequest } from '../types'
import { qualityKey } from '../../shared/translationPolicy'

export type BillingState = 'queued' | 'pending' | 'charged' | 'free' | 'cached' | 'failed'
export interface TranslationReceipt {
  contentExpired?: boolean
  contentExpiredReason?: string
  contextCleared?: boolean
  owner: string
  requestId: string
  request: TranslationRequest
  provider: string
  sourceCharacters: number
  chargedCharacters?: number
  balanceAfter?: number
  state: BillingState
  lastAccess: 'request' | 'cache' | 'correction'
  translated?: string
  correction?: string
  correctionSource?: 'manual' | 'cloud-repair'
  queueWaitMs?: number
  providerMs?: number
  error?: string
  missingRetries?: number
  missingRetryWindowAt?: number
  missingRetryWindowCount?: number
  retryRequestId?: string
  createdAt: number
  updatedAt: number
}

export class TranslationReceipts {
  private store = new JsonStore<TranslationReceipt[]>('translation-receipts-v1.json', [], true)
  private chain: Promise<unknown> = Promise.resolve()
  private mutate<T>(run: (data: TranslationReceipt[]) => T): Promise<T> {
    const work = this.chain.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      const result = run(data)
      await this.store.write(data)
      return structuredClone(result)
    })
    this.chain = work
    return work
  }
  async list(owner: string): Promise<TranslationReceipt[]> {
    await this.chain.catch(() => undefined)
    return (await this.store.read()).filter(item => item.owner === owner).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  async get(owner: string, requestId: string) { return (await this.list(owner)).find(item => item.requestId === requestId) }
  applySemanticRepair(owner: string, requestId: string, previousTranslation: string, translation: string, authorized: () => boolean) {
    return this.mutate(data => {
      if (!authorized()) throw new Error('登录状态已变化。')
      const receipt = data.find(item => item.owner === owner && item.requestId === requestId)
      if (!receipt || receipt.contentExpired || receipt.contextCleared) throw new Error('原消息已删除或过期，不能修复译文。')
      // A user edit made while the repair is in flight always wins. Settlement,
      // request identity, original output and retention remain untouched.
      if (receipt.correction === undefined && receipt.translated === previousTranslation && receipt.state === 'charged'
        && receipt.chargedCharacters === receipt.sourceCharacters) {
        receipt.correction = translation; receipt.correctionSource = 'cloud-repair'; receipt.lastAccess = 'correction'; receipt.error = undefined; receipt.updatedAt = Date.now()
      }
      return receipt
    })
  }
  retryMissing(owner: string, requestId: string, limit: number) {
    return this.mutate(data => {
      const receipt = data.find(item => item.owner === owner && item.requestId === requestId)
      if (!receipt || receipt.state !== 'pending' || receipt.contentExpired || receipt.contextCleared) return undefined
      const now = Date.now()
      receipt.missingRetryWindowAt ??= now
      receipt.missingRetryWindowCount ??= receipt.missingRetries || 0
      if (now - receipt.missingRetryWindowAt >= 5 * 60000) { receipt.missingRetryWindowAt = now; receipt.missingRetryWindowCount = 0 }
      if (receipt.missingRetryWindowCount >= limit) return undefined
      receipt.state = 'queued'; receipt.error = undefined; receipt.missingRetries = (receipt.missingRetries || 0) + 1; receipt.missingRetryWindowCount++; receipt.updatedAt = now
      return receipt.request
    })
  }
  retryFailedOutgoing(owner: string, requestId: string) {
    return this.mutate(data => {
      const receipt = data.find(item => item.owner === owner && item.requestId === requestId)
      if (!receipt || !requestId.startsWith('send-') || receipt.state !== 'failed' || receipt.chargedCharacters !== 0
        || receipt.contentExpired || receipt.contextCleared) throw new Error('原翻译尚未确认失败，不能创建重试。')
      receipt.retryRequestId ??= 'send-retry-' + createHash('sha256').update(requestId).digest('hex')
      receipt.updatedAt = Date.now()
      return { ...receipt.request, requestId: receipt.retryRequestId }
    })
  }
  prepare(owner: string, provider: string, request: TranslationRequest): Promise<TranslationReceipt> {
    if (!request.requestId) throw new Error('缺少翻译请求编号。')
    return this.mutate(data => {
      const prior = data.find(item => item.owner === owner && item.requestId === request.requestId)
      if (prior) {
        if (prior.contentExpired) throw new Error('此限时消息已过期，不能再次翻译。')
        if (prior.request.text !== request.text || prior.request.targetLanguage !== request.targetLanguage
          || prior.request.sourceLanguage !== request.sourceLanguage || prior.request.accountId !== request.accountId
          || qualityKey(prior.request.quality) !== qualityKey(request.quality)
          || JSON.stringify(prior.request.context || []) !== JSON.stringify(request.context || [])) throw new Error('请求编号已用于不同内容。')
        return prior
      }
      const now = Date.now()
      const receipt: TranslationReceipt = { owner, requestId: request.requestId!, provider,
        request: structuredClone(request), sourceCharacters: Array.from(request.text.trim()).length,
        state: 'queued', lastAccess: 'request', createdAt: now, updatedAt: now }
      data.push(receipt)
      return receipt
    })
  }
  update(owner: string, requestId: string, patch: Partial<Pick<TranslationReceipt, 'state' | 'translated' | 'correction' | 'correctionSource' | 'lastAccess' | 'error' | 'chargedCharacters' | 'balanceAfter' | 'queueWaitMs' | 'providerMs'>>): Promise<TranslationReceipt> {
    return this.mutate(data => {
      const receipt = data.find(item => item.owner === owner && item.requestId === requestId)
      if (!receipt) throw new Error('此翻译记录不存在。')
      Object.assign(receipt, patch, { updatedAt: Date.now() })
      if (receipt.contentExpired) { receipt.translated = undefined; receipt.correction = undefined; receipt.error = receipt.contentExpiredReason || '消息已删除或过期' }
      return receipt
    })
  }
  expireMessage(owner: string, accountId: string, conversationId: string, identity: string, reason = '消息已删除或过期') {
    return this.mutate(data => {
      for (const receipt of data) if (receipt.owner === owner && (receipt.request.accountId || '') === accountId) {
        if ((receipt.request.conversationId || '') === conversationId && receipt.request.context?.length) { receipt.request.context = []; receipt.contextCleared = true }
        if (receipt.request.messageId === identity || receipt.requestId === identity) {
          receipt.contentExpired = true; receipt.request.text = ''; receipt.request.context = []
          receipt.contentExpiredReason = reason
          receipt.translated = undefined; receipt.correction = undefined; receipt.error = reason
          if (receipt.state === 'queued') { receipt.state = 'failed'; receipt.chargedCharacters = 0 }
        }
      }
    })
  }
  async flush() { await this.chain }
}
