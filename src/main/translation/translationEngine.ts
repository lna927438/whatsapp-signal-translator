import { createHash, randomUUID } from 'crypto'
import type { AppSettings, TranslationMetrics, TranslationRequest } from '../types'
import { SettingsStore } from '../storage/settingsStore'
import { ProfileStore } from '../storage/profileStore'
import { ChargeRegistry } from '../storage/chargeRegistry'
import { MessageRequests } from './messageRequests'
import { TranslationCache } from './cache'
import { deterministicChatTranslation } from './slang'
import { CloudflareProvider, TranslationOutcomeError, validateCloudReceipt, translationFailureMessage } from './providers/cloudflare'
import { TranslationReceipts } from './receipts'
import { normalizeQuality, qualityKey, protectLiterals } from '../../shared/translationPolicy'
import { DeepLProvider } from './providers/deepl'
import { GoogleProvider } from './providers/google'
import type { TranslationProvider } from './providers/provider'
import { detectLanguageEvidence } from './languageDetection'
import { TranslationContentPolicy, type ContentExpiry } from './contentPolicy'

interface QueueJob {
  interactive: boolean
  run: () => Promise<string>
  resolve: (value: string) => void
  reject: (reason?: unknown) => void
}

export class TranslationEngine {
  private readonly settings = new SettingsStore()
  private readonly profile = new ProfileStore()
  private readonly charges = new ChargeRegistry()
  private readonly messageRequests = new MessageRequests()
  private readonly receipts = new TranslationReceipts()
  private readonly content = new TranslationContentPolicy()
  private contentSweep?: Promise<void>
  private cleanupContent?: (entry: ContentExpiry) => Promise<void>
  private protectedContent?: (owner: string) => Promise<Set<string>>
  private cleanupOlderContent?: (owner: string, cutoff: number) => Promise<void>
  private retentionScanned = new Map<string, number>()
  onContentCleanup(cleanup: (entry: ContentExpiry) => Promise<void>, protectedIds: (owner: string) => Promise<Set<string>>, cleanupOlder?: (owner: string, cutoff: number) => Promise<void>) { this.cleanupContent = cleanup; this.protectedContent = protectedIds; this.cleanupOlderContent = cleanupOlder }
  private async retentionCandidates(owner: string, days: number) {
    const protectedIds = await this.protectedContent?.(owner) || new Set<string>()
    const cutoff = Date.now() - days * 86400000
    return (await this.receipts.list(owner)).filter(item => days && !item.contentExpired && !['queued','pending'].includes(item.state) && item.createdAt < cutoff
      && ![item.requestId,item.request.messageId].some(id => id && protectedIds.has(id)))
  }
  private recovering = false
  private reconciliations = new Map<string, Promise<'not_found' | undefined>>()
  private readonly cache = new TranslationCache()
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly queue: QueueJob[] = []
  private readonly maxConcurrent = 4
  private activeBackground = 0
  private activeRequests = 0
  private reservedCharacters = 0
  private latencyTotal = 0
  private latencySamples = 0
  private onlineAccessToken = ''
  private onlineUserId = ''
  private sessionRevision = 0
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

