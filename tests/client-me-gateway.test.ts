import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
let calls: string[] = []
let authStatus = 200
let edgeAllowed = true
let databaseUnavailable = false
const originalFetch = globalThis.fetch
const env: Env = {
  API_RATE_LIMITER: { limit: async () => ({ success: edgeAllowed }) },
  SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public', SUPABASE_SECRET_KEY: 'fixture-service'
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, env.SUPABASE_URL, 'No external calls are allowed in this fixture')
    calls.push(url.pathname)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(headers.get('authorization'), 'Bearer fixture-user')
      return reply({ id: USER, email: 'verified@example.invalid', user_metadata: { id: OTHER } }, authStatus)
    }
    assert.equal(url.pathname, '/rest/v1/rpc/client_me', 'Polling uses only one database round trip')
    assert.equal(init?.method, 'POST')
    assert.equal(headers.get('apikey'), env.SUPABASE_SECRET_KEY)
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body, { p_user_id: USER }, 'Only the freshly verified user selects the account')
    if (databaseUnavailable) return reply({ message: 'private detail must not leak' }, 503)
    try { return reply(await rpc(db, 'client_me', body)) }
    catch (error) { return reply({ message: (error as Error).message }, 400) }
  }
})
beforeEach(async () => {
  await reset(db)
  calls = []
  authStatus = 200
  edgeAllowed = true
  databaseUnavailable = false
})
after(async () => { globalThis.fetch = originalFetch; await db.close() })

