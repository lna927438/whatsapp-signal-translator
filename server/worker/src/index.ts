import type { SecurityWorkerBindings, ScheduledController, ExecutionContext } from '../worker-configuration'
import { providerConfig, providerPlan, type ProviderEnv, type ProviderConfig } from './providerConfig'
import { boundedJson, rateKey, providerTokenBounds } from './requestSecurity'
import { ProviderFailure, classifyProviderFailure, providerMessages, checkProviderReadiness } from './providerDiagnostics'
import { normalizeQuality, protectLiterals, type TranslationQuality } from '../../../src/shared/translationPolicy'
import { wrongTargetLanguage, wrongOutgoingTargetLanguage } from '../../../src/shared/translationResult'
import { isSemanticTranslationMismatch } from '../../../src/shared/translationSemantics'
import { translationInstructions, translationInput, type TranslationCorrection } from './translationPrompt'
import { handleAdmin, supabaseAdminServices } from './admin'
import { noticeReceiptBody } from './clientNotices'
import { providerReceipt, captureProviderReceipt, type ProviderReceipt } from './providerUsage'
import { syncBillingSnapshots, type BillingSyncEnv } from './billingSync'

export interface Env extends ProviderEnv, BillingSyncEnv {
  API_RATE_LIMITER: SecurityWorkerBindings['API_RATE_LIMITER']
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_SECRET_KEY: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
}

type User = { id: string; email?: string; user_metadata?: Record<string, unknown> }

