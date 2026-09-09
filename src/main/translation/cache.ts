import { createHash } from 'crypto'
import { JsonStore } from '../storage/jsonStore'

interface CacheShape { [key: string]: string }

export class TranslationCache {
  private readonly store = new JsonStore<CacheShape>('translation-cache.json', {})

  private key(provider: string, source: string, target: string, text: string): string {
    return createHash('sha256').update([provider, source, target, text].join('\u241f')).digest('hex')
  }

  async get(provider: string, source: string, target: string, text: string): Promise<string | undefined> {
    const cache = await this.store.read()
    return cache[this.key(provider, source, target, text)]
  }

  async set(provider: string, source: string, target: string, text: string, translated: string): Promise<void> {
    const cache = await this.store.read()
    cache[this.key(provider, source, target, text)] = translated
    const keys = Object.keys(cache)
    if (keys.length > 5000) {
      for (const k of keys.slice(0, keys.length - 4500)) delete cache[k]
    }
    await this.store.write(cache)
  }
}
