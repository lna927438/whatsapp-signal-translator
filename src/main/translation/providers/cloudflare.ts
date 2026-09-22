import { createHash, randomUUID } from 'crypto'
import type { TranslationRequest } from '../../types'
import type { TranslationProvider } from './provider'
import { cloudBases } from '../../network/cloudConnection'
import { qualityKey } from '../../../shared/translationPolicy'
import { authenticatedFetch, SessionUnavailableError, type TokenSource } from '../../network/sessionRefresh'
import { isSemanticTranslationMismatch } from '../../../shared/translationSemantics'
import { readTranslationChannels, clearTranslationChannels } from '../../network/translationChannels'

export interface CloudReceipt { requestId: string; translation: string; sourceCharacters: number; balanceAfter: number }
export interface TranslationRepairReceipt extends CloudReceipt { chargedCharacters: 0; repairRequestId: string; repairOf: string }
export class TranslationOutcomeError extends Error {
  constructor(message: string, readonly confirmedFailure = false) { super(message) }
}
export const quarantinedTranslationMessage = '译文偏离原文，已停止显示和发送。请在“记录与恢复”中为此条记录免费修正；原结算记录保留。'
const terminalFailures = new Set(['translation_failed', 'translation_outcome_unknown', 'provider_auth', 'provider_quota', 'provider_rate_limit', 'provider_model', 'provider_permission', 'provider_request', 'provider_timeout', 'provider_unavailable', 'provider_empty', 'protected_literal_mismatch', 'provider_wrong_language', 'provider_not_translation'])
export function translationFailureMessage(code?: string) {
  if (code === 'provider_not_translation') return '翻译服务未正确翻译原文，本次未扣费。可以重试此消息。'
  if (['provider_timeout','provider_unavailable','provider_rate_limit'].includes(code || '')) return '翻译服务暂时繁忙，本次未扣费。请稍后重试，其他消息可继续发送。'
  if (code === 'translation_outcome_unknown') return '上次翻译已结束且未扣费，可以重试此消息。'
  return '本次翻译未成功，云端已确认未扣费，可以重试此消息。'
}
const capabilityChecks = new Map<string, { until: number; work: Promise<boolean> }>()
export function clearCloudCapabilityCache() { capabilityChecks.clear() }
async function supportsQuality(base: string): Promise<boolean> {
  const cached = capabilityChecks.get(base)
  if (cached && cached.until > Date.now()) return cached.work
  const work = (async () => {
    const response = await fetch(`${base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    const value: any = await response.json()
    return response.ok && value?.features?.translationQuality === true
  })()
  const entry = { until: Date.now() + 60000, work }; capabilityChecks.set(base, entry)
  try { const result = await work; if (!result && capabilityChecks.get(base) === entry) capabilityChecks.delete(base); return result }
  catch (error) { if (capabilityChecks.get(base) === entry) capabilityChecks.delete(base); throw error }
}
export function validateCloudReceipt(payload: any, id: string, characters?: number): CloudReceipt {
  if(payload?.requestId===id&&payload.contentExpired===true)throw new TranslationOutcomeError('此历史译文已按保留期清理，原结算记录仍保留，不会自动重新翻译或扣费。')
  if (payload?.requestId !== id || typeof payload.translation !== 'string' || !payload.translation.trim()
    || !Number.isSafeInteger(payload.sourceCharacters) || payload.sourceCharacters < 1
    || (characters !== undefined && payload.sourceCharacters !== characters)
    || !Number.isSafeInteger(payload.balanceAfter) || payload.balanceAfter < 0) throw new TranslationOutcomeError('云端结算回执不完整，已保留原请求等待核对。')
  return payload
}

export class CloudflareProvider implements TranslationProvider {
  constructor(private readonly accessToken: TokenSource, private readonly apiBase?: string,
    private readonly onReceipt?: (value: CloudReceipt) => Promise<void>,
    private readonly identity:{owner:string;authorized?:()=>boolean}={owner:'provider-'+randomUUID()}) {}
  private async verifySelectedChannel(request:TranslationRequest,base:string) {
    if(request.providerPreference===undefined)return
    const channels=await readTranslationChannels(base,false,{...this.identity,token:this.accessToken}),selected=request.providerPreference
    if(!['deepseek','openai'].includes(selected)||!channels.selectionSupported||!channels[selected]?.available)
      throw new TranslationOutcomeError('所选翻译通道尚未启用或暂时无法连接，本次未发起翻译。请保留原消息并稍后重试。',true)
  }
  async repair(request: TranslationRequest): Promise<TranslationRepairReceipt> {
    const requestId = request.requestId
    if (!requestId) throw new TranslationOutcomeError(quarantinedTranslationMessage)
    const deadline = Date.now() + 42000, base = this.apiBase?.replace(/\/$/, '') || cloudBases()[0]
    // Repairs only annotate an existing debit. Capability failures leave that
    // original debit intact and never route the correction to another provider.
    await this.verifySelectedChannel(request,base)
    const body = { text: request.text.trim(), sourceLanguage: request.sourceLanguage || 'auto', targetLanguage: request.targetLanguage,
      accountId: request.accountId || '', conversationId: request.conversationId || '', context: request.context || [],
      ...(request.quality ? { quality: request.quality } : {}), ...(request.providerPreference ? {providerPreference:request.providerPreference}:{}), requestId }
    const finish = (payload: any): TranslationRepairReceipt => {
      const receipt = validateCloudReceipt(payload, requestId, Array.from(body.text).length)
      const expectedRepairId = 'repair-' + createHash('sha256').update('semantic-repair-v1:' + requestId).digest('hex')
      if (payload.chargedCharacters !== 0 || payload.repairOf !== requestId || payload.repairRequestId !== expectedRepairId
        || isSemanticTranslationMismatch(body.text, receipt.translation)) throw new TranslationOutcomeError(quarantinedTranslationMessage)
      // This is a free replacement annotation. Never emit the normal settlement
      // callback: it would overwrite the customer's original charged receipt.
      return payload
    }
    try {
      const response = await authenticatedFetch(this.accessToken, `${base}/api/translation-repair`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId }, body: JSON.stringify(body) }, 30000)
      const payload: any = await response.json().catch(() => null)
      if (response.ok && response.status !== 202) return finish(payload)
      if (response.status !== 202) throw new TranslationOutcomeError(quarantinedTranslationMessage)
    } catch (error) {
      if (error instanceof TranslationOutcomeError || error instanceof SessionUnavailableError) throw error
      // A lost repair response is resolved only through the same original ID.
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() + 300 * 2 ** attempt >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt))
      try {
        const response = await authenticatedFetch(this.accessToken, `${base}/api/translation-repair-status?requestId=${encodeURIComponent(requestId)}`,
          { headers: { Accept: 'application/json' }, cache: 'no-store' }, Math.min(10000, deadline - Date.now()))
        const payload: any = await response.json().catch(() => null)
        if (!response.ok || payload?.state === 'none' || payload?.state === 'failed') throw new TranslationOutcomeError(quarantinedTranslationMessage)
        if (payload?.state === 'completed') return finish(payload.response)
        if (payload?.state !== 'processing') throw new TranslationOutcomeError(quarantinedTranslationMessage)
      } catch (error) { if (error instanceof TranslationOutcomeError || error instanceof SessionUnavailableError) throw error }
    }
    throw new TranslationOutcomeError(quarantinedTranslationMessage)
  }
  async status(requestId: string, deadline = Date.now() + 20000): Promise<{ state: 'completed' | 'failed' | 'processing' | 'not_found'; response?: CloudReceipt; error?: string }> {
    const bases = this.apiBase ? [this.apiBase.replace(/\/$/, '')] : cloudBases()
    for (const base of bases) {
      if (Date.now() >= deadline) break
      let response: Response
      try { response = await authenticatedFetch(this.accessToken, `${base}/api/translation-status?requestId=${encodeURIComponent(requestId)}`, {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      }, Math.min(10000, deadline - Date.now())) } catch (error) { if (error instanceof SessionUnavailableError) throw error; continue }
      const payload: any = await response.json().catch(() => null)
      if (response.ok && ['completed', 'failed', 'processing', 'not_found'].includes(payload?.state)) {
        if (payload.state === 'completed') payload.response = validateCloudReceipt(payload.response, requestId)
        return payload
      }
      if (response.status === 401) throw new Error('在线登录状态已过期，请重新登录。')
      if (response.status === 404) throw new TranslationOutcomeError('服务端尚未提供结果查询，原请求已保留。请在记录中核对，不要重新创建任务。')
    }
    throw new TranslationOutcomeError('暂时无法核对原请求。恢复连接后继续查询。')
  }
  async translate(request: TranslationRequest): Promise<string> {
    const deadline = Date.now() + 42000
    const body = { text: request.text.trim(), sourceLanguage: request.sourceLanguage || 'auto', targetLanguage: request.targetLanguage,
      accountId: request.accountId || '', conversationId: request.conversationId || '', context: request.context || [],
      ...(request.quality ? { quality: request.quality } : {}), ...(request.providerPreference ? {providerPreference:request.providerPreference}:{}) }
    const requestId = request.requestId || (request.messageId
      ? `message-${createHash('sha256').update(JSON.stringify([request.messageId, body])).digest('hex')}` : randomUUID())
    const base = this.apiBase?.replace(/\/$/, '') || cloudBases()[0]
    const finish = async (value: any) => {
      const receipt = validateCloudReceipt(value, requestId, Array.from(body.text).length)
      await this.onReceipt?.(receipt)
      if (isSemanticTranslationMismatch(body.text, receipt.translation)) throw new TranslationOutcomeError(quarantinedTranslationMessage)
      return receipt.translation
    }
    try { await this.verifySelectedChannel(request,base) }
    catch(error) {
      if(!(error instanceof TranslationOutcomeError))throw error
      // A disabled channel must not hide an earlier settled response. Never
      // send another translation or switch providers while resolving this ID.
      const result=await this.status(requestId,deadline)
      if(result.state==='completed')return finish(result.response)
      throw new TranslationOutcomeError(error.message,result.state==='not_found'||result.state==='failed')
    }
    if (qualityKey(request.quality)) {
      let supported: boolean
      try { supported = await supportsQuality(base) }
      catch { throw new TranslationOutcomeError('尚未连通翻译选项服务，本次未发起翻译、未扣费。', true) }
      if (!supported) throw new TranslationOutcomeError('服务端尚未启用语气与术语功能。本次未发起翻译、未扣费。', true)
    }
    let response: Response | undefined
    let payload: any
    try {
      response = await authenticatedFetch(this.accessToken, `${base}/api/translate`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ ...body, requestId }) }, Math.min(30000, deadline - Date.now()))
      payload = await response.json()
    } catch (error) { if (error instanceof SessionUnavailableError) throw new TranslationOutcomeError(error.message); /* Response lost: only query this ID. */ }
    if (response?.ok && response.status !== 202 && payload?.translation) return finish(payload)
    // Authentication or wallet rejection does not prove that an earlier attempt
    // with this immutable ID was never settled. Retain the record for a lookup.
    if (response?.status === 401) throw new TranslationOutcomeError('在线登录状态已过期，请重新登录后核对原请求。')
    if (response?.status === 403) throw new TranslationOutcomeError('账号已停用，无法使用在线翻译。原请求仍需核对。')
    if (response?.status === 402) throw new TranslationOutcomeError('可用字符余额不足。原请求已保留，结算以查询结果为准。')
    if(payload?.error==='provider_not_available') {
      clearTranslationChannels()
      const result=await this.status(requestId,deadline)
      if(result.state==='completed')return finish(result.response)
      throw new TranslationOutcomeError('所选翻译通道暂未启用。原消息已保留，请稍后重试，或为新消息选择其他通道。',result.state==='not_found'||result.state==='failed')
    }
    if (response?.status === 429 || payload?.error === 'security_paused') {
      const status = await this.status(requestId, deadline)
      if (status.state === 'completed') return finish(status.response)
      const message = payload?.error === 'cost_limit' ? '今日翻译费用已达到保护上限，请联系管理员核对。' : payload?.error === 'security_paused' ? '翻译正在安全维护，请稍后继续。' : '翻译请求较多，请稍后重试。'
      throw new TranslationOutcomeError(message + '原消息和草稿已保留。', status.state === 'not_found' || status.state === 'failed')
    }
    if (terminalFailures.has(payload?.error)) throw new TranslationOutcomeError(translationFailureMessage(payload.error), true)
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() + 300 * 2 ** attempt >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt))
      const result = await this.status(requestId, deadline)
      if (result.state === 'completed') return finish(result.response)
      if (result.state === 'failed') throw new TranslationOutcomeError(translationFailureMessage(result.error), true)
    }
    throw new TranslationOutcomeError('翻译结果待确认，原请求和草稿已保留。恢复连接后继续核对。')
  }
}
