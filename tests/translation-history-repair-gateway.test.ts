import { before, after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, wallet, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
const originalFetch = globalThis.fetch
const source = 'What is your point of view?'
const invalid = '作为一个AI助手，我没有个人情感或主观立场。'
const corrected = '你怎么看？'
const model = 'deepseek-v4-pro'
const body = { requestId: 'history-question', text: source, sourceLanguage: 'auto', targetLanguage: 'zh-CN', accountId: 'account-a', conversationId: 'conversation-a', context: [] }
const env: Env = { API_RATE_LIMITER: { limit: async () => ({ success: true }) }, SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-service', TRANSLATION_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-provider', DEEPSEEK_MODEL: model }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let calls = 0
let resultText = corrected
let loseCommitReply = false
before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.deepseek.com' && url.pathname === '/responses' || url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
      calls++
      return reply({ id: 'test-provider-response', status: 'completed', model:JSON.parse(String(init?.body)).model, output_text: resultText, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0,cache_write_tokens:0 }, output_tokens: 20, total_tokens: 120 } })
    }
    assert.equal(url.origin, env.SUPABASE_URL, 'tests must not use the real network')
    if (url.pathname === '/auth/v1/user') return reply({ id: new Headers(init?.headers).get('Authorization') === 'Bearer other' ? OTHER : USER })
    assert.equal(new Headers(init?.headers).get('apikey'), 'test-service')
    if (url.pathname === '/rest/v1/profiles') return reply((await asRole(db, 'service_role', 'select * from public.profiles where id=$1', [url.searchParams.get('id')!.slice(3)])).rows)
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!
      let value
      try { value = await rpc(db, name, JSON.parse(String(init?.body))) } catch (error: any) { return reply({ message: error.message }, 400) }
      if (name === 'complete_translation_metered' && loseCommitReply) { loseCommitReply = false; throw new Error('Lost reply after committed repair') }
      return reply(value)
    }
    throw new Error('Unexpected test request ' + url.pathname)
  }
})
after(async () => { globalThis.fetch = originalFetch; await db?.close() })
beforeEach(async () => { await reset(db); await db.exec('delete from translator_private.provider_circuits'); calls = 0; resultText = corrected; loseCommitReply = false;delete env.TRANSLATION_SELECTABLE_PROVIDERS;delete env.OPENAI_API_KEY;delete env.OPENAI_TRIAL_USER_IDS })
async function seed(translation = invalid,providerPreference?:'openai'|'deepseek') {
  const provider=providerPreference||'deepseek',seedModel=provider==='openai'?'gpt-5.6-luna':model
  const args = { p_user_id: USER, p_request_id: body.requestId, p_claim_token: randomUUID() }
  const hash = createHash('sha256').update(JSON.stringify(['translation-v1', 'routing-v2', body.text, body.sourceLanguage, body.targetLanguage, body.accountId, body.conversationId, body.context,...(providerPreference?[{providerPreference}]:[])])).digest('hex')
  await rpc(db, 'begin_translation', { ...args, p_payload_hash: hash, p_characters: Array.from(source).length, p_metadata: { metering_version: '2', provider, requested_model: seedModel, provider_plan: [{ provider, model:seedModel }],...(provider==='deepseek'?{provider_correction: { provider: 'deepseek', model, maxAttempts: 1 }}:{}), account_id: body.accountId, conversation_id: body.conversationId, source_language: 'auto', target_language: 'zh-CN', security_input_token_bound: 10000, security_output_token_bound: 1024 } })
  const at = new Date().toISOString()
  await rpc(db, 'complete_translation_metered', { ...args, p_translation: translation, p_model: seedModel, p_latency_ms: 10, p_receipt: { version: 2, selectedProvider: provider, attempts: [{ provider, model:seedModel, startedAt: at, finishedAt: at, errorCode: null, receipt: { model:seedModel, httpStatus: 200, inputTokens: 100, cachedTokens: 0,cacheWriteTokens:0,serviceTier:'default', outputTokens: 20, totalTokens: 120, createdAt: at } }] } })
}
const request = (patch: Record<string, unknown> = {}, token = 'owner') => worker.fetch(new Request('https://worker.invalid/api/translation-repair', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...patch }) }), env)
const status = () => worker.fetch(new Request('https://worker.invalid/api/translation-repair-status?requestId=' + body.requestId, { headers: { Authorization: 'Bearer owner' } }), env)

test('explicit OpenAI repair stays on the original provider and never changes its paid debit',async()=>{
 env.TRANSLATION_SELECTABLE_PROVIDERS='deepseek,openai';env.OPENAI_API_KEY='isolated-repair-test'
 await seed(invalid,'openai');const before=await wallet(db)
 assert.equal((await request({providerPreference:'deepseek'})).status,409)
 assert.equal(calls,0)
 const first=await request({providerPreference:'openai'}),value=await first.json() as any
 assert.equal(first.status,200);assert.equal(value.model,'gpt-5.6-luna');assert.equal(value.translation,corrected);assert.equal(value.chargedCharacters,0)
 assert.deepEqual(await (await request({providerPreference:'openai'})).json(),value)
 assert.equal(calls,1);assert.deepEqual(await wallet(db),before)
 const rows=(await db.query<any>('select provider from translator_private.provider_attempt_usage')).rows
 assert.ok(rows.every(row=>row.provider==='openai'))
})