  private billingChanged?: () => void
  onBillingChanged(callback: () => void): void { this.billingChanged = callback }
  private freshSession?: (owner: string, force?: boolean, rejectedToken?: string) => Promise<string>
  onSessionRefresh(callback: (owner: string, force?: boolean, rejectedToken?: string) => Promise<string>) { this.freshSession = callback }
  async outgoingSettlement(requestId: string) { return this.cloudProvider(this.sessionRevision, this.onlineUserId).status(requestId) }
  /** Retry only a confirmed uncharged translation; preserve platform dispatch identity. */
  async prepareOutgoingRequest(request: TranslationRequest): Promise<TranslationRequest> {
    const owner = this.onlineUserId, revision = this.sessionRevision
    if (!request.requestId?.startsWith('send-')) return request
    let current = request
    for (let depth = 0; depth < 1000; depth++) {
      if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
      let receipt = await this.receipts.get(owner, current.requestId!)
      if (!receipt) return current
      await this.content.assertAvailable(receipt.request)
      if (receipt.contentExpired || receipt.contextCleared) throw new Error('原请求内容已清理，不能再次提交。')
      if (receipt.retryRequestId) { current = { ...receipt.request, requestId: receipt.retryRequestId }; continue }
      if (receipt.state === 'pending') {
        await this.reconcilePending(receipt.requestId)
        receipt = await this.receipts.get(owner, receipt.requestId)
      }
      if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
      if (receipt?.state === 'failed' && receipt.chargedCharacters === 0) return this.receipts.retryFailedOutgoing(owner, receipt.requestId)
      return receipt?.request || current
    }
    throw new Error('此消息的重试记录过多，请复制原文后联系支持。')
  }
  async existingOutgoing(requestId: string, accountId: string, conversationId: string, original: string, translated: string): Promise<TranslationRequest> {
    const owner = this.onlineUserId, revision = this.sessionRevision
    const receipt = await this.receipts.get(owner, requestId)
    if (revision !== this.sessionRevision || !requestId.startsWith('send-') || !receipt || receipt.contentExpired
      || !['charged','cached','free'].includes(receipt.state) || receipt.request.accountId !== accountId || receipt.request.conversationId !== conversationId
      || receipt.request.text !== original || (receipt.correction ?? receipt.translated) !== translated) throw new Error('原发送记录尚未核实，消息未发送。请在原消息上重试。')
    return receipt.request
  }
  private notifyBilling(): void { try { this.billingChanged?.() } catch { /* UI must not affect settlement */ } }

  setOnlineAccessToken(token?: string | null): void {
    this.onlineAccessToken = String(token || '').trim()
  }

  setOnlineSession(userId?: string | null, token?: string | null): void {
    const next = userId || ''
    if (this.onlineUserId !== next) this.sessionRevision += 1
    this.onlineUserId = next
    this.setOnlineAccessToken(token)
  }

  async translate(request: TranslationRequest): Promise<string> {
    const revision = this.sessionRevision
    const settings = await this.settings.get()
    if (revision !== this.sessionRevision) throw new Error('登录状态已变化，已取消旧账号的翻译任务。')
    return this.translateWithSettings(request, settings, true)
  }

  async testWithSettings(settings: AppSettings, request: TranslationRequest): Promise<string> {
    return this.translateWithSettings(request, settings, false)
  }

  cacheInfo() { return this.cache.stats(this.onlineUserId) }
  clearCache() { if (this.activeRequests || this.queue.length) throw new Error('请等待翻译完成后再清理缓存。'); return this.cache.clear(this.onlineUserId) }
  async history() {
    const owner = this.onlineUserId, revision = this.sessionRevision
    await this.sweepContent()
    const records = await this.receipts.list(owner)
    if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
    return records
  }

