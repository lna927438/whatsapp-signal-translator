import { createHash } from 'crypto'
import type { AppSettings, TranslationMetrics, TranslationRequest } from '../types'
import { SettingsStore } from '../storage/settingsStore'
import { TranslationCache } from './cache'
import { deterministicChatTranslation } from './slang'
import { OpenAIProvider } from './providers/openai'
import { DeepLProvider } from './providers/deepl'
import { GoogleProvider } from './providers/google'
import type { TranslationProvider } from './providers/provider'

interface QueueJob {
  run: () => Promise<string>
  resolve: (value: string) => void
  reject: (reason?: unknown) => void
}

export class TranslationEngine {
  private readonly settings = new SettingsStore()
  private readonly cache = new TranslationCache()
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly queue: QueueJob[] = []
  private readonly maxConcurrent = 3
  private activeRequests = 0
  private latencyTotal = 0
  private latencySamples = 0
  private metricsState: TranslationMetrics = {
    totalRequests: 0,
    providerCalls: 0,
    cacheHits: 0,
    dedupHits: 0,
    translatedCharacters: 0,
    activeRequests: 0,
    queueDepth: 0,
    lastLatencyMs: 0,
    averageLatencyMs: 0,
    lastUpdatedAt: Date.now()
  }

  async translate(request: TranslationRequest): Promise<string> {
    const settings = await this.settings.get()
    return this.translateWithSettings(request, settings, true)
  }

  async testWithSettings(settings: AppSettings, request: TranslationRequest): Promise<string> {
    return this.translateWithSettings(request, settings, false)
  }

  metrics(): TranslationMetrics {
    return { ...this.metricsState, activeRequests: this.activeRequests, queueDepth: this.queue.length }
  }

  private requestKey(provider: string, request: TranslationRequest): string {
    const context = (request.context || []).slice(-4).map((item) => `${item.role}:${item.text}`).join('\u241e')
    return createHash('sha256').update([
      provider,
      request.sourceLanguage || 'auto',
      request.targetLanguage,
      request.accountId || '',
      request.conversationId || '',
      request.messageId || '',
      request.text,
      context
    ].join('\u241f')).digest('hex')
  }

  private async translateWithSettings(request: TranslationRequest, settings: AppSettings, useCache: boolean): Promise<string> {
    const text = request.text.trim()
    if (!text) return request.text
    const normalized: TranslationRequest = {
      ...request,
      text,
      context: (request.context || []).filter((item) => item?.text?.trim()).slice(-4)
    }

    this.metricsState.totalRequests += 1
    this.metricsState.translatedCharacters += text.length
    this.metricsState.lastProvider = settings.provider
    this.metricsState.lastUpdatedAt = Date.now()

    const deterministic = deterministicChatTranslation(normalized)
    if (deterministic !== undefined) {
      if (useCache) await this.cache.set(settings.provider, normalized, deterministic)
      this.metricsState.lastLatencyMs = 0
      return deterministic
    }

    if (useCache) {
      const cached = await this.cache.get(settings.provider, normalized)
      if (cached !== undefined) {
        this.metricsState.cacheHits += 1
        this.metricsState.lastLatencyMs = 0
        this.metricsState.lastUpdatedAt = Date.now()
        return cached
      }
    }

    const key = this.requestKey(settings.provider, normalized)
    const existing = this.inFlight.get(key)
    if (existing) {
      this.metricsState.dedupHits += 1
      return existing
    }

    const promise = this.enqueue(async () => {
      const started = Date.now()
      try {
        this.metricsState.providerCalls += 1
        const provider = this.createProvider(settings)
        const translated = await provider.translate(normalized)
        const latency = Date.now() - started
        this.recordLatency(latency)
        this.metricsState.lastError = undefined
        if (useCache) await this.cache.set(settings.provider, normalized, translated)
        return translated
      } catch (error: any) {
        const latency = Date.now() - started
        this.recordLatency(latency)
        this.metricsState.lastError = String(error?.message || error)
        throw error
      } finally {
        this.metricsState.lastUpdatedAt = Date.now()
      }
    })

    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
  }

  private recordLatency(latency: number): void {
    this.metricsState.lastLatencyMs = latency
    this.latencyTotal += latency
    this.latencySamples += 1
    this.metricsState.averageLatencyMs = Math.round(this.latencyTotal / this.latencySamples)
  }

  private enqueue(run: () => Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ run, resolve, reject })
      this.metricsState.queueDepth = this.queue.length
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    while (this.activeRequests < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!
      this.activeRequests += 1
      this.metricsState.activeRequests = this.activeRequests
      this.metricsState.queueDepth = this.queue.length
      void job.run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeRequests -= 1
          this.metricsState.activeRequests = this.activeRequests
          this.metricsState.queueDepth = this.queue.length
          void this.pump()
        })
    }
  }

  private createProvider(settings: AppSettings): TranslationProvider {
    if (settings.provider === 'openai') {
      const apiKey = settings.openaiApiKey?.trim()
      if (!apiKey) throw new Error('缺少 OpenAI API Key。请在翻译设置中填写并测试。')
      return new OpenAIProvider({ apiKey, model: settings.openaiModel?.trim() || 'gpt-5.6-luna' })
    }

    if (settings.provider === 'deepl') {
      const apiKey = settings.deeplApiKey?.trim()
      if (!apiKey) throw new Error('缺少 DeepL API Key。')
      return new DeepLProvider(apiKey)
    }

    const apiKey = settings.googleApiKey?.trim()
    if (!apiKey) throw new Error('缺少 Google Cloud Translation API Key。')
    return new GoogleProvider(apiKey)
  }
}
