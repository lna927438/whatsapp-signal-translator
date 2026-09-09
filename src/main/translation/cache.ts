import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

interface CacheEntry {
  translated: string
  textHash: string
  updatedAt: number
}
interface CacheShape { [key: string]: CacheEntry }

/**
 * Persistent translation cache.
 *
 * v2 keys intentionally do NOT include the translation provider/model. A message
 * that was already translated once should be restored locally after an app
 * restart, even if the provider/model or nearby context changes later. This is
 * especially important for WhatsApp's virtualized history, which recreates DOM
 * nodes every time a chat is opened or scrolled.
 *
 * Lookup order:
 *   1. stable message id (best)
 *   2. same text + same recent context
 *   3. same text inside the same conversation (restart/UI-change fallback)
 *   4. legacy v0.3.0 provider-sensitive key (then migrate automatically)
 */
export class TranslationCache {
  private readonly store = new JsonStore<CacheShape>('translation-cache.json', {})
  private writeChain: Promise<void> = Promise.resolve()

  private hash(value: string, length = 24): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length)
  }

  private textHash(text: string): string {
    return this.hash(this.normalizeText(text), 24)
  }

  private normalizeText(text: string): string {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  }

  private contextHash(request: TranslationRequest): string {
    const context = (request.context || [])
      .slice(-4)
      .map((item) => `${item.role}:${this.normalizeText(item.text)}`)
      .join('\u241e')
    return this.hash(context, 20)
  }

  private scope(request: TranslationRequest): string {
    return [
      request.sourceLanguage || 'auto',
      request.targetLanguage,
      request.accountId || '',
      request.conversationId || ''
    ].join('\u241f')
  }

  private messageKey(request: TranslationRequest): string | undefined {
    if (!request.messageId) return undefined
    return this.hash([
      'v2-message',
      this.scope(request),
      request.messageId,
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  private contextualKey(request: TranslationRequest): string {
    return this.hash([
      'v2-context',
      this.scope(request),
      this.textHash(request.text),
      this.contextHash(request)
    ].join('\u241f'), 64)
  }

  private looseConversationKey(request: TranslationRequest): string {
    // This deliberately ignores provider/model and context. It is the safety net
    // that prevents a WhatsApp UI change or a slightly different DOM context from
    // charging the user again for the same historical line after a restart.
    return this.hash([
      'v2-conversation-text',
      this.scope(request),
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  private legacyKey(provider: string, request: TranslationRequest): string {
    const source = request.sourceLanguage || 'auto'
    const context = (request.context || [])
      .slice(-4)
      .map((item) => `${item.role}:${item.text}`)
      .join('\u241e')
    const legacyContextHash = this.hash(context, 16)
    const stableMessageKey = request.messageId
      ? `message:${request.accountId || ''}:${request.conversationId || ''}:${request.messageId}`
      : `text:${this.hash(request.text, 20)}:context:${legacyContextHash}`
    return createHash('sha256')
      .update([provider, source, request.targetLanguage, stableMessageKey].join('\u241f'))
      .digest('hex')
  }

  async get(provider: string, request: TranslationRequest): Promise<string | undefined> {
    const cache = await this.store.read()
    const expectedTextHash = this.textHash(request.text)
    const candidates = [
      this.messageKey(request),
      this.contextualKey(request),
      this.looseConversationKey(request),
      this.legacyKey(provider, request)
    ].filter((value): value is string => Boolean(value))

    for (const key of candidates) {
      const entry = cache[key]
      if (!entry || entry.textHash !== expectedTextHash) continue

      // Any legacy or secondary hit is promoted to all v2 aliases so the next
      // restart becomes an immediate local restore with no API request.
      if (key !== this.messageKey(request)) {
        void this.set(provider, request, entry.translated)
      }
      return entry.translated
    }
    return undefined
  }

  async set(_provider: string, request: TranslationRequest, translated: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const cache = await this.store.read()
      const entry: CacheEntry = {
        translated,
        textHash: this.textHash(request.text),
        updatedAt: Date.now()
      }

      const keys = [
        this.messageKey(request),
        this.contextualKey(request),
        this.looseConversationKey(request)
      ].filter((value): value is string => Boolean(value))

      for (const key of keys) cache[key] = entry

      // Three aliases per translation are expected. Keep roughly ten thousand
      // translated messages while preventing the local JSON file from growing
      // forever.
      const allKeys = Object.keys(cache)
      if (allKeys.length > 36000) {
        allKeys.sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0))
        for (const key of allKeys.slice(0, allKeys.length - 30000)) delete cache[key]
      }
      await this.store.write(cache)
    }).catch(() => undefined)
    await this.writeChain
  }
}