  async translateIncoming(request: TranslationRequest, manual = false): Promise<string> {
    const revision = this.sessionRevision
    const settings = await this.settings.get()
    if (revision !== this.sessionRevision) throw new Error('登录状态已变化，已取消旧账号的翻译任务。')
    return this.translateWithSettings(request, settings, true, { manual })
  }
  async retentionInfo(days?: number) {
    const owner = this.onlineUserId, current = await this.content.getRetention(owner)
    const selected = days ?? current
    if (![0,7,30,90].includes(selected)) throw new Error('无效的本机保留期。')
    const count = (await this.retentionCandidates(owner, selected)).length
    if (owner !== this.onlineUserId) throw new Error('登录状态已变化。')
    return { days: current, affected: count }
  }
  async setRetention(days: number) { const owner = this.onlineUserId; await this.contentSweep; await this.content.setRetention(owner, days); this.retentionScanned.delete(owner); await this.sweepContent() }
  async trackContent(updates: ContentExpiry[]) { await this.content.track(updates); await this.sweepContent() }
  sweepContent(): Promise<void> {
    if (this.contentSweep) return this.contentSweep
    const owner = this.onlineUserId
    this.contentSweep = (async () => {
      const days = await this.content.getRetention(owner)
      if (days && Date.now() - (this.retentionScanned.get(owner) || 0) >= 60000) {
        const cutoff = Date.now() - days * 86400000
        const entries = await this.retentionCandidates(owner, days)
        if (entries.length) await this.content.track(entries.map(item => ({ owner, accountId: item.request.accountId || '', conversationId: item.request.conversationId || '', identity: item.request.messageId || item.requestId, expiresAt: cutoff, reason: 'retention' })))
        await this.cleanupOlderContent?.(owner, cutoff)
        this.retentionScanned.set(owner, Date.now())
      }
      for (;;) {
        const due = await this.content.due()
        if (!due.length) break
        for (const entry of due) {
          await this.cache.expire(entry.owner, entry.accountId, entry.identity)
          await this.messageRequests.expireMessage(entry.owner, entry.accountId, entry.conversationId, entry.identity)
          await this.receipts.expireMessage(entry.owner, entry.accountId, entry.conversationId, entry.identity,
            entry.reason === 'retention' ? '本机内容已按保留期清理' : '消息已删除或过期')
          await this.cleanupContent?.(entry)
          await this.content.cleaned(entry)
        }
      }
    })().finally(() => { this.contentSweep = undefined })
    return this.contentSweep
  }
  async expireSignalMessage(owner: string, accountId: string, peer: string, identity: string) {
    await this.trackContent([{ owner, accountId, conversationId: 'signal:' + peer, identity, expiresAt: Date.now(), reason: 'message' }])
  }
  async pendingCount() { return (await this.history()).filter(item => ['queued', 'pending'].includes(item.state)).length }
  async flush() { await this.contentSweep; await Promise.all([this.receipts.flush(), this.cache.flush(), this.messageRequests.flush(), this.content.flush()]) }
  async correct(requestId: string, text: string) {
    const owner = this.onlineUserId
    const receipt = await this.receipts.get(owner, requestId)
    if (!receipt || receipt.contentExpired || !['charged', 'free', 'cached'].includes(receipt.state) || !text.trim() || text.length > 20000) throw new Error('仅可修正未过期的已完成译文。')
    await this.cache.set(receipt.provider, receipt.request, text.trim())
    await this.receipts.update(owner, requestId, { correction: text.trim(), lastAccess: 'correction' })
    return true
  }
  async restoreCorrection(requestId: string) {
    const owner = this.onlineUserId
    const receipt = await this.receipts.get(owner, requestId)
    if (!receipt || receipt.contentExpired || receipt.translated === undefined || !['charged','free','cached'].includes(receipt.state)) throw new Error('原译文已过期或尚未完成。')
    await this.cache.set(receipt.provider, receipt.request, receipt.translated)
    await this.receipts.update(owner, requestId, { correction: undefined, lastAccess: 'cache' })
  }
  async preserveOutgoingRequest(request: TranslationRequest): Promise<TranslationRequest> {
    const previous = (await this.history()).find(item => item.requestId.startsWith('send-sd-') && item.request.accountId === request.accountId
      && item.request.conversationId === request.conversationId && item.request.messageId === request.messageId && item.request.text === request.text)
    return previous ? { ...previous.request } : request
  }
  async preserveIncomingRequest(request: TranslationRequest): Promise<TranslationRequest> {
    if (!request.messageId) return request
    const recovered = await this.messageRequests.lookup({ ...request, requestId: undefined, cacheUserId: this.onlineUserId })
    if (recovered) return recovered
    const prior=(await this.history()).find(item=>item.request.messageId===request.messageId && item.request.accountId===request.accountId
      && (item.request.conversationId||'')===(request.conversationId||'') && item.request.text===request.text && item.request.targetLanguage===request.targetLanguage && (item.request.sourceLanguage||'auto')===(request.sourceLanguage||'auto'))
    return prior ? {...prior.request} : request
  }
  async retryOriginal(requestId: string) {
    const owner = this.onlineUserId, revision = this.sessionRevision
    const receipt = await this.receipts.get(owner, requestId)
    if (!receipt || receipt.provider !== 'openai' || !['pending','failed'].includes(receipt.state)) throw new Error('此请求不需要重试，请先核对结果。')
    if (receipt.contentExpired || receipt.contextCleared) throw new Error('原请求包含已清理的内容，只能查询原结果，不能再次提交。')
    if (requestId.startsWith('send-')) {
      const request = await this.prepareOutgoingRequest(receipt.request)
      return this.translate(request)
    }
    if (receipt.state === 'failed') return this.translateIncoming(receipt.request, true)
    const result = await this.cloudProvider(revision, owner).status(requestId)
    if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
    if (result.state !== 'not_found') {
      await this.reconcilePending(requestId)
      const latest = await this.receipts.get(owner, requestId)
      if (latest?.state === 'charged') return latest.correction ?? latest.translated
      if (latest?.state === 'failed') return this.translateIncoming(latest.request, true)
      throw new Error('云端仍在处理此请求，请稍后继续核对。')
    }
    if (receipt.contentExpired || receipt.contextCleared) throw new Error('原请求包含已清理的内容，只能查询原结果，不能再次提交。')
    await this.content.assertAvailable(receipt.request)
    await this.receipts.update(owner, requestId, { state: 'queued', error: undefined })
    return this.translateWithSettings(receipt.request, { ...await this.settings.get(), provider: 'openai' }, true, { manual: true })
  }
  async reconcilePending(requestId?: string) {
    const missing = new Set<string>()
    if ((!requestId && this.recovering) || !this.onlineUserId || !this.onlineAccessToken) return missing
    if (!requestId) this.recovering = true
    const owner = this.onlineUserId, revision = this.sessionRevision
    try {
      await this.sweepContent()
      const entries = (await this.receipts.list(owner)).filter(item => item.state === 'pending' && item.provider === 'openai' && (!requestId || item.requestId === requestId)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(0,20)
      for (const entry of entries) {
        if (revision !== this.sessionRevision) return missing
        const key = owner + ':' + entry.requestId
        const existing = this.reconciliations.get(key)
        if (existing) { if (await existing === 'not_found') missing.add(entry.requestId); continue }
        const work = (async () => {
        try {
          const result = await this.cloudProvider(revision, owner).status(entry.requestId)
          if (revision !== this.sessionRevision) return
          if (result.state === 'completed') {
            const receipt = validateCloudReceipt(result.response, entry.requestId, entry.sourceCharacters)
            await this.receipts.update(owner, entry.requestId, { state: 'charged', translated: receipt.translation, chargedCharacters: receipt.sourceCharacters, balanceAfter: receipt.balanceAfter, error: undefined })
            const settled = await this.receipts.get(owner, entry.requestId)
            if (!settled?.contentExpired) await this.cache.set(entry.provider, entry.request, receipt.translation)
          } else if (result.state === 'failed') await this.receipts.update(owner, entry.requestId, { state: 'failed', chargedCharacters: 0, error: translationFailureMessage(result.error) })
          else await this.receipts.update(owner, entry.requestId, { error: result.state === 'not_found' ? '云端暂未查到此编号。可主动重试原编号，仍按同一请求处理。' : '云端仍在处理，结果待确认，稍后继续核对。' })
          if (result.state === 'not_found') return 'not_found' as const
        } catch (error) { await this.receipts.update(owner, entry.requestId, { error: error instanceof TranslationOutcomeError ? error.message : '暂时无法核对原请求，请恢复连接或重新登录。' }) }
        })().finally(()=>this.reconciliations.delete(key))
        this.reconciliations.set(key, work)
        if (await work === 'not_found') missing.add(entry.requestId)
      }
    } finally { if (!requestId) this.recovering = false; if (revision === this.sessionRevision) this.notifyBilling() }
    return missing
  }
  async cached(request: TranslationRequest): Promise<string | undefined> {
    const user = this.onlineUserId
    const incoming = { ...request, cacheUserId: user }
    await this.sweepContent()
    await this.content.assertAvailable(incoming)
    const scoped = await this.messageRequests.lookup(incoming) || incoming
    const value = await this.cache.get('openai', scoped)
    if (user !== this.onlineUserId) throw new Error('登录状态已变化。')
    if (value !== undefined) {
      this.metricsState.cacheHits += 1
      const prepared = await this.messageRequests.prepare(scoped)
      if (prepared.requestId && await this.receipts.get(user, prepared.requestId)) await this.receipts.update(user, prepared.requestId, { lastAccess: 'cache' })
    }
    await this.content.assertAvailable(incoming)
    return value
  }

  metrics(): TranslationMetrics {
    return { ...this.metricsState, activeRequests: this.activeRequests, queueDepth: this.queue.length }
  }

  private normalizeText(text: string): string {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  }

  private requestKey(provider: string, request: TranslationRequest): string {
    const context = (request.context || []).slice(-4).map((item) => `${item.role}:${item.text}`).join('\u241e')
    return createHash('sha256').update([
      provider,
      this.onlineUserId,
      request.sourceLanguage || 'auto',
      request.targetLanguage,
      request.accountId || '',
      request.conversationId || '',
      request.messageId || '',
      request.requestId || '',
      qualityKey(request.quality),
      request.text,
      context
    ].join('\u241f')).digest('hex')
  }

  private chargeFingerprint(request: TranslationRequest): string {
    return createHash('sha256').update([
      'translation-charge-v2', this.onlineUserId, request.accountId || '', request.messageId || request.requestId || '', qualityKey(request.quality),
      request.sourceLanguage || 'auto',
      request.targetLanguage,
      this.normalizeText(request.text)
    ].join('\u241f')).digest('hex')
  }

  private characterCount(text: string): number {
    return Array.from(text).length
  }

  private async translateWithSettings(request: TranslationRequest, settings: AppSettings, useCache: boolean, historyRecovery?: { manual: boolean }): Promise<string> {
    const revision = this.sessionRevision
    const owner = this.onlineUserId
    const text = request.text.trim()
    if (!text) return request.text
    let normalized: TranslationRequest = {
      ...request,
      text,
      cacheUserId: this.onlineUserId,
      quality: normalizeQuality(request.quality ?? settings.translationQuality),
      context: (request.context || []).filter((item) => item?.text?.trim()).slice(-4)
    }
    await this.sweepContent()
    await this.content.assertAvailable(normalized)
    if (useCache) normalized = await this.messageRequests.prepare(normalized)
    if (!normalized.requestId) normalized.requestId = `manual-${randomUUID()}`
    if (normalized.requestId.startsWith('send-')) {
      const previous = await this.receipts.get(owner, normalized.requestId)
      // Retain the original wire request on retries and upgrades. For new sends,
      // use evidence from the text; a UI language preference is not detection.
      const evidence = detectLanguageEvidence(normalized.text)
      normalized.sourceLanguage = previous?.request.sourceLanguage ?? (evidence.confidence === 'high' ? evidence.language : 'auto')
    }
    if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
    let stored = await this.receipts.prepare(owner, settings.provider, normalized)
    normalized = stored.request
    await this.content.assertAvailable(normalized)
    const concurrent = this.inFlight.get(this.requestKey(settings.provider, normalized))
    if (concurrent) { this.metricsState.dedupHits += 1; return concurrent }
    if (stored.state === 'pending') {
      const missing = await this.reconcilePending(stored.requestId)
      const reconciled = await this.receipts.get(owner, stored.requestId)
      await this.content.assertAvailable(normalized)
      if (reconciled?.state === 'charged' && reconciled.translated !== undefined) return reconciled.correction ?? reconciled.translated
      // A successful authenticated lookup is required before replaying the exact
      // immutable ID. Persist the limit so scrolling/restarts cannot loop forever.
      if (missing?.has(stored.requestId) && (historyRecovery || stored.requestId.startsWith('send-'))) {
        if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
        const retry = await this.receipts.retryMissing(owner, stored.requestId, historyRecovery?.manual ? Infinity : 2)
        if (retry) return this.translateWithSettings(retry, settings, useCache, historyRecovery)
        const latest = await this.receipts.get(owner, stored.requestId)
        if (latest?.state === 'queued' || this.inFlight.has(this.requestKey(settings.provider, normalized))) return this.translateWithSettings(normalized, settings, useCache, historyRecovery)
      }
      // The lookup may have moved pending -> failed in this very call. Continue
      // from the authoritative state instead of falsely reporting it as pending.
      if (reconciled?.state === 'failed') stored = reconciled
      else throw new TranslationOutcomeError(reconciled?.error || '原请求结果待确认，恢复连接后会继续核对。')
    }
    if (stored.state === 'failed') {
      // Never replace a pending/unknown or settled request. Confirmed uncharged
      // history failures get at most two automatic recovery attempts, durable
      // across scrolling and restarts; further attempts require Retry.
      if (historyRecovery && stored.chargedCharacters === 0 && !stored.contentExpired && !stored.contextCleared) {
        const next = await this.messageRequests.recoverFailed(normalized, historyRecovery.manual ? Infinity : 2)
        if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
        if (next && next.requestId !== normalized.requestId) return this.translateWithSettings(next, settings, true, historyRecovery)
      }
      throw new TranslationOutcomeError(stored.error || '此请求已失败，请重试此消息。', true)
    }
    if (stored.translated !== undefined) {
      const restored = stored.correction ?? stored.translated
      // History scrolling is read-only when the same durable translation is already cached.
      if (useCache && await this.cache.get(settings.provider, normalized) !== restored) await this.cache.set(settings.provider, normalized, restored)
      if (stored.lastAccess !== 'cache') await this.receipts.update(owner, stored.requestId, { lastAccess: 'cache' })
      this.metricsState.cacheHits += 1
      await this.content.assertAvailable(normalized)
      return restored
    }

    this.metricsState.totalRequests += 1
    this.metricsState.translatedCharacters += this.characterCount(text)
    this.metricsState.lastProvider = settings.provider
    this.metricsState.lastUpdatedAt = Date.now()

    const deterministic = qualityKey(normalized.quality) ? undefined : deterministicChatTranslation(normalized)
    if (deterministic !== undefined) {
      if (useCache) await this.cache.set(settings.provider, normalized, deterministic)
      await this.receipts.update(owner, normalized.requestId!, { state: 'free', translated: deterministic, chargedCharacters: 0 })
      this.metricsState.lastLatencyMs = 0
      await this.content.assertAvailable(normalized)
      return deterministic
    }

    if (useCache) {
      const cached = await this.cache.get(settings.provider, normalized)
      if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
      if (cached !== undefined) {
        this.metricsState.cacheHits += 1
        this.metricsState.lastLatencyMs = 0
        this.metricsState.lastUpdatedAt = Date.now()
        await this.receipts.update(owner, normalized.requestId!, { state: 'cached', translated: cached, chargedCharacters: 0, lastAccess: 'cache' })
        await this.content.assertAvailable(normalized)
        return cached
      }
    }

    if (revision !== this.sessionRevision) throw new Error('登录状态已变化。')
    const key = this.requestKey(settings.provider, normalized)
    const existing = this.inFlight.get(key)
    if (existing) {
      this.metricsState.dedupHits += 1
      return existing
    }

    const queuedAt = Date.now()
    const promise = this.enqueue(async () => {
      const started = Date.now()
      await this.receipts.update(owner, normalized.requestId!, { queueWaitMs: started - queuedAt })
      const charge = this.characterCount(text)
      const cloudManaged = settings.provider === 'openai'
      let reserved = false
      try {
        if (revision !== this.sessionRevision) throw new Error('登录状态已变化，已取消旧账号的翻译任务。')
        await this.content.assertAvailable(normalized)
        const current = await this.receipts.get(owner, normalized.requestId!)
        if (current?.contextCleared) throw new TranslationOutcomeError('请求上下文已清理，原任务不会自动重新提交。', true)
        if (useCache) { const cached = await this.cache.get(settings.provider, normalized); if (revision !== this.sessionRevision) throw new Error('登录状态已变化。'); if (cached !== undefined) { this.metricsState.cacheHits += 1; return cached } }
        if (!cloudManaged) {
          await this.profile.ensureAvailable(charge, this.reservedCharacters)
          this.reservedCharacters += charge
          reserved = true
        }

        this.metricsState.providerCalls += 1
        const provider = this.createProvider(settings, revision, owner)
        if (cloudManaged) this.notifyBilling()
        let translated: string
        await this.receipts.update(owner, normalized.requestId!, { state: 'pending' })
        try {
          if (cloudManaged) translated = await provider.translate(normalized)
          else { const literals = protectLiterals(normalized.text, normalized.quality); translated = literals.restore(await provider.translate({ ...normalized, text: literals.input })) }
        }
        finally { if (cloudManaged && revision === this.sessionRevision) this.notifyBilling() }
        const latency = Date.now() - started
        await this.receipts.update(owner, normalized.requestId!, { providerMs: latency })
        this.recordLatency(latency)
        this.metricsState.lastError = undefined

        if (useCache) {
          try { await this.cache.set(settings.provider, normalized, translated) }
          catch { this.metricsState.lastError = '译文已完成，但本机缓存写入失败；重试将沿用原请求。' }
        }

        // OpenAI billing is now authoritative on the Cloudflare + Supabase server.
        // DeepL/Google remain local legacy providers for now and keep the old local quota path.
        if (!cloudManaged) {
          if (useCache) {
            await this.charges.runOnce(this.chargeFingerprint(normalized), async () => {
              await this.profile.consumeCharacters(charge, {
                provider: settings.provider,
                accountId: normalized.accountId,
                conversationId: normalized.conversationId,
                note: normalized.accountId ? '实时翻译' : 'API 翻译测试'
              })
            })
          } else {
            await this.profile.consumeCharacters(charge, {
              provider: settings.provider,
              accountId: normalized.accountId,
              conversationId: normalized.conversationId,
              note: 'API 翻译测试'
            })
          }
          await this.receipts.update(owner, normalized.requestId!, { state: 'charged', translated, chargedCharacters: charge })
        }

        await this.sweepContent()
        await this.content.assertAvailable(normalized)
        return translated
      } catch (error: any) {
        const latency = Date.now() - started
        this.recordLatency(latency)
        this.metricsState.lastError = error instanceof TranslationOutcomeError ? error.message : '翻译未完成，请查看任务记录。'
        if (error instanceof TranslationOutcomeError && error.confirmedFailure) await this.receipts.update(owner, normalized.requestId!, { state: 'failed', chargedCharacters: 0, error: error.message })
        throw error
      } finally {
        if (reserved) this.reservedCharacters = Math.max(0, this.reservedCharacters - charge)
        this.metricsState.lastUpdatedAt = Date.now()
      }
    }, normalized.requestId?.startsWith('send-') === true)

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

  private enqueue(run: () => Promise<string>, interactive = false): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ run, resolve, reject, interactive })
      this.metricsState.queueDepth = this.queue.length
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    while (this.activeRequests < this.maxConcurrent && this.queue.length) {
      let index = this.queue.findIndex(job => job.interactive)
      if (index < 0) {
        // Keep two slots available for typing/sending, even during a history flood.
        if (this.activeBackground >= 2) break
        index = 0
      }
      const job = this.queue.splice(index, 1)[0]
      if (!job.interactive) this.activeBackground += 1
      this.activeRequests += 1
      this.metricsState.activeRequests = this.activeRequests
      this.metricsState.queueDepth = this.queue.length
      void job.run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeRequests -= 1
          if (!job.interactive) this.activeBackground -= 1
          this.metricsState.activeRequests = this.activeRequests
          this.metricsState.queueDepth = this.queue.length
          void this.pump()
        })
    }
  }

  private cloudProvider(revision: number, owner: string) {
    return new CloudflareProvider(async (force, rejectedToken) => {
      if (revision !== this.sessionRevision) throw new Error('登录状态已变化，已取消旧账号的翻译任务。')
      const token = this.freshSession ? await this.freshSession(owner, force, rejectedToken) : this.onlineAccessToken
      if (revision !== this.sessionRevision) throw new Error('登录状态已变化，已取消旧账号的翻译任务。')
      return token
    }, undefined, async receipt => { await this.receipts.update(owner, receipt.requestId, { state: 'charged', translated: receipt.translation, chargedCharacters: receipt.sourceCharacters, balanceAfter: receipt.balanceAfter, error: undefined }) })
  }
  private createProvider(settings: AppSettings, revision = this.sessionRevision, owner = this.onlineUserId): TranslationProvider {
    if (settings.provider === 'openai') {
      if (!this.onlineAccessToken) throw new Error('在线登录令牌缺失，请重新登录。')
      return this.cloudProvider(revision, owner)
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