function request(token = 'fixture-user') {
  return worker.fetch(new Request(`https://worker.invalid/api/me?user_id=${OTHER}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  }), env)
}

test('account polling keeps the existing public fields while reducing five calls to two', async () => {
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json() as any
  assert.deepEqual(body.user, { id: USER, email: 'verified@example.invalid' })
  assert.deepEqual(Object.keys(body).sort(), ['defaultTranslationProvider', 'profile', 'translationModels', 'translationProviders', 'user', 'wallet'])
  assert.deepEqual(body.translationProviders, [])
  assert.equal(body.defaultTranslationProvider, null)
  assert.deepEqual(Object.keys(body.profile).sort(), ['created_at','email','id','plan_code','status','username'])
  assert.equal(body.profile.id, USER)
  assert.deepEqual(Object.keys(body.wallet).sort(), ['balance','lifetime_adjusted_down','lifetime_credited','lifetime_debited','reserved_characters','updated_at'])
  assert.equal(body.wallet.balance, 100)
  assert.equal(body.wallet.lifetime_credited, 100)
  assert.equal(body.wallet.lifetime_debited, 0)
  assert.deepEqual(calls, ['/auth/v1/user','/rest/v1/rpc/client_me'])
  assert.doesNotMatch(JSON.stringify(body), /fixture-service|user_metadata|last_seen_at/)
})

test('provider choices add no polling round trips and never alter the combined customer totals', async () => {
  const configured: Env = {...env,TRANSLATION_PROVIDER:'deepseek',TRANSLATION_SELECTABLE_PROVIDERS:'deepseek,openai',DEEPSEEK_API_KEY:'synthetic-deepseek-secret',OPENAI_API_KEY:'synthetic-openai-secret'}
  await db.query('update public.wallets set balance=73,reserved_characters=8,lifetime_debited=22,lifetime_adjusted_down=5 where user_id=$1',[USER])
  const response=await worker.fetch(new Request('https://worker.invalid/api/me',{headers:{Authorization:'Bearer fixture-user'}}),configured)
  assert.equal(response.status,200)
  const body=await response.json() as any
  assert.deepEqual(body.translationProviders,['deepseek','openai']);assert.equal(body.defaultTranslationProvider,'deepseek')
  assert.deepEqual(body.translationModels,{deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'}})
  assert.deepEqual({balance:body.wallet.balance,credited:body.wallet.lifetime_credited,used:body.wallet.lifetime_debited,removed:body.wallet.lifetime_adjusted_down,reserved:body.wallet.reserved_characters},{balance:73,credited:100,used:22,removed:5,reserved:8})
  assert.deepEqual(calls,['/auth/v1/user','/rest/v1/rpc/client_me']);assert.doesNotMatch(JSON.stringify(body),/synthetic-.*-secret|usage|request_id/)
})

test('every poll verifies authentication and reads current balances, adjustments, and reservations', async () => {
  assert.equal((await request()).status, 200)
  await db.query('update public.wallets set balance=73,reserved_characters=8,lifetime_debited=22,lifetime_adjusted_down=5 where user_id=$1', [USER])
  const body = await (await request()).json() as any
  assert.equal(body.wallet.balance, 73)
  assert.equal(body.wallet.reserved_characters, 8)
  assert.equal(body.wallet.lifetime_debited, 22)
  assert.equal(body.wallet.lifetime_adjusted_down, 5)
  assert.deepEqual(calls, ['/auth/v1/user','/rest/v1/rpc/client_me','/auth/v1/user','/rest/v1/rpc/client_me'])
  const counts = (await db.query<{ ledger: number; usage: number }>('select (select count(*)::int from public.character_ledger) ledger,(select count(*)::int from public.translation_usage) usage')).rows[0]
  assert.deepEqual(counts, { ledger: 0, usage: 0 })
})

test('missing, expired, and temporarily unavailable authentication never reach the database', async () => {
  assert.equal((await request('')).status, 401)
  assert.deepEqual(calls, [])
  for (const status of [401, 403, 429, 503]) {
    calls = []; authStatus = status
    const response = await request()
    assert.equal(response.status, status < 429 ? 401 : 503)
    assert.deepEqual(calls, ['/auth/v1/user'])
  }
})

test('blocking an account is enforced immediately on the next poll', async () => {
  assert.equal((await request()).status, 200)
  await db.query("update public.profiles set status='blocked' where id=$1", [USER])
  const response = await request()
  assert.equal(response.status, 403)
  assert.equal((await response.json() as any).error, 'account_disabled')
  assert.equal((await db.query<{ requests: number }>('select sum(requests)::int requests from translator_private.api_rate_windows where user_id=$1', [USER])).rows[0].requests, 1)
})

test('service-only RPC denies client roles even when they select another account', async () => {
  for (const role of ['anon','authenticated'] as const) {
    await assert.rejects(asRole(db, role, 'select public.client_me($1)', [OTHER]), /permission denied/)
  }
  const privileges = (await db.query<{ definer: boolean; config: string[] }>("select prosecdef definer,proconfig config from pg_proc where oid='public.client_me(uuid)'::regprocedure")).rows[0]
  assert.equal(privileges.definer, false)
  assert.deepEqual(privileges.config, ['search_path=""'])
})

test('the existing edge and per-account API rate limits are preserved, including rejected attempt counts', async () => {
  edgeAllowed = false
  assert.equal((await request()).status, 429)
  assert.deepEqual(calls, [])
  edgeAllowed = true
  await db.query("insert into translator_private.api_rate_windows(user_id,bucket,scope,requests) values($1,floor(extract(epoch from clock_timestamp())/60),'api',180)", [USER])
  const response = await request()
  assert.equal(response.status, 429)
  assert.equal((await response.json() as any).error, 'rate_limited')
  assert.equal((await db.query<{ requests: number }>("select requests from translator_private.api_rate_windows where user_id=$1 and scope='api'", [USER])).rows[0].requests, 181)
})

test('the shared-IP edge guard has headroom for thirty online clients without changing the account limit', async () => {
  const config = JSON.parse(await readFile(new URL('../server/worker/wrangler.jsonc', import.meta.url), 'utf8'))
  const binding = config.ratelimits.find((entry: { name: string }) => entry.name === 'API_RATE_LIMITER')
  assert.deepEqual(binding.simple, { limit: 1800, period: 60 })
  const baselinePollsPerMinute = 30 * (60 / 5)
  assert.equal(baselinePollsPerMinute, 360)
  assert.ok(baselinePollsPerMinute < binding.simple.limit)
  // Use the real database rate function: independent users do not share the
  // stricter account window, and one blocked user cannot block another.
  await db.query("insert into translator_private.api_rate_windows(user_id,bucket,scope,requests) values($1,floor(extract(epoch from clock_timestamp())/60),'api',180)", [USER])
  assert.equal(await rpc(db, 'security_rate_limit', { p_user_id: USER, p_scope: 'api' }), false)
  assert.equal(await rpc(db, 'security_rate_limit', { p_user_id: OTHER, p_scope: 'api' }), true)
})

test('presence is updated at most every thirty seconds, without changing wallet data', async () => {
  await request()
  const first = (await db.query<{ seen: Date }>('select last_seen_at seen from public.profiles where id=$1', [USER])).rows[0].seen
  await request()
  const second = (await db.query<{ seen: Date }>('select last_seen_at seen from public.profiles where id=$1', [USER])).rows[0].seen
  assert.deepEqual(second, first)
  await db.query("update public.profiles set last_seen_at=clock_timestamp()-interval '31 seconds' where id=$1", [USER])
  await request()
  const recent = (await db.query<{ recent: boolean }>("select last_seen_at>clock_timestamp()-interval '2 seconds' recent from public.profiles where id=$1", [USER])).rows[0].recent
  assert.equal(recent, true)
})

test('database failures remain failures instead of fabricated zero balances', async () => {
  databaseUnavailable = true
  const response = await request()
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.doesNotMatch(JSON.stringify(body), /private detail|fixture-service|wallet|balance/)
})
