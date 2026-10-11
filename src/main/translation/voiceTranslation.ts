import { createHash } from 'crypto'
import { validateVoiceWav } from '../../shared/voiceAudio'
import type { VoiceTranslationResult } from '../../shared/voiceTranslation'
import type { TranslationRequest } from '../types'
import { alreadyInTargetLanguage } from './outgoingPolicy'
import type { RecognizedVoice } from './voiceRecognition'

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
  recognize(bytes: Uint8Array, authorized: () => boolean): Promise<string | RecognizedVoice>
  prepare(request: TranslationRequest): Promise<TranslationRequest>
  translate(request: TranslationRequest): Promise<string>
}
interface QueuedRecognition {
  run: () => Promise<string | RecognizedVoice>
  authorized: () => boolean
  resolve: (value: string | RecognizedVoice) => void
  reject: (error: unknown) => void
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const cancelled = () => new Error('窗口、消息或登录状态已变化，请重新点击“转为中文”。')

/** One local recognizer for the whole client, bounded waiting work and immutable
 * translation IDs. Audio is never sent to the translation provider or logged.
 * Only short-lived transcripts are cached; billing remains in TranslationEngine. */
export class VoiceTranslationService {
  private pending = new Map<string, Promise<VoiceTranslationResult>>()
  private transcripts = new Map<string, RecognizedVoice & { until: number }>()
  private completed = new Map<string, { result: VoiceTranslationResult; until: number }>()
  private queue: QueuedRecognition[] = []
  private running = false
  private generation = 0
  constructor(private dependencies: Dependencies, private timeoutMs = 300_000) {}

  clear(): void { this.generation++; this.transcripts.clear(); this.completed.clear(); this.pending.clear(); this.drain() }

  private recognize(bytes: Uint8Array, authorized: () => boolean): Promise<string | RecognizedVoice> {
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
    const saved = this.completed.get(key)
    if (saved && saved.until > Date.now()) {
      // Each target's ledger remains authoritative after completion. Native
      // Chinese speech may have only an English receipt, so checking Chinese
      // alone could return an English result whose content was already cleared.
      for (const [prefix, targetLanguage] of [['voice-zh-', 'zh-CN'], ['voice-en-', 'en-US']] as const) {
        await this.dependencies.prepare({ text: saved.result.text, accountId: input.accountId,
          conversationId: input.conversationId, messageId, requestId: prefix + key,
          sourceLanguage: 'auto', targetLanguage, quality: input.quality, providerPreference: input.providerPreference })
        if (!authorized()) throw cancelled()
      }
      return { ...saved.result }
    }
    this.completed.delete(key)
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
      let text = this.transcripts.get(key)?.text, language = this.transcripts.get(key)?.language
      if (!text) {
        const recognized = await this.recognize(bytes, authorized)
        text = (typeof recognized === 'string' ? recognized : recognized.text).trim()
        language = typeof recognized === 'string' ? undefined : recognized.language
        if (!authorized()) throw cancelled()
        if (!text || text.length > 24000 || Array.from(text).length > 12000 || !/\p{L}/u.test(text)) throw new Error('没有识别到清晰人声，请播放确认后重试。')
        this.transcripts.set(key, { text, language, until: Math.min(Date.now() + 600_000, input.expiresAt ?? Infinity) })
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
      let prepared = await this.dependencies.prepare(request)
      if (!authorized()) throw cancelled()
      // Restore Chinese's historic transcript first. Both target requests use
      // that same original, but independent immutable IDs/receipts. If only one
      // target fails, retry recovers the other target's paid result.
      const english = await this.dependencies.prepare({ ...request, text: prepared.text,
        requestId: 'voice-en-' + key, targetLanguage: 'en-US' })
      if (!authorized()) throw cancelled()
      // Chinese audio has no paid Chinese receipt. Its English receipt can be
      // the only durable copy of the first transcript after a restart.
      if (english.text !== prepared.text) {
        prepared = await this.dependencies.prepare({ ...request, text: english.text })
        if (!authorized()) throw cancelled()
        if (prepared.text !== english.text) throw new Error('原语音的中英记录不一致，请核对原翻译记录后重试。')
      }
      const translateTarget = async (target: TranslationRequest, label: string) => {
        if (!authorized()) throw cancelled()
        // A voice transcript already in its requested language is shown as-is;
        // writing-style settings must not buy a rewrite of that transcript.
        const nativeLanguage = target.text === text && language === target.targetLanguage.split('-')[0]
          && (language !== 'en' || !/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\s]/u.test(text))
        const value = nativeLanguage || alreadyInTargetLanguage({ ...target, quality: undefined }) ? target.text : await this.dependencies.translate(target)
        if (!authorized()) throw cancelled()
        if (typeof value !== 'string' || !value.trim() || value.length > 40000) throw new Error('未取得' + label + '译文，请重试。')
        if (target.targetLanguage === 'en-US' && /\p{Script=Han}/u.test(value)) throw new Error('英文译文仍含中文，请重试。已完成的译文会沿用原记录。')
        return value.trim()
      }
      // Independent translations overlap their network wait; ASR stays serial.
      const targets = await Promise.allSettled([
        translateTarget(prepared, '中文'), translateTarget(english, '英文')
      ])
      if (!authorized()) throw cancelled()
      // Do not expose Retry while the other target is still settling its
      // receipt. Both branches must settle (or the overall timeout intervenes).
      const failure = targets.find(target => target.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const [translation, englishTranslation] = targets.map(target => (target as PromiseFulfilledResult<string>).value)
      const result: VoiceTranslationResult = { text: prepared.text, translation, englishTranslation, audioId, targetLanguage: 'zh-CN' }
      const until = Math.min(Date.now() + 600_000, input.expiresAt ?? Infinity)
      this.completed.set(key, { result, until })
      while (this.completed.size > 32) this.completed.delete(this.completed.keys().next().value!)
      return result
    })()
    const operation = Promise.race([work, timeout])
    this.pending.set(key, operation)
    try { return { ...await operation } }
    finally { if (timer) clearTimeout(timer); if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
}