test('trial repair requires the current verified account and preserves its original debit',async()=>{
 env.TRANSLATION_SELECTABLE_PROVIDERS='deepseek,openai';env.OPENAI_API_KEY='isolated-repair-test';env.OPENAI_TRIAL_USER_IDS=OTHER
 await seed(invalid,'openai');const before=await wallet(db)
 const denied=await request({providerPreference:'openai',userId:OTHER,accountId:OTHER})
 assert.equal(denied.status,503);assert.equal((await denied.json()).error,'provider_not_available')
 assert.equal(calls,0);assert.deepEqual(await wallet(db),before)
 env.OPENAI_TRIAL_USER_IDS=USER
 const fixed=await request({providerPreference:'openai'}),value=await fixed.json() as any
 assert.equal(fixed.status,200);assert.equal(value.translation,corrected);assert.equal(value.chargedCharacters,0)
 assert.equal(calls,1);assert.deepEqual(await wallet(db),before)
 env.OPENAI_TRIAL_USER_IDS=''
 assert.equal((await request({providerPreference:'openai'})).status,503)
 const existing=await status();assert.equal(existing.status,200);assert.deepEqual((await existing.json() as any).response,value)
 assert.equal(calls,1);assert.deepEqual(await wallet(db),before)
})

test('a paid legacy answer is repaired under one durable job with no new character debit, including a lost commit response', async () => {
  await seed(); const before = await wallet(db); loseCommitReply = true
  const first = await request(); assert.equal(first.status, 200)
  const value: any = await first.json(); assert.equal(value.translation, corrected); assert.equal(value.requestId, body.requestId)
  assert.equal(value.chargedCharacters, 0); assert.equal(value.repairOf, body.requestId); assert.match(value.repairRequestId, /^repair-/)
  const replay = await request(); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), value)
  const normalReplay = await worker.fetch(new Request('https://worker.invalid/api/translate', { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env)
  assert.equal(normalReplay.status, 200); assert.equal((await normalReplay.json() as any).translation, invalid, 'ordinary replay preserves the paid receipt; only explicit repair returns a free replacement')
  assert.equal(calls, 1); assert.deepEqual(await wallet(db), before)
  const snapshot: any = await (await status()).json(); assert.equal(snapshot.state, 'completed'); assert.deepEqual(snapshot.response, value)
  const original: any = await rpc(db, 'translation_status', { p_user_id: USER, p_request_id: body.requestId })
  assert.equal(original.response.translation, invalid, 'original settled receipt remains immutable')
  assert.equal((await db.query<any>("select count(*)::int n from public.character_ledger where type='translation'")).rows[0].n, 1)
  assert.equal((await db.query<any>('select count(*)::int n from public.translation_usage')).rows[0].n, 1)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.provider_usage')).rows[0].n, 2, 'provider repair cost must still be recorded')
})

test('an altered original payload or another owner cannot request a free repair', async () => {
  await seed(); const before = await wallet(db)
  for (const patch of [{ text: 'What is your point of sale?' }, { text: 'As an AI, I have no personal views.' },
    { sourceLanguage: 'en-US' }, { targetLanguage: 'en-US' }, { accountId: 'account-b' }, { conversationId: 'conversation-b' },
    { quality: { tone: 'business' } }, { context: [{ role: 'incoming', text: 'new context' }] }]) {
    const r = await request(patch); assert.equal(r.status, 409, JSON.stringify(patch))
    assert.equal((await r.json() as any).error, 'request_id_conflict')
  }
  assert.notEqual((await request({}, 'other')).status, 200)
  assert.equal(calls, 0); assert.deepEqual(await wallet(db), before)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n, 0)
})

test('already faithful translations are returned without a free inference or new ledger row', async () => {
  await seed(corrected)
  const r = await request(); assert.equal(r.status, 200)
  const value: any = await r.json(); assert.equal(value.translation, corrected)
  const before = await wallet(db)
  for (const patch of [{ text: 'A different source message.' }, { sourceLanguage: 'en-US' }, { targetLanguage: 'en-US' },
    { accountId: 'account-b' }, { conversationId: 'conversation-b' }, { quality: { tone: 'business' } },
    { context: [{ role: 'incoming', text: 'new context' }] }]) {
    const changed = await request(patch); assert.equal(changed.status, 409, 'faithful early return must still validate '+JSON.stringify(patch))
    assert.equal((await changed.json() as any).error, 'request_id_conflict')
  }
  assert.equal(calls, 0)
  assert.deepEqual(await wallet(db), before)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n, 0)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.provider_usage')).rows[0].n, 1)
})

test('a rejected repair is terminal and never changes the original paid receipt or starts a third provider attempt', async () => {
  await seed(); const before = await wallet(db); resultText = invalid
  const a = await request(); assert.equal(a.status, 502)
  const b = await request(); assert.equal(b.status, 502)
  assert.equal(calls, 2); assert.deepEqual(await wallet(db), before)
  const state: any = await (await status()).json(); assert.equal(state.state, 'failed')
  assert.equal((await rpc(db, 'translation_status', { p_user_id: USER, p_request_id: body.requestId })).response.translation, invalid)
})

test('concurrent repair requests share one provider job and a complete result can be recovered by original ID', async () => {
  await seed(); const before = await wallet(db)
  const results = await Promise.all([request(), request(), request()])
  for (const result of results) assert.ok([200,202].includes(result.status))
  const state: any = await (await status()).json(); assert.equal(state.state, 'completed'); assert.equal(state.response.translation, corrected)
  assert.equal(calls, 1); assert.deepEqual(await wallet(db), before)
})
