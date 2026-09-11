import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

// Persist BEFORE an API call. A message keeps its first context across DOM changes/restarts.
export class MessageRequests {
  private store = new JsonStore<Record<string, TranslationRequest>>('message-requests-v1.json', {}, true)
  private chain: Promise<unknown> = Promise.resolve()
  prepare(request: TranslationRequest): Promise<TranslationRequest> {
    if (!request.messageId || request.requestId) return Promise.resolve(request)
    const key = createHash('sha256').update(JSON.stringify([request.cacheUserId || '', request.accountId || '', request.messageId, request.sourceLanguage || 'auto', request.targetLanguage, request.text])).digest('hex')
    const task = this.chain.then(async () => {
      const entries = await this.store.read()
      if (entries[key]) return { ...entries[key], cacheUserId: request.cacheUserId }
      const saved = { ...request, requestId: `stored-message-${key}` }
      entries[key] = saved
      await this.store.write(entries)
      return saved
    })
    this.chain = task.catch(() => undefined)
    return task
  }
}
