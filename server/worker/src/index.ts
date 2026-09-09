interface Env {
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
  return response.json<User>()
}

async function adminGet<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`Supabase GET failed: ${response.status} ${await response.text()}`)
  return response.json<T>()
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
  if (!response.ok) throw new Error(`Supabase POST failed: ${response.status} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

async function getWallet(env: Env, userId: string) {
  const rows = await adminGet<Array<{ balance: number; lifetime_credited: number; lifetime_debited: number; updated_at: string }>>(
    env,
    `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=balance,lifetime_credited,lifetime_debited,updated_at&limit=1`
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

async function openAITranslate(env: Env, body: TranslateBody, text: string): Promise<{ translation: string; latencyMs: number; model: string }> {
  const started = Date.now()
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5.6-luna',
      instructions: translationInstructions(String(body.sourceLanguage || ''), String(body.targetLanguage || ''), body.context),
      input: text,
      reasoning: { effort: 'none' },
      store: false
    })
  })

  const payload: any = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.error?.message || `OpenAI request failed (${response.status})`
    throw new Error(message)
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
  if (!output) throw new Error('OpenAI returned an empty translation.')
  return { translation: output, latencyMs: Date.now() - started, model: String(payload?.model || env.OPENAI_MODEL || 'gpt-5.6-luna') }
}

async function recordUsage(env: Env, userId: string, body: TranslateBody, requestId: string, chars: number, model: string, latencyMs: number) {
  try {
    await adminPost(env, '/rest/v1/translation_usage', {
      user_id: userId,
      request_id: requestId,
      account_id: safeId(body.accountId) || null,
      conversation_id: safeId(body.conversationId) || null,
      provider: 'openai',
      model,
      source_language: safeId(body.sourceLanguage) || null,
      target_language: safeId(body.targetLanguage) || null,
      source_characters: chars,
      cache_hit: false,
      latency_ms: latencyMs
    }, 'return=minimal')
  } catch (error) {
    console.error('usage record failed', error)
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (url.pathname === '/health') return json({ ok: true, service: 'realtime-translator-api', model: env.OPENAI_MODEL || 'gpt-5.6-luna' })

  const user = await requireUser(request, env)

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const [profile, wallet] = await Promise.all([getProfile(env, user.id), getWallet(env, user.id)])
    return json({ user: { id: user.id, email: user.email || null }, profile, wallet })
  }

  if (request.method === 'GET' && url.pathname === '/api/wallet') {
    return json({ wallet: await getWallet(env, user.id) })
  }

  if (request.method === 'GET' && url.pathname === '/api/usage') {
    const rows = await adminGet<any[]>(env, `/rest/v1/translation_usage?user_id=eq.${encodeURIComponent(user.id)}&select=request_id,source_characters,provider,model,latency_ms,created_at&order=created_at.desc&limit=50`)
    return json({ usage: rows })
  }

  if (request.method === 'POST' && url.pathname === '/api/translate') {
    const body = await request.json<TranslateBody>().catch(() => ({}))
    const text = String(body.text || '').trim()
    if (!text) return json({ error: 'invalid_request', message: '翻译文本不能为空。' }, 400)
    if (unicodeLength(text) > 10000) return json({ error: 'text_too_long', message: '单次翻译最多 10,000 个字符。' }, 413)

    const requestId = safeId(body.requestId) || crypto.randomUUID()
    const chars = unicodeLength(text)
    const wallet = await getWallet(env, user.id)
    if (Number(wallet.balance || 0) < chars) return json({ error: 'insufficient_characters', message: '字符余额不足。', required: chars, balance: Number(wallet.balance || 0) }, 402)

    const translated = await openAITranslate(env, body, text)

    let balanceAfter: number
    try {
      balanceAfter = await adminPost<number>(env, '/rest/v1/rpc/consume_characters', {
        p_user_id: user.id,
        p_amount: chars,
        p_idempotency_key: requestId,
        p_source: 'cloudflare-translate',
        p_note: '实时翻译',
        p_metadata: {
          model: translated.model,
          account_id: safeId(body.accountId) || null,
          conversation_id: safeId(body.conversationId) || null
        }
      })
    } catch (error: any) {
      if (String(error?.message || '').includes('insufficient_characters')) return json({ error: 'insufficient_characters', message: '字符余额不足。' }, 402)
      throw error
    }

    await recordUsage(env, user.id, body, requestId, chars, translated.model, translated.latencyMs)
    return json({
      requestId,
      translation: translated.translation,
      sourceCharacters: chars,
      balanceAfter: Number(balanceAfter || 0),
      latencyMs: translated.latencyMs,
      model: translated.model
    })
  }

  return json({ error: 'not_found', message: 'API route not found.' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      if (error instanceof Response) return error
      console.error(error)
      return json({ error: 'internal_error', message: '服务器处理请求失败。' }, 500)
    }
  }
}
