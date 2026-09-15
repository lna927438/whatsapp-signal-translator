import type { SecurityWorkerBindings, ScheduledController, ExecutionContext } from '../worker-configuration'
import { providerConfig, providerPlan, type ProviderEnv, type ProviderConfig } from './providerConfig'
import { boundedJson, rateKey, providerTokenBounds } from './requestSecurity'
import { ProviderFailure, classifyProviderFailure, providerMessages, checkProviderReadiness } from './providerDiagnostics'
import { normalizeQuality, protectLiterals, type TranslationQuality } from '../../../src/shared/translationPolicy'
import { wrongTargetLanguage, wrongOutgoingTargetLanguage } from '../../../src/shared/translationResult'
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
  OPENAI_MODEL: string
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
    const allowed = ['account_disabled', 'insufficient_characters', 'request_id_conflict', 'invalid_request', 'request_not_found', 'rate_limited', 'cost_limit', 'security_paused']
    throw new Error(allowed.includes(String(error.message)) ? error.message : 'database_error')
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

async function getWallet(env: Env, userId: string) {
  const rows = await adminGet<Array<{ balance: number; lifetime_credited: number; lifetime_debited: number; updated_at: string }>>(
    env,
    `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=balance,reserved_characters,lifetime_credited,lifetime_debited,updated_at&limit=1`
  )
  return rows[0] || { balance: 0, lifetime_credited: 0, lifetime_debited: 0, updated_at: null }
}

