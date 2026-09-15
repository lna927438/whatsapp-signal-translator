import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function withoutEmoji(value: string) {
  return Array.from(segments.segment(value), item => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(item.segment) ? '' : item.segment).join('').replace(/\s+/g, ' ').trim()
}
// Older WhatsApp builds omitted image-backed emoji. Keep those completed
// message identities on upgrade instead of charging again for an emoji fix.
export function sameMessageText(a: string, b: string) { return a === b || Boolean(withoutEmoji(a) && withoutEmoji(a) === withoutEmoji(b)) }

// Persist BEFORE an API call. A message keeps its first context across DOM changes/restarts.
export class MessageRequests {
  private store = new JsonStore<Record<string, TranslationRequest>>('message-requests-v1.json', {}, true)
  private chain: Promise<unknown> = Promise.resolve()
  private matches(a: TranslationRequest, b: TranslationRequest) {
    return (a.cacheUserId||'')===(b.cacheUserId||'') && a.accountId===b.accountId && a.messageId===b.messageId
      && (a.sourceLanguage||'auto')===(b.sourceLanguage||'auto') && a.targetLanguage===b.targetLanguage && sameMessageText(a.text,b.text)
  }
  async lookup(request: TranslationRequest): Promise<TranslationRequest | undefined> {
    if (!request.messageId || request.requestId) return undefined
    // Retry the actual durable read after a transient write failure. A rejected
    // queue tail is not evidence that the saved file remains unreadable.
    await this.chain.catch(() => undefined)
    return Object.values(await this.store.read()).find(item => this.matches(item,request))
  }
  prepare(request: TranslationRequest): Promise<TranslationRequest> {
    if (!request.messageId || request.requestId) return Promise.resolve(request)
    // Platform message IDs include the peer identity. A display-name change
    // must not turn the same message into another translation request.
    const scope = [request.cacheUserId || '', request.accountId || '', request.messageId, request.sourceLanguage || 'auto', request.targetLanguage, request.text]
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const task = this.chain.catch(() => undefined).then(async () => {
      const entries = await this.store.read()
      if (entries[key]) return { ...entries[key], cacheUserId: request.cacheUserId }
      const previous = Object.values(entries).find(item=>this.matches(item,request))
      if (previous) { entries[key]=previous;await this.store.write(entries);return {...previous,cacheUserId:request.cacheUserId} }
      const saved = { ...request, requestId: `stored-message-${key}` }
      entries[key] = saved
      await this.store.write(entries)
      return saved
    })
    this.chain = task
    void task.catch(() => undefined)
    return task
  }
  async flush() { await this.chain }
  /** Caller must first verify a durable failed receipt with zero charged characters.
   * The compare-and-swap coalesces scans/retries; persist before any new API call. */
  recoverFailed(request: TranslationRequest, limit: number, failedAt = Date.now()): Promise<TranslationRequest | undefined> {
    if (!request.messageId || !request.requestId || request.requestId.startsWith('send-')) return Promise.resolve(undefined)
    const work = this.chain.catch(() => undefined).then(async () => {
      const entries = await this.store.read()
      const prior = Object.values(entries).find(item => this.matches(item, request))
      if (prior && prior.requestId !== request.requestId) return { ...prior }
      const count = prior?.historyRetryCount || request.historyRetryCount || 0
      const now = Date.now(), saved = prior || request
      // Limit bursts, not the lifetime of a message. Older clients persisted a
      // lifetime cap: a short outage could otherwise disable a message forever.
      const windowAt = saved.historyRetryWindowAt ?? failedAt
      const elapsed = now - windowAt >= 5 * 60000
      const windowCount = elapsed ? 0 : (saved.historyRetryWindowCount ?? count)
      if (windowCount >= limit) return undefined
      const next = { ...request, historyRetryCount: count + 1,
        historyRetryWindowAt: elapsed ? now : windowAt, historyRetryWindowCount: windowCount + 1,
        requestId: 'message-retry-' + createHash('sha256').update(request.requestId!).digest('hex') }
      const keys = Object.keys(entries).filter(key => this.matches(entries[key], request))
      if (!keys.length) keys.push(createHash('sha256').update(JSON.stringify([request.cacheUserId, request.accountId, request.messageId, request.sourceLanguage, request.targetLanguage, request.text])).digest('hex'))
      for (const key of keys) entries[key] = next
      await this.store.write(entries)
      return { ...next }
    })
    this.chain = work; void work.catch(() => undefined)
    return work
  }
  expireMessage(owner: string, accountId: string, conversationId: string, identity: string) {
    const work = this.chain.catch(() => undefined).then(async () => {
      const entries = await this.store.read()
      for (const item of Object.values(entries)) if ((item.cacheUserId || '') === owner && (item.accountId || '') === accountId) {
        if (item.conversationId === conversationId) item.context = []
        if (item.messageId === identity || item.requestId === identity) { item.text = ''; item.context = [] }
      }
      await this.store.write(entries)
    })
    this.chain = work
    return work
  }
}
