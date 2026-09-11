import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'

interface CacheEntry {
  ownerHash?: string
  translated: string
  textHash: string
  updatedAt: number
}
interface CacheShape { [key: string]: CacheEntry }

/**
 * Persistent translation cache.
 *
 * A translated historical message must be restorable after restart without an
 * API call. Keys therefore deliberately ignore provider/model and progressively
 * relax volatile WhatsApp identifiers.
 *
 * Lookup order:
 *   1. stable message id
 *   2. same text + same recent context
 *   3. same text inside the same conversation
 *   4. same text inside the same account (conversation title may change)
 *   5. same source/target text globally (last restart-safe fallback)
 *   6. legacy v0.3.0 provider-sensitive key, then migrate automatically
 */
export class TranslationCache {
  private readonly store = new JsonStore<CacheShape>('translation-cache.json', {})
  private writeChain: Promise<void> = Promise.resolve()

  private hash(value: string, length = 24): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length)
  }

  private normalizeText(text: string): string {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim()
  }

  private textHash(text: string): string {
    return this.hash(this.normalizeText(text), 24)
  }

  private contextHash(request: TranslationRequest): string {
    const context = (request.context || [])
      .slice(-4)
      .map((item) => `${item.role}:${this.normalizeText(item.text)}`)
      .join('\u241e')
    return this.hash(context, 20)
  }

  private languageScope(request: TranslationRequest): string {
    return [request.sourceLanguage || 'auto', request.targetLanguage].join('\u241f')
  }

  private accountScope(request: TranslationRequest): string {
    return [this.languageScope(request), request.accountId || ''].join('\u241f')
  }

  private conversationScope(request: TranslationRequest): string {
    return [this.accountScope(request), request.conversationId || ''].join('\u241f')
  }

  private messageKey(request: TranslationRequest): string | undefined {
    if (!request.messageId) return undefined
    return this.hash([
      'v4-message',
      this.accountScope(request),
      request.messageId,
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  private contextualKey(request: TranslationRequest): string {
    return this.hash([
      'v3-context',
      this.conversationScope(request),
      this.textHash(request.text),
      this.contextHash(request)
    ].join('\u241f'), 64)
  }

  private conversationTextKey(request: TranslationRequest): string {
    return this.hash([
      'v3-conversation-text',
      this.conversationScope(request),
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  private accountTextKey(request: TranslationRequest): string {
    return this.hash([
      'v3-account-text',
      this.accountScope(request),
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  private globalTextKey(request: TranslationRequest): string {
    return this.hash([
      'v3-global-text',
      this.languageScope(request),
      this.textHash(request.text)
    ].join('\u241f'), 64)
  }

  // v0.3.1 aliases, retained so existing local caches upgrade without cost.
  private v2Keys(request: TranslationRequest): string[] {
    const scope = [
      request.sourceLanguage || 'auto',
      request.targetLanguage,
      request.accountId || '',
      request.conversationId || ''
    ].join('\u241f')
    const textHash = this.textHash(request.text)
    const keys: string[] = []
    if (request.messageId) {
      keys.push(this.hash(['v2-message', scope, request.messageId, textHash].join('\u241f'), 64))
    }
    keys.push(this.hash(['v2-context', scope, textHash, this.contextHash(request)].join('\u241f'), 64))
    keys.push(this.hash(['v2-conversation-text', scope, textHash].join('\u241f'), 64))
    return keys
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

  private entryMatchesText(entry: CacheEntry, text: string): boolean {
    const normalized = this.normalizeText(text)
    const hashes = new Set([
      this.hash(normalized, 24),
      this.hash(normalized, 20),
      this.hash(text, 24),
      this.hash(text, 20)
    ])
    return hashes.has(String(entry.textHash || ''))
  }

  async stats(owner: string) {
    const data = await this.store.read()
    const entries = Object.values(data).filter(entry => entry.ownerHash === this.hash(owner, 64))
    return { aliases: entries.length, translations: new Set(entries.map(entry => entry.textHash + ':' + entry.translated)).size }
  }
  async clear(owner: string) {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      for (const [key, entry] of Object.entries(data)) if (entry.ownerHash === this.hash(owner, 64)) delete data[key]
      await this.store.write(data)
    })
    await this.writeChain
  }

  async get(provider: string, request: TranslationRequest): Promise<string | undefined> {
    const cache = await this.store.read()
    const primary = [
      this.messageKey(request),
      this.contextualKey(request),
      this.conversationTextKey(request),
      this.accountTextKey(request),
      this.globalTextKey(request)
    ].filter((value): value is string => Boolean(value))
    const scoped = (key: string) => request.cacheUserId ? this.hash(request.cacheUserId + ':' + key, 64) : key
    const candidates = request.cacheUserId
      ? [this.messageKey(request), this.contextualKey(request)].filter((key): key is string => Boolean(key)).map(scoped)
      : [...primary, ...this.v2Keys(request), this.legacyKey(provider, request)]

    for (const key of candidates) {
      const entry = cache[key]
      if (!entry || !this.entryMatchesText(entry, request.text)) continue

      // Promote every old/secondary hit into the full v3 alias set. From this
      // point onward restarts, contact-title changes and DOM changes remain local.
      if (!request.cacheUserId && !primary.includes(key)) void this.set(provider, request, entry.translated).catch(() => {})
      return entry.translated
    }
    return undefined
  }

  async set(_provider: string, request: TranslationRequest, translated: string): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const cache = await this.store.read()
      const entry: CacheEntry = {
        ownerHash: request.cacheUserId ? this.hash(request.cacheUserId,64) : undefined,
        translated,
        textHash: this.textHash(request.text),
        updatedAt: Date.now()
      }
      const keys = [
        this.messageKey(request),
        this.contextualKey(request),
        this.conversationTextKey(request),
        this.accountTextKey(request),
        this.globalTextKey(request)
      ].filter((value): value is string => Boolean(value))

      for (const key of keys) cache[request.cacheUserId ? this.hash(request.cacheUserId + ':' + key, 64) : key] = entry

      // Up to five aliases per translation are expected. Keep a generous local
      // history while preventing the JSON file from growing forever.
      const allKeys = Object.keys(cache)
      if (allKeys.length > 60000) {
        allKeys.sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0))
        for (const key of allKeys.slice(0, allKeys.length - 50000)) delete cache[key]
      }
      await this.store.write(cache)
    })
    await this.writeChain
  }
}
