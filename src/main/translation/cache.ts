import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

interface CacheEntry {
  translated: string
  textHash: string
  updatedAt: number
}
interface CacheShape { [key: string]: CacheEntry }

export class TranslationCache {
  private readonly store = new JsonStore<CacheShape>('translation-cache.json', {})
  private writeChain: Promise<void> = Promise.resolve()

  private textHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 20)
  }

  private contextHash(request: TranslationRequest): string {
    const context = (request.context || []).slice(-4).map((item) => `${item.role}:${item.text}`).join('\u241e')
    return createHash('sha256').update(context).digest('hex').slice(0, 16)
  }

  private key(provider: string, request: TranslationRequest): string {
    const source = request.sourceLanguage || 'auto'
    const stableMessageKey = request.messageId
      ? `message:${request.accountId || ''}:${request.conversationId || ''}:${request.messageId}`
      : `text:${this.textHash(request.text)}:context:${this.contextHash(request)}`
    return createHash('sha256')
      .update([provider, source, request.targetLanguage, stableMessageKey].join('\u241f'))
      .digest('hex')
  }

  async get(provider: string, request: TranslationRequest): Promise<string | undefined> {
    const cache = await this.store.read()
    const entry = cache[this.key(provider, request)]
    if (!entry) return undefined
    if (entry.textHash !== this.textHash(request.text)) return undefined
    return entry.translated
  }

  async set(provider: string, request: TranslationRequest, translated: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const cache = await this.store.read()
      cache[this.key(provider, request)] = {
        translated,
        textHash: this.textHash(request.text),
        updatedAt: Date.now()
      }
      const keys = Object.keys(cache)
      if (keys.length > 12000) {
        keys.sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0))
        for (const key of keys.slice(0, keys.length - 10000)) delete cache[key]
      }
      await this.store.write(cache)
    }).catch(() => undefined)
    await this.writeChain
  }
}
