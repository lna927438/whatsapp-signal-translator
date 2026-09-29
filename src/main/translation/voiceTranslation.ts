import { createHash } from 'crypto'
import { validateVoiceWav } from '../../shared/voiceAudio'
import type { VoiceTranslationResult } from '../../shared/voiceTranslation'
import type { TranslationRequest } from '../types'
import { alreadyInTargetLanguage } from './outgoingPolicy'

export interface VoiceTranslationInput {
  owner: string
  accountId: string
  conversationId: string
  /** The native message ID is also the content-expiration identity. */
  messageId?: string
  bytes: unknown
  authorized: () => boolean
  quality?: TranslationRequest['quality']
  providerPreference?: TranslationRequest['providerPreference']
  expiresAt?: number
}
interface Dependencies {
  recognize(bytes: Uint8Array, authorized: () => boolean): Promise<string>
  prepare(request: TranslationRequest): Promise<TranslationRequest>
  translate(request: TranslationRequest): Promise<string>
}
interface QueuedRecognition {
  run: () => Promise<string>
  authorized: () => boolean
  resolve: (value: string) => void
  reject: (error: unknown) => void
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const cancelled = () => new Error('窗口、消息或登录状态已变化，请重新点击“转为中文”。')

/** One local recognizer for the whole client, bounded waiting work and immutable
 * translation IDs. Audio is never sent to the translation provider or logged.
 * Only short-lived transcripts are cached; billing remains in TranslationEngine. */
export class VoiceTranslationService {
  private pending = new Map<string, Promise<VoiceTranslationResult>>()
  private transcripts = new Map<string, { text: string; until: number }>()
  private queue: QueuedRecognition[] = []
  private running = false
  private generation = 0
  constructor(private dependencies: Dependencies, private timeoutMs = 300_000) {}

  clear(): void { this.generation++; this.transcripts.clear(); this.pending.clear(); this.drain() }

  private recognize(bytes: Uint8Array, authorized: () => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run: () => this.dependencies.recognize(bytes, authorized), authorized, resolve, reject })
      this.drain()
    })
  }
  private drain(): void {
    // Cancel queued jobs immediately, even when a native recognizer is stopping.
    this.queue = this.queue.filter(job => {
      if (job.authorized()) return true
      job.reject(cancelled()); return false
    })
    if (this.running) return
    const job = this.queue.shift(); if (!job) return
    this.running = true
    void Promise.resolve().then(() => {
      if (!job.authorized()) throw cancelled()
      return job.run()
    }).then(job.resolve, job.reject).finally(() => { this.running = false; this.drain() })
  }

  async translate(input: VoiceTranslationInput): Promise<VoiceTranslationResult> {
    if (!input.owner || !input.accountId || !input.conversationId || !input.authorized()) throw cancelled()
    const bytes = validateVoiceWav(input.bytes), audioId = hash(bytes)
    const messageId = input.messageId || 'voice-file:' + audioId
    const key = hash(JSON.stringify([input.owner, input.accountId, input.conversationId, messageId, audioId]))
    const generation = this.generation
    let timedOut = false
    const authorized = () => !timedOut && generation === this.generation && input.authorized()
      && (input.expiresAt === undefined || input.expiresAt > Date.now())
    if (!authorized()) throw cancelled()
    const existing = this.pending.get(key)
    if (existing) {
      const value = await existing
      if (!authorized()) throw cancelled()
      return { ...value }
    }
    if (this.pending.size >= 6) throw new Error('正在处理的语音较多，请稍后重试。')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; this.drain(); reject(new Error('语音处理超时，请稍后重试；同一条语音会核对原翻译记录。')) }, this.timeoutMs)
      timer.unref?.()
    })
    const work = (async (): Promise<VoiceTranslationResult> => {
      for (const [id, saved] of this.transcripts) if (saved.until <= Date.now()) this.transcripts.delete(id)
      let text = this.transcripts.get(key)?.text
      if (!text) {
        text = (await this.recognize(bytes, authorized)).trim()
        if (!authorized()) throw cancelled()
        if (!text || text.length > 24000 || Array.from(text).length > 12000 || !/\p{L}/u.test(text)) throw new Error('没有识别到清晰人声，请播放确认后重试。')
        this.transcripts.set(key, { text, until: Math.min(Date.now() + 600_000, input.expiresAt ?? Infinity) })
        while (this.transcripts.size > 32) this.transcripts.delete(this.transcripts.keys().next().value!)
      }
      if (!authorized()) throw cancelled()
      const request: TranslationRequest = {
        text, accountId: input.accountId, conversationId: input.conversationId, messageId,
        requestId: 'voice-zh-' + key, sourceLanguage: 'auto', targetLanguage: 'zh-CN',
        quality: input.quality, providerPreference: input.providerPreference
      }
      // Restore the original paid request, including its recognized text and
      // selected provider, before retrying or returning a saved translation.
      const prepared = await this.dependencies.prepare(request)
      if (!authorized()) throw cancelled()
      const translation = alreadyInTargetLanguage(prepared) ? prepared.text : await this.dependencies.translate(prepared)
      if (!authorized()) throw cancelled()
      if (typeof translation !== 'string' || !translation.trim()) throw new Error('未取得中文译文，请重试。')
      return { text: prepared.text, translation: translation.trim(), audioId, targetLanguage: 'zh-CN' }
    })()
    const operation = Promise.race([work, timeout])
    this.pending.set(key, operation)
    try { return { ...await operation } }
    finally { if (timer) clearTimeout(timer); if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
}