type TranslateBody = {
  quality?: TranslationQuality
  text?: string
  sourceLanguage?: string
  targetLanguage?: string
  requestId?: string
  conversationId?: string
  accountId?: string
  context?: Array<{ role?: string; text?: string }>
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-request-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store'
  , 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function bearer(request: Request): string {
  const value = request.headers.get('Authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function unicodeLength(value: string): number {
  return Array.from(value).length
}

function safeId(value: string | undefined): string {
  return String(value || '').trim().slice(0, 160)
}

async function requireUser(request: Request, env: Env): Promise<User> {
  const token = bearer(request)
  if (!token) throw new Response(JSON.stringify({ error: 'unauthorized', message: '缺少登录令牌。' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  let response: Response
  try {
    response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
    })
  } catch { throw json({ error: 'auth_unavailable', message: '登录服务暂时无法连接，请稍后重试。草稿已保留。' }, 503) }
  if (!response.ok) {
    if (response.status !== 401 && response.status !== 403) throw json({ error: 'auth_unavailable', message: '登录服务暂时繁忙，请稍后重试。' }, 503)
    throw json({ error: 'unauthorized', message: '登录状态无效或已过期。' }, 401)
  }
  return response.json() as Promise<User>
}

async function adminGet<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error('database_error')
  return response.json() as Promise<T>
}

async function adminPost<T>(env: Env, path: string, body: unknown, prefer?: string, timeoutMs = 15000): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string }
    const allowed = ['account_disabled', 'insufficient_characters', 'request_id_conflict', 'invalid_request', 'request_not_found', 'translation_content_unavailable', 'rate_limited', 'cost_limit', 'security_paused']
    throw new Error(allowed.includes(String(error.message)) ? error.message : 'database_error')
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

async function getWallet(env: Env, userId: string) {
  const rows = await adminGet<Array<{ balance: number; lifetime_credited: number; lifetime_debited: number; lifetime_adjusted_down: number; updated_at: string }>>(
    env,
    `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=balance,reserved_characters,lifetime_credited,lifetime_debited,lifetime_adjusted_down,updated_at&limit=1`
  )
  return rows[0] || { balance: 0, lifetime_credited: 0, lifetime_debited: 0, lifetime_adjusted_down: 0, updated_at: null }
}

async function getProfile(env: Env, userId: string) {
  const rows = await adminGet<Array<{ id: string; username: string | null; email: string | null; plan_code: string; status: string; created_at: string }>>(
    env,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,email,plan_code,status,created_at&limit=1`
  )
  return rows[0] || null
}

class InvalidTranslationFailure extends ProviderFailure {
  constructor(code: TranslationCorrection, readonly completeResponse: boolean) { super(code) }
}

async function providerTranslate(env: Env, body: TranslateBody, text: string, receipt:ProviderReceipt,
  config: ProviderConfig = providerConfig(env), timeoutMs = 20_000, correction?: TranslationCorrection): Promise<{ translation: string; latencyMs: number; model: string }> {
  const started = Date.now()
  const protectedText = protectLiterals(text, body.quality)
  if (!config.key) throw new ProviderFailure('provider_auth')
  const instructions = translationInstructions(body.quality, correction, body.targetLanguage)
  const input = translationInput(protectedText.input, String(body.sourceLanguage || ''), String(body.targetLanguage || ''), body.context)
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    // Leave time for settlement before the desktop's 30-second POST timeout.
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions, input,
      max_output_tokens: providerTokenBounds(body.text || '', instructions).output,
      reasoning: { effort: 'none' },
      ...(config.provider === 'deepseek' ? { temperature: 0.2 } : {}),
      ...(config.provider === 'openai' ? { service_tier: 'default' } : {}),
      store: false
    })
  })

  // Keep the HTTP evidence even if the response body is interrupted. A body
  // timeout is still a timeout, not an empty successful translation.
  captureProviderReceipt(receipt, {}, response, started)
  const payload: any = await response.json()
  captureProviderReceipt(receipt, payload, response, started)
  if (!response.ok) {
    throw classifyProviderFailure(response.status, payload)
  }

  let output = String(payload?.output_text || '').trim()
  const refused = Array.isArray(payload?.output) && payload.output.some((item: any) =>
    Array.isArray(item?.content) && item.content.some((part: any) => part?.type === 'refusal'))
  if (refused) throw new InvalidTranslationFailure('provider_not_translation', payload.status === 'completed')
  if (!output && Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) continue
      for (const part of item.content) {
        if (part?.type === 'output_text' && part?.text) output += `${part.text}\n`
      }
    }
    output = output.trim()
  }
  if (!output || (payload.status && payload.status !== 'completed')) throw new ProviderFailure('provider_empty')
  if (output === input.trim()) throw new InvalidTranslationFailure('provider_not_translation', payload.status === 'completed')
  try { output = protectedText.restore(output) } catch { throw new InvalidTranslationFailure('protected_literal_mismatch', payload.status === 'completed') }
  let languageSample = output
  for (const literal of [...protectedText.values].sort((a, b) => b.length - a.length)) languageSample = languageSample.split(literal).join(' ')
  const target = String(body.targetLanguage || '')
  // The desktop refuses any remaining Han in a foreign-language send. Apply
  // that same rule before charging, including protected terms that would make
  // this particular outgoing result unsendable; preserve zh/ja target text.
  const blockedOutgoing = body.requestId?.startsWith('send-') && wrongOutgoingTargetLanguage(output, target)
  if (blockedOutgoing || wrongTargetLanguage(languageSample, target)) throw new InvalidTranslationFailure('provider_wrong_language', payload.status === 'completed')
  if (isSemanticTranslationMismatch(text, output)) throw new InvalidTranslationFailure('provider_not_translation', payload.status === 'completed')
  return { translation: output, latencyMs: Date.now() - started, model: String(payload?.model || config.model) }
}

type Claim = { state: 'claimed' | 'processing' | 'completed' | 'failed'; response?: unknown; error?: string }

function failure(code: string): Response {
  const errors: Record<string, [number, string]> = {
    account_disabled: [403, '账号已停用，无法使用在线服务。'],
    insufficient_characters: [402, '可用字符余额不足。'],
    request_id_conflict: [409, '此请求编号已经用于不同的翻译，请勿重复使用。'],
    request_not_found: [404, '未找到可核对的原翻译记录。'],
    translation_repair_unavailable: [409, '此条记录暂不能自动修复。原账目保留，可在记录中免费手动修正。'],
    translation_content_unavailable: [409, '原译文内容已清理，原结算记录保留，不会再次扣费。'],
    invalid_request: [400, '翻译请求格式无效。'],
    translation_failed: [502, '本次翻译失败，未扣减字符。'],
    translation_outcome_unknown: [409, '上次请求结果未能确认，未扣减字符；该请求不会自动再次调用翻译服务。'],
    settlement_pending: [503, '翻译结果正在确认，请使用同一请求编号重试。']
    , rate_limited: [429, '请求较多，请稍后继续。原消息和草稿已保留。']
    , cost_limit: [429, '今日翻译费用已达到保护上限，请联系管理员核对。']
    , security_paused: [503, '翻译服务正在安全维护，原消息和草稿已保留。']
  }
  const providerMessage = providerMessages[code as keyof typeof providerMessages]
  const [status, message] = providerMessage ? [502, providerMessage] : errors[code] || [500, '服务器处理请求失败。']
  const response = json({ error: code, message }, status)
  if (status === 429) response.headers.set('Retry-After', code === 'cost_limit' ? '3600' : '60')
  return response
}

function claimResponse(claim: Claim): Response {
  if (claim.state === 'completed') return json(claim.response)
  if (claim.state === 'processing') {
    const response = json({ error: 'translation_processing', message: '此翻译正在处理中。' }, 202)
    response.headers.set('Retry-After', '1')
    return response
  }
  return failure(claim.error || 'translation_failed')
}

function normalizeBody(raw: unknown): Required<Omit<TranslateBody, 'requestId' | 'quality'>> & Pick<TranslateBody, 'requestId' | 'quality'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_request')
  const b = raw as TranslateBody
  if (typeof b.text !== 'string' || typeof b.targetLanguage !== 'string') throw new Error('invalid_request')
  for (const value of [b.sourceLanguage, b.requestId, b.accountId, b.conversationId]) {
    if (value !== undefined && typeof value !== 'string') throw new Error('invalid_request')
  }
  const text = b.text.trim()
  const targetLanguage = b.targetLanguage.trim()
  if (!text || unicodeLength(text) > 10000 || !targetLanguage || targetLanguage.length > 160) throw new Error('invalid_request')
  if (b.context !== undefined && !Array.isArray(b.context)) throw new Error('invalid_request')
  const context = (b.context || []).slice(-4).map((item) => {
    if (!item || typeof item.text !== 'string' || !['incoming', 'outgoing'].includes(String(item.role))) throw new Error('invalid_request')
    return { role: item.role, text: item.text.slice(0, 500) }
  })
  return {
    text, targetLanguage, sourceLanguage: safeId(b.sourceLanguage) || 'auto',
    accountId: safeId(b.accountId), conversationId: safeId(b.conversationId), context,
    requestId: b.requestId, ...(b.quality ? { quality: normalizeQuality(b.quality) } : {})
  }
}

async function requestHash(body: TranslateBody, model: string): Promise<string> {
  // This canonical input includes everything that can change translation meaning.
  // Never include the request ID or access token in the content fingerprint.
  const input = JSON.stringify([
    'translation-v1', model, body.text, body.sourceLanguage, body.targetLanguage,
    body.accountId, body.conversationId, body.context, ...(body.quality ? [body.quality] : [])
  ])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function translationBounds(body: ReturnType<typeof normalizeBody>, allowCorrection: boolean) {
  const instructions = [undefined, 'protected_literal_mismatch', 'provider_wrong_language', 'provider_not_translation']
    .map(code => translationInstructions(body.quality, allowCorrection ? code as TranslationCorrection | undefined : undefined, body.targetLanguage))
    .sort((a, b) => new TextEncoder().encode(b).byteLength - new TextEncoder().encode(a).byteLength)[0]
  return providerTokenBounds(body.text, instructions + translationInput(
    protectLiterals(body.text, body.quality).input, body.sourceLanguage, body.targetLanguage, body.context))
}

async function repairTranslation(body: ReturnType<typeof normalizeBody>, env: Env, user: User, deadline: number,
  ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const originalId = body.requestId || ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(originalId)) return failure('invalid_request')
  const plan = providerPlan(env), config = plan[0]
  // Validate the immutable original before ANY successful early return. A
  // changed source can make a bad answer look faithful; semantic checks alone
  // cannot establish that this is the originally paid request. This RPC only
  // reads, so a rejected repair cannot create a claim or expire other jobs.
  const acceptedHashes = await Promise.all([...new Set(['routing-v2', config.model,
    String(env.OPENAI_MODEL || 'gpt-5.6-luna'), 'deepseek-v4-pro', 'deepseek-flash'])]
    .map(previousModel => requestHash(body, previousModel)))
  const original = await adminPost<Claim>(env, '/rest/v1/rpc/verify_original_translation', {
    p_user_id: user.id, p_request_id: originalId, p_payload_hashes: acceptedHashes, p_characters: unicodeLength(body.text)
  })
  const saved = original.response as { translation?: unknown; contentExpired?: boolean } | undefined
  if (original.state !== 'completed' || saved?.contentExpired || typeof saved?.translation !== 'string') return failure('translation_repair_unavailable')
  // The client cannot request free paraphrases or mark arbitrary text faulty.
  // Only an authenticated, settled original with a server-detected mismatch
  // enters this path. The DB additionally checks its exact immutable hash.
  if (!isSemanticTranslationMismatch(body.text, saved.translation)) return claimResponse(original)
  if (plan.length !== 1 || config?.provider !== 'deepseek' || config.model !== 'deepseek-v4-pro') return failure('translation_repair_unavailable')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('semantic-repair-v1:' + originalId))
  const repairId = 'repair-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  const claimToken = crypto.randomUUID(), bounds = translationBounds(body, true)
  const args = {
    p_user_id: user.id, p_original_request_id: originalId, p_characters: unicodeLength(body.text),
    p_request_id: repairId, p_claim_token: claimToken,
    p_metadata: {
      metering_version: '2', requested_model: config.model, provider: config.provider,
      provider_plan: [{ provider: config.provider, model: config.model }],
      provider_correction: { provider: config.provider, model: config.model, maxAttempts: 1 },
      security_input_token_bound: bounds.input, security_output_token_bound: bounds.output,
      account_id: body.accountId || null, conversation_id: body.conversationId || null,
      source_language: body.sourceLanguage, target_language: body.targetLanguage
    }
  }
  let claim: Claim | undefined
  for (const previousModel of [...new Set(['routing-v2', config.model, String(env.OPENAI_MODEL || 'gpt-5.6-luna'), 'deepseek-flash'])]) {
    try {
      claim = await adminPost<Claim>(env, '/rest/v1/rpc/begin_translation_repair', { ...args, p_payload_hash: await requestHash(body, previousModel) })
      break
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'request_id_conflict') throw error
    }
  }
  if (!claim) return failure('request_id_conflict')
  if (claim.state !== 'claimed') return claimResponse(claim)
  // Keep the original body.requestId for outgoing-language checks; only the
  // provider ledger/route job uses the separate, deterministic repair ID.
  const work = settleRoutedTranslation(env, body, repairId, user.id, claimToken, plan, deadline, true)
  ctx?.waitUntil(work.then(() => undefined, () => undefined))
  return work
}

async function translate(request: Request, env: Env, user: User, deadline: number, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const body = normalizeBody(await boundedJson(request))
  // Old 0.4.3 clients sent different header/body IDs. Keep the body authoritative.
  const requestId = body.requestId || request.headers.get('x-request-id') || ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) return failure('invalid_request')
  body.requestId = requestId
  const claimToken = crypto.randomUUID()
  const config = providerConfig(env)
  const plan = providerPlan(env)
  const model = config.model
  // The extra inference is enabled only for plans covered by the database's
  // explicit correction reservation. Legacy models retain their old contract.
  const correctionProvider = plan.at(-1)?.provider === 'deepseek' && plan.at(-1)?.model === 'deepseek-v4-pro'
    && (plan.length === 1 || plan[0].provider === 'openai' && plan[0].model === 'gpt-5.6-luna') ? plan.at(-1) : undefined
  const routed = plan.length > 1 || Boolean(correctionProvider)
  // Reserve for the largest supported correction, including the JSON data
  // envelope/context. Actual provider usage still comes exclusively from receipts.
  const bounds = translationBounds(body, Boolean(correctionProvider))
  let claim: Claim
  const claimBody = {
    p_user_id: user.id,
    p_request_id: requestId,
    p_payload_hash: await requestHash(body, routed ? 'routing-v2' : model),
    p_characters: unicodeLength(body.text),
    p_claim_token: claimToken,
    p_metadata: {
      metering_version: routed ? '2' : '1', requested_model: model,
      ...(routed ? { provider_plan: plan.map(item => ({ provider: item.provider, model: item.model })) } : {}),
      ...(correctionProvider ? { provider_correction: { provider: correctionProvider.provider, model: correctionProvider.model, maxAttempts: 1 } } : {}),
      security_input_token_bound: bounds.input, security_output_token_bound: bounds.output,
      provider: config.provider, account_id: body.accountId || null, conversation_id: body.conversationId || null,
      source_language: body.sourceLanguage, target_language: body.targetLanguage
    }
  }
  try {
    try { claim = await adminPost<Claim>(env, '/rest/v1/rpc/begin_translation', claimBody) }
    catch (error) {
      // A server-side Flash/Pro switch must not turn an otherwise identical
      // persisted request into a conflict. The database still verifies the
      // complete old fingerprint and returns its original terminal/pending
      // state; this never retries the provider or changes an old debit.
      if (!(error instanceof Error) || error.message !== 'request_id_conflict') throw error
      const compatibleModels = [...new Set(['routing-v2', model, String(env.OPENAI_MODEL || 'gpt-5.6-luna'), 'deepseek-v4-pro', 'deepseek-flash'])]
        .filter(item => item !== (routed ? 'routing-v2' : model))
      let resolved: Claim | undefined
      for (const previousModel of compatibleModels) {
        try {
          resolved = await adminPost<Claim>(env, '/rest/v1/rpc/begin_translation', {
            ...claimBody, p_payload_hash: await requestHash(body, previousModel)
          })
          break
        } catch (previousError) {
          if (!(previousError instanceof Error) || previousError.message !== 'request_id_conflict') throw previousError
        }
      }
      if (!resolved) throw error
      claim = resolved
    }
  } catch (error) {
    if (error instanceof Error && ['rate_limited','cost_limit','security_paused'].includes(error.message)) {
      await adminPost(env, '/rest/v1/rpc/record_security_event', { p_actor: user.id, p_code: error.message }).catch(() => undefined)
    }
    throw error
  }
  // A replay is the original paid receipt. Free replacements use the explicit
  // repair route so clients never mistake a replacement for a new settlement.
  if (claim.state !== 'claimed') return claimResponse(claim)

  const work = routed
    ? settleRoutedTranslation(env, body, requestId, user.id, claimToken, plan, deadline, Boolean(correctionProvider))
    : settleTranslation(env, body, requestId, user.id, claimToken, model)
  // A tab refresh or a timed-out desktop request must not abandon a claimed
  // translation before its result/failure and wallet reservation are settled.
  ctx?.waitUntil(work.then(() => undefined, () => undefined))
  return work
}

type ProviderAttempt = {
  provider: string; model: string; startedAt: string; finishedAt: string
  errorCode: string | null; receipt: ProviderReceipt; correction?: true
}
type RouteLease = { allowed: boolean; generation: number; probeToken: string | null; retryAfterMs: number }

function providerErrorCode(error: unknown) {
  return error instanceof ProviderFailure ? error.code
    : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'provider_timeout' : 'provider_unavailable'
}

async function settleRoutedTranslation(env: Env, body: ReturnType<typeof normalizeBody>, requestId: string,
  userId: string, claimToken: string, plan: ProviderConfig[], deadline: number, allowCorrection: boolean): Promise<Response> {
  const started = Date.now()
  const attempts: ProviderAttempt[] = []
  let translated: Awaited<ReturnType<typeof providerTranslate>> | undefined
  let selectedProvider: string | null = null
  let failureCode: string = 'provider_unavailable'
  for (let index = 0; index < plan.length; index++) {
    if (Date.now() >= deadline) break
    const config = plan[index]
    const routeArgs = { p_user_id: userId, p_request_id: requestId, p_claim_token: claimToken,
      p_provider: config.provider, p_model: config.model }
    let lease: RouteLease | undefined
    // A lost lease reply may be read back with identical arguments. No provider
    // invocation is permitted until the durable route decision is known.
    for (let lookup = 0; lookup < 2 && !lease && Date.now() < deadline; lookup++) {
      try { lease = await adminPost<RouteLease>(env, '/rest/v1/rpc/provider_route_acquire', routeArgs, undefined, 1500) }
      catch { /* Failed route lookup never authorizes an untracked invocation. */ }
    }
    if (!lease?.allowed) continue
    const timeoutMs = Math.min(config.provider === 'deepseek' ? 12000 : 8000, deadline - Date.now())
    if (timeoutMs < 250) break
    const receipt = providerReceipt(config.model)
    const attempt: ProviderAttempt = { provider: config.provider, model: config.model,
      startedAt: new Date().toISOString(), finishedAt: '', errorCode: null, receipt }
    attempts.push(attempt)
    let completeInvalidResponse = false
    try {
      translated = await providerTranslate(env, body, body.text, receipt, config, timeoutMs)
      selectedProvider = config.provider
    } catch (error) {
      failureCode = providerErrorCode(error)
      attempt.errorCode = failureCode
      completeInvalidResponse = error instanceof InvalidTranslationFailure && error.completeResponse
      console.warn(JSON.stringify({ event: 'translation_provider_attempt_failed', provider: config.provider,
        model: config.model, code: failureCode, status: receipt.httpStatus,
        attempt: attempts.length, latencyMs: Date.now() - Date.parse(attempt.startedAt) }))
    }
    attempt.finishedAt = new Date().toISOString()
    let outcome = attempt
    // A completed, explicitly invalid answer is different from an unknown
    // timeout. Only the final DeepSeek route may make one corrective call, and
    // its additional provider cost was reserved with the original claim.
    const correction = attempt.errorCode === 'provider_wrong_language' || attempt.errorCode === 'protected_literal_mismatch' || attempt.errorCode === 'provider_not_translation'
      ? attempt.errorCode : undefined
    const conflictingLiterals = body.requestId?.startsWith('send-') && wrongOutgoingTargetLanguage(
      protectLiterals(body.text, body.quality).values.join(' '), body.targetLanguage)
    if (allowCorrection && !translated && correction && completeInvalidResponse && receipt.httpStatus === 200 && config.provider === 'deepseek'
      && index === plan.length - 1 && !conflictingLiterals && Date.now() + 250 < deadline) {
      const correctedReceipt = providerReceipt(config.model)
      const corrected: ProviderAttempt = { provider: config.provider, model: config.model, correction: true,
        startedAt: new Date().toISOString(), finishedAt: '', errorCode: null, receipt: correctedReceipt }
      attempts.push(corrected)
      try {
        translated = await providerTranslate(env, body, body.text, correctedReceipt, config, Math.min(8000, deadline - Date.now()), correction)
        selectedProvider = config.provider
      } catch (error) {
        failureCode = providerErrorCode(error)
        corrected.errorCode = failureCode
        console.warn(JSON.stringify({ event: 'translation_provider_correction_failed', provider: config.provider,
          model: config.model, code: failureCode, status: correctedReceipt.httpStatus,
          attempt: attempts.length, latencyMs: Date.now() - Date.parse(corrected.startedAt) }))
      }
      corrected.finishedAt = new Date().toISOString()
      outcome = corrected
    }
    try {
      await adminPost(env, '/rest/v1/rpc/provider_route_outcome', { ...routeArgs,
        p_generation: lease.generation, p_probe_token: lease.probeToken,
        p_success: outcome.errorCode === null, p_error_code: outcome.errorCode
      }, undefined, 1500)
    } catch {
      // Lease expiry prevents a crashed/missing report from permanently opening
      // a circuit. The final immutable billing envelope still retains evidence.
      console.warn(JSON.stringify({ event: 'translation_route_outcome_pending', provider: config.provider, model: config.model }))
    }
    if (translated) break
  }
  const envelope = { version: 2, selectedProvider, attempts }
  const settlement = translated ? {
    path: '/rest/v1/rpc/complete_translation_metered', body: {
      p_user_id: userId, p_request_id: requestId, p_claim_token: claimToken,
      p_translation: translated.translation, p_model: translated.model,
      p_latency_ms: Date.now() - started, p_receipt: envelope
    }
  } : {
    path: '/rest/v1/rpc/fail_translation_metered', body: {
      p_user_id: userId, p_request_id: requestId, p_claim_token: claimToken,
      p_error_code: failureCode, p_receipt: envelope
    }
  }
  // Both providers share this one final transaction and customer debit. Retries
  // repeat the identical settlement only, never either inference or chat send.
  for (let retry = 0; retry < 3; retry++) {
    try { return claimResponse(await adminPost<Claim>(env, settlement.path, settlement.body, undefined, 2500)) }
    catch { /* Idempotent settlement survives a lost database commit reply. */ }
  }
  return failure('settlement_pending')
}

async function settleTranslation(env: Env, body: ReturnType<typeof normalizeBody>, requestId: string, userId: string, claimToken: string, model: string): Promise<Response> {
  const started = Date.now()
  let translated: Awaited<ReturnType<typeof providerTranslate>>
  const receipt=providerReceipt(model)
  try {
    translated = await providerTranslate(env, body, body.text, receipt)
  } catch (error: any) {
    const failureCode = error instanceof ProviderFailure ? error.code
      : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable'
    console.warn(JSON.stringify({ event: 'translation_provider_failure', code: failureCode,
      provider: providerConfig(env).provider, model, latencyMs: Date.now() - started,
      status: error instanceof ProviderFailure ? error.upstreamStatus : receipt.httpStatus }))
    // A provider timeout is ambiguous. Store a terminal outcome for this ID,
    // release its reservation, and never automatically call the provider again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const failed = await adminPost<Claim>(env, '/rest/v1/rpc/fail_translation_metered', {
          p_user_id: userId, p_request_id: requestId, p_claim_token: claimToken,
          p_error_code: failureCode, p_receipt: receipt
        }, undefined, 2500)
        return claimResponse(failed)
      } catch { /* Idempotent failure settlement, including a lost commit reply. */ }
    }
    return failure('settlement_pending')
  }

  // Retrying the database completion is safe: it stores the result, debits the
  // wallet and writes usage in ONE transaction, guarded by the claim token.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const completed = await adminPost<Claim>(env, '/rest/v1/rpc/complete_translation_metered', {
        p_user_id: userId, p_request_id: requestId, p_claim_token: claimToken,
        p_translation: translated.translation, p_model: translated.model,
        p_latency_ms: translated.latencyMs, p_receipt: receipt
      }, undefined, 2500)
      return claimResponse(completed)
    } catch (error) {
      if (error instanceof Error && error.message === 'account_disabled') return failure('account_disabled')
    }
  }
  // Leave the reservation/request pending on an uncertain commit. A retry must
  // look it up; it must never launch a second provider call.
  return failure('settlement_pending')
}

async function route(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  // Authentication and claiming consume the same provider budget. Preserve
  // time for durable settlement before the desktop's own request timeout.
  const translationDeadline = Date.now() + 20_000
  const url = new URL(request.url)
  if (request.method !== 'OPTIONS' && !(request.method === 'GET' && url.pathname === '/health')) {
    if (!env.API_RATE_LIMITER || !(await env.API_RATE_LIMITER.limit({ key: await rateKey(request) })).success) return failure('rate_limited')
  }
  if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, supabaseAdminServices(env))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'realtime-translator-api', release: 'hellodog-translation-0.5.16', model: providerConfig(env).model, routing: providerPlan(env).map(({ provider, model }) => ({ provider, model })), features: { translationQuality: true, translationStatus: true, translationSemanticGuard: true, translationRepair: true, translationTargetBound: true, translationQuestionGuard: true, accountSnapshot: true, adminUsers: true, providerUsage: true, clientNotices: true, adminMfa: true, costProtection: true, providerFailover: providerPlan(env).length > 1 } })
  if (request.method === 'GET' && url.pathname === '/health/translation') return json({ service: 'realtime-translator-api', release: 'hellodog-translation-0.5.15', provider: { configured: Boolean(providerConfig(env).key), liveProbe: false } })

  const user = await requireUser(request, env)
  const profile = await getProfile(env, user.id)
  if (!profile || profile.status !== 'active') return failure('account_disabled')
  if (!await adminPost<boolean>(env, '/rest/v1/rpc/security_rate_limit', { p_user_id: user.id, p_scope: 'api' })) return failure('rate_limited')

  if (request.method === 'GET' && url.pathname === '/api/notices') return json(await adminPost(env, '/rest/v1/rpc/client_notices', { p_user_id:user.id }))
  if (request.method === 'POST' && url.pathname === '/api/notices/receipt') {
    const body=await noticeReceiptBody(request);if(!body)return failure('invalid_request')
    return json(await adminPost(env,'/rest/v1/rpc/client_notice_receipt',{p_user_id:user.id,p_notice_id:body.id,p_revision:body.revision,p_state:body.state}))
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    await adminPost(env,'/rest/v1/rpc/touch_client_presence',{p_user_id:user.id}).catch(()=>null)
    return json({ user: { id: user.id, email: user.email || null }, profile, wallet: await getWallet(env, user.id) })
  }
  if (request.method === 'GET' && url.pathname === '/api/wallet') {
    return json({ wallet: await getWallet(env, user.id) })
  }
  if (request.method === 'GET' && url.pathname === '/api/usage') {
    const rows = await adminGet<any[]>(env, `/rest/v1/translation_usage?user_id=eq.${encodeURIComponent(user.id)}&select=request_id,source_characters,source_language,target_language,provider,model,latency_ms,created_at&order=created_at.desc&limit=50`)
    return json({ usage: rows })
  }
  if (request.method === 'GET' && url.pathname === '/api/translation-status') {
    const requestId = url.searchParams.get('requestId') || ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) return failure('invalid_request')
    return json(await adminPost(env, '/rest/v1/rpc/translation_status', { p_user_id: user.id, p_request_id: requestId }))
  }
  if (request.method === 'GET' && url.pathname === '/api/translation-repair-status') {
    const requestId = url.searchParams.get('requestId') || ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) return failure('invalid_request')
    return json(await adminPost(env, '/rest/v1/rpc/translation_repair_status', { p_user_id: user.id, p_original_request_id: requestId }))
  }
  if (request.method === 'GET' && url.pathname === '/api/account-snapshot') {
    return json({ user: { id: user.id, email: user.email || null }, profile,
      ...await adminPost<Record<string, unknown>>(env, '/rest/v1/rpc/account_snapshot', { p_user_id: user.id }) })
  }
  if (request.method === 'POST' && url.pathname === '/api/translate') return translate(request, env, user, translationDeadline, ctx)
  if (request.method === 'POST' && url.pathname === '/api/translation-repair') return repairTranslation(normalizeBody(await boundedJson(request)), env, user, translationDeadline, ctx)
  return json({ error: 'not_found', message: 'API route not found.' }, 404)
}

export default {
  async fetch(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    try {
      const work = route(request, env, ctx)
      if (request.method === 'POST' && ['/api/translate', '/api/translation-repair'].includes(new URL(request.url).pathname)) ctx?.waitUntil(work.then(() => undefined, () => undefined))
      return await work
    } catch (error) {
      if (error instanceof Response) return error
      const code = error instanceof Error ? error.message : 'internal_error'
      if (['account_disabled', 'insufficient_characters', 'request_id_conflict', 'request_not_found', 'translation_content_unavailable', 'invalid_request', 'rate_limited', 'cost_limit', 'security_paused'].includes(code)) return failure(code)
      // Do not log provider responses, bearer tokens, source text or secret values.
      console.error('translation_gateway_error')
      return failure('internal_error')
    }
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === '*/5 * * * *') {
      const result = await syncBillingSnapshots(env)
      // Log only completion states, never account balances, credentials or
      // detailed statements. Billing is separate from translation requests.
      console.info(JSON.stringify({ event: 'billing_sync', providers: Object.entries(result).map(([provider, value]) => ({ provider,
        ok: provider === 'deepseek' && 'sync' in value ? value.sync.status === 'fresh' : !('error' in value),
        skipped: 'skipped' in value || (provider === 'deepseek' && 'sync' in value && value.sync.status === 'not_configured'),
        errorCode: 'error' in value ? value.error : provider === 'deepseek' && 'sync' in value ? value.sync.lastError : null })) }))
      return
    }
    // Ignore retired or unexpected triggers while cloud configuration propagates.
    if (event.cron !== '17 * * * *') return
    const result = await adminPost(env, '/rest/v1/rpc/security_housekeeping', {})
    console.info(JSON.stringify({ event: 'security_housekeeping', result }))
  }
}
