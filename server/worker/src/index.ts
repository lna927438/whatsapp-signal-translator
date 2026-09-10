import { providerConfig, type ProviderEnv } from './providerConfig'
import { ProviderFailure, classifyProviderFailure, providerMessages, checkProviderReadiness } from './providerDiagnostics'

export interface Env extends ProviderEnv {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_SECRET_KEY: string
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
}

type User = { id: string; email?: string; user_metadata?: Record<string, unknown> }

type TranslateBody = {
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

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`
    }
  })
  if (!response.ok) throw new Response(JSON.stringify({ error: 'unauthorized', message: '登录状态无效或已过期。' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  return response.json() as Promise<User>
}

async function adminGet<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`Supabase GET failed: ${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}

async function adminPost<T>(env: Env, path: string, body: unknown, prefer?: string): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string }
    const allowed = ['account_disabled', 'insufficient_characters', 'request_id_conflict', 'invalid_request', 'request_not_found']
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

function translationInstructions(sourceLanguage: string, targetLanguage: string, context: TranslateBody['context']): string {
  const recent = Array.isArray(context)
    ? context.slice(-4).map((item) => `${item?.role || 'message'}: ${String(item?.text || '').slice(0, 500)}`).join('\n')
    : ''
  return [
    `Translate the current message from ${sourceLanguage || 'auto-detected language'} to ${targetLanguage || 'the requested target language'}.`,
    'Return only the translation. Do not answer the message, explain it, summarize it, or add quotation marks.',
    'Preserve meaning, tone, slang, profanity, sarcasm, names, numbers, emojis, punctuation, and line breaks as naturally as possible.',
    'Short words, abbreviations, insults, and internet slang must be translated according to their conversational meaning when a natural equivalent exists.',
    recent ? `Recent conversation context (for disambiguation only; translate ONLY the current message):\n${recent}` : ''
  ].filter(Boolean).join('\n')
}

async function providerTranslate(env: Env, body: TranslateBody, text: string): Promise<{ translation: string; latencyMs: number; model: string }> {
  const started = Date.now()
  const config = providerConfig(env)
  if (!config.key) throw new ProviderFailure('provider_auth')
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions: translationInstructions(String(body.sourceLanguage || ''), String(body.targetLanguage || ''), body.context),
      input: text,
      reasoning: { effort: 'none' },
      store: false
    })
  })

  const payload: any = await response.json().catch(() => ({}))
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
  if (!output) throw new ProviderFailure('provider_empty')
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
  }
  const providerMessage = providerMessages[code as keyof typeof providerMessages]
  const [status, message] = providerMessage ? [502, providerMessage] : errors[code] || [500, '服务器处理请求失败。']
  return json({ error: code, message }, status)
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

function normalizeBody(raw: unknown): Required<Omit<TranslateBody, 'requestId'>> & { requestId?: string } {
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
    requestId: b.requestId
  }
}

async function requestHash(body: TranslateBody, model: string): Promise<string> {
  // This canonical input includes everything that can change translation meaning.
  // Never include the request ID or access token in the content fingerprint.
  const input = JSON.stringify([
    'translation-v1', model, body.text, body.sourceLanguage, body.targetLanguage,
    body.accountId, body.conversationId, body.context
  ])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function translate(request: Request, env: Env, user: User): Promise<Response> {
  const body = normalizeBody(await request.json().catch(() => null))
  // Old 0.4.3 clients sent different header/body IDs. Keep the body authoritative.
  const requestId = body.requestId || request.headers.get('x-request-id') || ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) return failure('invalid_request')
  const claimToken = crypto.randomUUID()
  const config = providerConfig(env)
  const model = config.model
  const claim = await adminPost<Claim>(env, '/rest/v1/rpc/begin_translation', {
    p_user_id: user.id,
    p_request_id: requestId,
    p_payload_hash: await requestHash(body, model),
    p_characters: unicodeLength(body.text),
    p_claim_token: claimToken,
    p_metadata: {
      provider: config.provider, account_id: body.accountId || null, conversation_id: body.conversationId || null,
      source_language: body.sourceLanguage, target_language: body.targetLanguage
    }
  })
  if (claim.state !== 'claimed') return claimResponse(claim)

  let translated: Awaited<ReturnType<typeof providerTranslate>>
  try {
    translated = await providerTranslate(env, body, body.text)
  } catch (error: any) {
    const failureCode = error instanceof ProviderFailure ? error.code
      : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable'
    console.warn(JSON.stringify({ event: 'translation_provider_failure', code: failureCode, status: error instanceof ProviderFailure ? error.upstreamStatus : undefined }))
    // A provider timeout is ambiguous. Store a terminal outcome for this ID,
    // release its reservation, and never automatically call the provider again.
    try {
      const failed = await adminPost<Claim>(env, '/rest/v1/rpc/fail_translation', {
        p_user_id: user.id, p_request_id: requestId, p_claim_token: claimToken,
        p_error_code: failureCode
      })
      return claimResponse(failed)
    } catch {
      return failure('settlement_pending')
    }
  }

  // Retrying the database completion is safe: it stores the result, debits the
  // wallet and writes usage in ONE transaction, guarded by the claim token.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const completed = await adminPost<Claim>(env, '/rest/v1/rpc/complete_translation', {
        p_user_id: user.id, p_request_id: requestId, p_claim_token: claimToken,
        p_translation: translated.translation, p_model: translated.model,
        p_latency_ms: translated.latencyMs
      })
      return claimResponse(completed)
    } catch (error) {
      if (error instanceof Error && error.message === 'account_disabled') return failure('account_disabled')
    }
  }
  // Leave the reservation/request pending on an uncertain commit. A retry must
  // look it up; it must never launch a second provider call.
  return failure('settlement_pending')
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'realtime-translator-api', release: 'hellodog-deepseek-v1', model: providerConfig(env).model })
  if (request.method === 'GET' && url.pathname === '/health/translation') {
    return json({ service: 'realtime-translator-api', release: 'hellodog-deepseek-v1', provider: await checkProviderReadiness(env) })
  }

  const user = await requireUser(request, env)
  const profile = await getProfile(env, user.id)
  if (!profile || profile.status !== 'active') return failure('account_disabled')

  if (request.method === 'GET' && url.pathname === '/api/me') {
    return json({ user: { id: user.id, email: user.email || null }, profile, wallet: await getWallet(env, user.id) })
  }
  if (request.method === 'GET' && url.pathname === '/api/wallet') {
    return json({ wallet: await getWallet(env, user.id) })
  }
  if (request.method === 'GET' && url.pathname === '/api/usage') {
    const rows = await adminGet<any[]>(env, `/rest/v1/translation_usage?user_id=eq.${encodeURIComponent(user.id)}&select=request_id,source_characters,provider,model,latency_ms,created_at&order=created_at.desc&limit=50`)
    return json({ usage: rows })
  }
  if (request.method === 'POST' && url.pathname === '/api/translate') return translate(request, env, user)
  return json({ error: 'not_found', message: 'API route not found.' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      if (error instanceof Response) return error
      const code = error instanceof Error ? error.message : 'internal_error'
      if (['account_disabled', 'insufficient_characters', 'request_id_conflict', 'invalid_request'].includes(code)) return failure(code)
      // Do not log provider responses, bearer tokens, source text or secret values.
      console.error('translation_gateway_error')
      return failure('internal_error')
    }
  }
}
