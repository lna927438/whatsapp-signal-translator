import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'
import type { TranslationRequest } from '../types'
import { qualityKey } from '../../shared/translationPolicy'

interface CacheEntry {
  scopeHash?: string
  expired?: boolean
  identityHash?: string
  ownerHash?: string
  translated: string
  textHash: string
  updatedAt: number
}
interface CacheShape { [key: string]: CacheEntry }

/** Restore only the same message or immutable request. Never merge separate messages by text. */
export class TranslationCache {
  private readonly store = new JsonStore<CacheShape>('translation-cache.json', {})
  private writeChain: Promise<void> = Promise.resolve()
  async flush() { await this.writeChain }

  private hash(value: string, length = 24): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length)
  }
  private scopeHash(request: TranslationRequest) { return this.hash(JSON.stringify([request.cacheUserId || '', request.accountId || '', request.messageId || request.requestId || '']), 64) }
  async expire(owner: string, accountId: string, identity: string) {
    const scopeHash = this.scopeHash({ text: '', targetLanguage: '', cacheUserId: owner, accountId, messageId: identity })
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      for (const [key, entry] of Object.entries(data)) if (entry.scopeHash === scopeHash && !entry.expired) delete data[key]
      data['expired:' + scopeHash] = { expired: true, scopeHash, translated: '', textHash: '', updatedAt: Date.now() }
      await this.store.write(data)
    })
    await this.writeChain
  }

  private normalizeText(text: string): string {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim()
  }

  private textHash(text: string): string {
    return this.hash(this.normalizeText(text), 24)
  }

  private languageScope(request: TranslationRequest): string {
    return [request.sourceLanguage || 'auto', request.targetLanguage, ...(qualityKey(request.quality) ? [qualityKey(request.quality)] : [])].join('\u241f')
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
    const entries = Object.values(data).filter(entry => !entry.expired && entry.ownerHash === this.hash(owner, 64))
    return { aliases: entries.length, translations: new Set(entries.map(entry => entry.identityHash || entry.textHash + ':' + entry.translated)).size, bytes: Buffer.byteLength(JSON.stringify(entries), 'utf8'), totalBytes: Buffer.byteLength(JSON.stringify(data), 'utf8') }
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
    const cache = await this.store.readSnapshot()
    if (cache['expired:' + this.scopeHash(request)]) return undefined
    const scoped = (key: string) => request.cacheUserId ? this.hash(request.cacheUserId + ':' + key, 64) : key
    // Different message identities must never share contextual/text aliases.
    const identity = request.messageId ? this.messageKey(request) : request.requestId
      ? this.hash(JSON.stringify(['request-v1', request.requestId, this.conversationScope(request), request.text]), 64) : undefined
    const candidates = identity ? [scoped(identity)] : []

    for (const key of candidates) {
      const entry = cache[key]
      if (!entry || !this.entryMatchesText(entry, request.text)) continue

      return entry.translated
    }
    return undefined
  }

  async set(_provider: string, request: TranslationRequest, translated: string): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const snapshot = await this.store.readSnapshot()
      if (snapshot['expired:' + this.scopeHash(request)]) return
      const entry: CacheEntry = {
        scopeHash: this.scopeHash(request),
        ownerHash: request.cacheUserId ? this.hash(request.cacheUserId,64) : undefined,
        translated,
        textHash: this.textHash(request.text),
        updatedAt: Date.now()
      }
      const identity = request.messageId ? this.messageKey(request) : request.requestId
        ? this.hash(JSON.stringify(['request-v1', request.requestId, this.conversationScope(request), request.text]), 64) : undefined
      entry.identityHash = identity
      const keys = identity ? [identity] : []

      // Repainting an already completed message must not rewrite and encrypt
      // the whole cache. A different identity still gets its own entry.
      const scopedKeys = keys.map(key => request.cacheUserId ? this.hash(request.cacheUserId + ':' + key, 64) : key)
      if (!scopedKeys.length || scopedKeys.every(key => snapshot[key]?.translated === translated && snapshot[key]?.textHash === entry.textHash)) return
      const cache = { ...snapshot }

      for (const key of scopedKeys) cache[key] = entry

      // Bound cache size; immutable receipts and send-task journals remain separate.
      const allKeys = Object.keys(cache).filter(key => !cache[key]?.expired)
      if (allKeys.length > 60000) {
        allKeys.sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0))
        for (const key of allKeys.slice(0, allKeys.length - 50000)) delete cache[key]
      }
      await this.store.write(cache)
    })
    await this.writeChain
  }
}