async function getProfile(env: Env, userId: string) {
  const rows = await adminGet<Array<{ id: string; username: string | null; email: string | null; plan_code: string; status: string; created_at: string }>>(
    env,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,email,plan_code,status,created_at&limit=1`
  )
  return rows[0] || null
}

function translationInstructions(sourceLanguage: string, targetLanguage: string, context: TranslateBody['context'], quality?: TranslationQuality): string {
  const recent = Array.isArray(context)
    ? context.slice(-4).map((item) => `${item?.role || 'message'}: ${String(item?.text || '').slice(0, 500)}`).join('\n')
    : ''
  return [
    `Translate the current message from ${sourceLanguage || 'auto-detected language'} to ${targetLanguage || 'the requested target language'}.`,
    'Return only the translation. Do not answer the message, explain it, summarize it, or add quotation marks.',
    'Copy every __HDPROTECTED_0__ style placeholder exactly once and unchanged. They represent protected URLs, numbers, names or glossary terms.',
    quality?.tone === 'business' ? 'Use clear professional business language without adding information.' : 'Use natural conversational language that matches the original tone.',
    'Preserve meaning, tone, slang, profanity, sarcasm, names, numbers, emojis, punctuation, and line breaks as naturally as possible.',
    'Short words, abbreviations, insults, and internet slang must be translated according to their conversational meaning when a natural equivalent exists.',
    recent ? `Recent conversation context (for disambiguation only; translate ONLY the current message):\n${recent}` : ''
  ].filter(Boolean).join('\n')
}

async function providerTranslate(env: Env, body: TranslateBody, text: string, receipt:ProviderReceipt,
  config: ProviderConfig = providerConfig(env), timeoutMs = 20_000): Promise<{ translation: string; latencyMs: number; model: string }> {
  const started = Date.now()
  const protectedText = protectLiterals(text, body.quality)
  if (!config.key) throw new ProviderFailure('provider_auth')
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
      instructions: translationInstructions(String(body.sourceLanguage || ''), String(body.targetLanguage || ''), body.context, body.quality),
      input: protectedText.input,
      max_output_tokens: providerTokenBounds(body.text || '', translationInstructions(String(body.sourceLanguage || ''), String(body.targetLanguage || ''), body.context, body.quality)).output,
      reasoning: { effort: 'none' },
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
  try { output = protectedText.restore(output) } catch { throw new ProviderFailure('protected_literal_mismatch') }
  let languageSample = output
  for (const literal of [...protectedText.values].sort((a, b) => b.length - a.length)) languageSample = languageSample.split(literal).join(' ')
  const target = String(body.targetLanguage || '')
  // The desktop refuses any remaining Han in a foreign-language send. Apply
  // that same rule before charging, including protected terms that would make
  // this particular outgoing result unsendable; preserve zh/ja target text.
  const blockedOutgoing = body.requestId?.startsWith('send-') && wrongOutgoingTargetLanguage(output, target)
  if (blockedOutgoing || wrongTargetLanguage(languageSample, target)) throw new ProviderFailure('provider_wrong_language')
  return { translation: output, latencyMs: Date.now() - started, model: String(payload?.model || config.model) }
}

type Claim = { state: 'claimed' | 'processing' | 'completed' | 'failed'; response?: unknown; error?: string }

function failure(code: string): Response {
  const errors: Record<string, [number, string]> = {
    account_disabled: [403, '账号已停用，无法使用在线服务。'],
    insufficient_characters: [402, '可用字符余额不足。'],
    request_id_conflict: [409, '此请求编号已经用于不同的翻译，请勿重复使用。'],
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
  const bounds = providerTokenBounds(body.text, translationInstructions(body.sourceLanguage, body.targetLanguage, body.context, body.quality))
  let claim: Claim
  const claimBody = {
    p_user_id: user.id,
    p_request_id: requestId,
    p_payload_hash: await requestHash(body, plan.length > 1 ? 'routing-v2' : model),
    p_characters: unicodeLength(body.text),
    p_claim_token: claimToken,
    p_metadata: {
      metering_version: plan.length > 1 ? '2' : '1', requested_model: model,
      ...(plan.length > 1 ? { provider_plan: plan.map(item => ({ provider: item.provider, model: item.model })) } : {}),
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
        .filter(item => item !== (plan.length > 1 ? 'routing-v2' : model))
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
  if (claim.state !== 'claimed') return claimResponse(claim)

  const work = plan.length > 1
    ? settleRoutedTranslation(env, body, requestId, user.id, claimToken, plan, deadline)
    : settleTranslation(env, body, requestId, user.id, claimToken, model)
  // A tab refresh or a timed-out desktop request must not abandon a claimed
  // translation before its result/failure and wallet reservation are settled.
  ctx?.waitUntil(work.then(() => undefined, () => undefined))
  return work
}

type ProviderAttempt = {
  provider: string; model: string; startedAt: string; finishedAt: string
  errorCode: string | null; receipt: ProviderReceipt
}
type RouteLease = { allowed: boolean; generation: number; probeToken: string | null; retryAfterMs: number }

function providerErrorCode(error: unknown) {
  return error instanceof ProviderFailure ? error.code
    : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'provider_timeout' : 'provider_unavailable'
}

async function settleRoutedTranslation(env: Env, body: ReturnType<typeof normalizeBody>, requestId: string,
  userId: string, claimToken: string, plan: ProviderConfig[], deadline: number): Promise<Response> {
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
    const timeoutMs = Math.min(index === 0 ? 8000 : 12000, deadline - Date.now())
    if (timeoutMs < 250) break
    const receipt = providerReceipt(config.model)
    const attempt: ProviderAttempt = { provider: config.provider, model: config.model,
      startedAt: new Date().toISOString(), finishedAt: '', errorCode: null, receipt }
    attempts.push(attempt)
    try {
      translated = await providerTranslate(env, body, body.text, receipt, config, timeoutMs)
      selectedProvider = config.provider
    } catch (error) {
      failureCode = providerErrorCode(error)
      attempt.errorCode = failureCode
      console.warn(JSON.stringify({ event: 'translation_provider_attempt_failed', provider: config.provider,
        model: config.model, code: failureCode, status: receipt.httpStatus,
        attempt: attempts.length, latencyMs: Date.now() - Date.parse(attempt.startedAt) }))
    }
    attempt.finishedAt = new Date().toISOString()
    try {
      await adminPost(env, '/rest/v1/rpc/provider_route_outcome', { ...routeArgs,
        p_generation: lease.generation, p_probe_token: lease.probeToken,
        p_success: attempt.errorCode === null, p_error_code: attempt.errorCode
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
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'realtime-translator-api', release: 'hellodog-translation-0.5.11', model: providerConfig(env).model, routing: providerPlan(env).map(({ provider, model }) => ({ provider, model })), features: { translationQuality: true, translationStatus: true, accountSnapshot: true, adminUsers: true, providerUsage: true, clientNotices: true, adminMfa: true, costProtection: true, providerFailover: providerPlan(env).length > 1 } })
  if (request.method === 'GET' && url.pathname === '/health/translation') return json({ service: 'realtime-translator-api', release: 'hellodog-translation-0.5.11', provider: { configured: Boolean(providerConfig(env).key), liveProbe: false } })

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
  if (request.method === 'GET' && url.pathname === '/api/account-snapshot') {
    return json({ user: { id: user.id, email: user.email || null }, profile,
      ...await adminPost<Record<string, unknown>>(env, '/rest/v1/rpc/account_snapshot', { p_user_id: user.id }) })
  }
  if (request.method === 'POST' && url.pathname === '/api/translate') return translate(request, env, user, translationDeadline, ctx)
  return json({ error: 'not_found', message: 'API route not found.' }, 404)
}

export default {
  async fetch(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    try {
      const work = route(request, env, ctx)
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/translate') ctx?.waitUntil(work.then(() => undefined, () => undefined))
      return await work
    } catch (error) {
      if (error instanceof Response) return error
      const code = error instanceof Error ? error.message : 'internal_error'
      if (['account_disabled', 'insufficient_characters', 'request_id_conflict', 'invalid_request', 'rate_limited', 'cost_limit', 'security_paused'].includes(code)) return failure(code)
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
