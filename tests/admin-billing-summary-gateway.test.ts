import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import worker, { type Env } from '../server/worker/src/index.ts'
import { supabaseAdminServices } from '../server/worker/src/admin.ts'
import { deepSeekCredentialDigest } from '../server/worker/src/deepseekBalance.ts'
import { currentMonthOfficialReportingBasis } from '../server/worker/src/officialBillScopes.ts'
import { database, reset, asRole, rpc, wallet, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
let actor = USER
let calls: Array<{ name: string; args: Record<string, unknown> }> = []
let authStatus = 200
let edgeAllowed = true
let summaryUnavailable = false
let sessionId: string
const originalFetch = globalThis.fetch
const env: Env = {
  API_RATE_LIMITER: { limit: async () => ({ success: edgeAllowed }) },
  SUPABASE_URL: 'https://billing-summary.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', SUPABASE_SECRET_KEY: 'synthetic-service',
  TRANSLATION_PROVIDER: 'deepseek', TRANSLATION_SELECTABLE_PROVIDERS: 'deepseek', DEEPSEEK_API_KEY: 'synthetic-deepseek'
}
const range = { from: '2026-09-14', to: '2026-09-14', timezone: 'UTC' }
const reply = (body: unknown, status = 200) => Response.json(body, { status })

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, env.SUPABASE_URL, 'No provider or other external request is allowed')
    const headers = new Headers(init?.headers)
    if (url.pathname === '/auth/v1/user') {
      calls.push({ name: 'auth', args: {} })
      assert.equal(headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      return reply({ id: actor, factors: [{ factor_type: 'totp', status: 'verified' }] }, authStatus)
    }
    assert.equal(headers.get('apikey'), env.SUPABASE_SECRET_KEY)
    assert.equal(headers.has('authorization'), false, 'The user JWT must never replace the service-role RPC credential')
    const name = url.pathname.split('/').at(-1)!, args = JSON.parse(String(init?.body))
    calls.push({ name, args })
    try {
      if (name === 'admin_session_active') return reply((await asRole<{ value: boolean }>(db, 'service_role', 'select public.admin_session_active($1,$2) value', [args.p_actor, args.p_session])).rows[0].value)
      if (name === 'security_rate_limit' || name === 'record_security_event') return reply(await rpc(db, name, args))
      assert.equal(init?.redirect, 'manual')
      if (name === 'admin_billing_summary') {
        assert.equal(args.p_actor, actor)
        assert.equal('p_kind' in args, false)
        if (summaryUnavailable) return reply({ message: 'private SQL detail and synthetic-secret', code: '57014' }, 500)
        return reply((await asRole<{ value: unknown }>(db, 'service_role', 'select public.admin_billing_summary($1,$2::jsonb) value', [args.p_actor, JSON.stringify(args.p_filter)])).rows[0].value)
      }
      assert.equal(name, 'read_current_official_bills', 'Automatic summaries must never invoke the full admin_read cost report')
      return reply((await asRole<{ value: unknown }>(db, 'service_role', 'select public.read_current_official_bills($1,$2::jsonb,$3::jsonb) value', [args.p_actor, JSON.stringify(args.p_filter), JSON.stringify(args.p_scopes)])).rows[0].value)
    } catch (error) { return reply({ message: (error as Error).message }, 400) }
  }
})
beforeEach(async () => {
  await db.exec('delete from translator_private.provider_bill_snapshots; delete from public.admin_audit')
  await reset(db)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')", [USER])
  sessionId = randomUUID()
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [sessionId, USER])
  actor = USER; calls = []; authStatus = 200; edgeAllowed = true; summaryUnavailable = false
})
after(async () => { globalThis.fetch = originalFetch; await db.close() })

function token(patch: Record<string, unknown> = {}) {
  const now = Date.now() / 1000
  const claims = { sub: actor, iss: env.SUPABASE_URL + '/auth/v1', aud: 'authenticated', role: 'authenticated',
    aal: 'aal2', amr: [{ method: 'totp', timestamp: now }], session_id: sessionId, iat: now - 5, exp: now + 3600, ...patch }
  return Buffer.from('{"alg":"RS256"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.synthetic-signature'
}
function request(suffix = new URLSearchParams(range).toString(), patch: Record<string, unknown> = {}, origin = 'https://admin.hellodog.net', method = 'GET') {
  return worker.fetch(new Request('https://worker.invalid/api/admin/billing-summary?' + suffix,
    { method, headers: { Authorization: 'Bearer ' + token(patch), Origin: origin } }), env)
}
const authCalls = ['auth', 'admin_session_active', 'security_rate_limit']
const names = () => calls.map(call => call.name)

test('billing summary uses its lightweight RPC after authentication, active session and both rate limits', async () => {
  const before = await wallet(db)
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://admin.hellodog.net')
  assert.deepEqual(names(), [...authCalls, 'admin_billing_summary', 'read_current_official_bills'])
  assert.deepEqual(calls[3].args, { p_actor: USER, p_filter: range })
  const body = await response.json() as any
  assert.deepEqual(body.totals, { charged_characters: 0, refunded_characters: 0 })
  assert.equal(Date.parse(body.from), Date.parse('2026-09-14T00:00:00Z'))
  assert.equal(Date.parse(body.toExclusive), Date.parse('2026-09-15T00:00:00Z'))
  assert.equal(body.timezone, 'UTC'); assert.ok(body.snapshotAt)
  assert.deepEqual(body.officialBills, [])
  assert.deepEqual(body.enabledProviders, ['deepseek'])
  assert.deepEqual(body.translationProviders, ['deepseek'])
  assert.equal(body.defaultTranslationProvider, 'deepseek')
  assert.equal(body.translationModels.deepseek.model, 'deepseek-v4-pro')
  assert.doesNotMatch(JSON.stringify(body), /synthetic-|credentialDigest|p_scopes|source_text|translation_text/)
  assert.deepEqual(await wallet(db), before)
})

test('official bills come only from the current provider account and native reporting period', async () => {
  const digest = await deepSeekCredentialDigest(env.DEEPSEEK_API_KEY)
  const record = async (scope: unknown, officialUsd: string, timezone = 'Asia/Shanghai') => asRole(db, 'service_role',
    'select public.record_scoped_official_statement($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [USER, randomUUID(), 'deepseek', 'Synthetic statement', JSON.stringify({ ...range, timezone, officialUsd, officialTokens: null, officialRequests: null, reference: 'Synthetic provider statement' }), JSON.stringify(scope)])
  await record({ credentialDigest: digest }, '0.300000000001')
  await record({ credentialDigest: 'b'.repeat(64) }, '99.9')
  const response = await request()
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.officialBills.length, 1)
  assert.equal(body.officialBills[0].official_usd_exact, '0.300000000001')
  assert.equal(body.officialBills[0].currentAccount, true)
  const official = calls.at(-1)!.args as any
  assert.deepEqual(official.p_filter, { ...range, provider: 'deepseek', timezone: 'Asia/Shanghai' })
  assert.deepEqual(official.p_scopes.deepseek, { credentialDigest: digest })
  assert.doesNotMatch(JSON.stringify(body), /credentialDigest|99\.9|synthetic-deepseek|actor_id|"scope"/)
  calls = []
  assert.equal((await request(new URLSearchParams({ ...range, provider: 'openai' }).toString())).status, 200)
  assert.deepEqual(names(), [...authCalls, 'admin_billing_summary'], 'A disabled provider must not read any account statement')
})

test('legacy non-owner roles remain rejected by the existing administrator-session boundary', async () => {
  await db.query("insert into public.admin_roles(user_id,role) values($1,'finance')", [OTHER])
  await db.query('update auth.sessions set user_id=$1 where id=$2', [OTHER, sessionId]); actor = OTHER
  const response = await request()
  assert.equal(response.status, 401)
  assert.deepEqual(names(), authCalls.slice(0, 2))
  assert.doesNotMatch(await response.text(), /officialBills|charged_characters/)
})

test('a summary without the owner marker never queries or receives official account statements', async t => {
  const observed: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, env.SUPABASE_URL)
    observed.push(url.pathname)
    assert.equal(url.pathname, '/rest/v1/rpc/admin_billing_summary')
    assert.deepEqual(JSON.parse(String(init?.body)).p_filter, range)
    return reply({ totals: { charged_characters: 123, refunded_characters: 2 }, snapshotAt: '2026-09-24T00:00:00Z' })
  })
  const result = await supabaseAdminServices(env).rpc('admin_billing_summary', { p_actor: OTHER, p_filter: { ...range, officialCurrentMonth: 'true' } }) as any
  assert.deepEqual(observed, ['/rest/v1/rpc/admin_billing_summary'])
  assert.equal('officialBills' in result, false); assert.equal('officialBillingBasis' in result, false)
  assert.equal('enabledProviders' in result, false)
  assert.deepEqual(result.totals, { charged_characters: 123, refunded_characters: 2 })
})

test('ordinary users, expired tokens, missing MFA and revoked sessions cannot reach billing summary data', async () => {
  actor = OTHER; await db.query('update auth.sessions set user_id=$1 where id=$2', [OTHER, sessionId])
  assert.equal((await request()).status, 401); assert.deepEqual(names(), authCalls.slice(0, 2))
  actor = USER; await db.query('update auth.sessions set user_id=$1 where id=$2', [USER, sessionId]); calls = []
  assert.equal((await request(undefined, { exp: 1 })).status, 401); assert.deepEqual(names(), ['auth'])
  calls = []
  assert.equal((await request(undefined, { aal: 'aal1', amr: [] })).status, 403)
  assert.ok(!names().includes('admin_billing_summary'))
  calls = []; await db.query('delete from auth.sessions where id=$1', [sessionId])
  assert.equal((await request()).status, 401); assert.deepEqual(names(), authCalls.slice(0, 2))
})

test('billing summary preserves edge and per-admin throttles, including safe retry metadata', async () => {
  edgeAllowed = false
  assert.equal((await request()).status, 429); assert.deepEqual(calls, [])
  edgeAllowed = true
  await db.query("insert into translator_private.api_rate_windows(user_id,bucket,scope,requests) values($1,floor(extract(epoch from clock_timestamp())/60),'admin',120)", [USER])
  const response = await request()
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60')
  assert.ok(!names().includes('admin_billing_summary')); assert.ok(!names().includes('read_current_official_bills'))
})

test('unsupported user scopes, forged accounts, and invalid reporting filters never reach the summary RPC', async () => {
  const invalid = ['userId=', 'userId=' + USER, 'p_actor=' + OTHER, 'scope=fake', 'credentialDigest=fake',
    'q=query', 'offset=0', 'operationId=' + USER, 'provider=other', 'timezone=wrong', 'from=not-a-date',
    'officialCurrentMonth=true', 'timezone=UTC&officialCurrentMonth=false',
    'timezone=Asia%2FShanghai&officialCurrentMonth=true', 'timezone=UTC&officialCurrentMonth=true&provider=deepseek']
  for (const suffix of invalid) {
    calls = []; const response = await request(suffix)
    assert.equal(response.status, 400, suffix)
    assert.equal((await response.json() as any).error, 'invalid_request')
    assert.ok(!names().includes('admin_billing_summary'), suffix)
  }
  calls = []
  assert.equal((await request(undefined, {}, 'https://attacker.invalid')).status, 403); assert.deepEqual(calls, [])
  assert.equal((await request(undefined, {}, 'https://admin.hellodog.net', 'POST')).status, 404)
  assert.ok(!names().includes('admin_billing_summary'))
})

test('failed authentication and summary SQL errors retain safe errors rather than returning zero characters', async () => {
  for (const status of [401, 503]) {
    authStatus = status; calls = []
    assert.equal((await request()).status, status); assert.deepEqual(names(), ['auth'])
  }
  authStatus = 200; calls = []; summaryUnavailable = true
  const response = await request()
  assert.equal(response.status, 503)
  assert.deepEqual(names(), [...authCalls, 'admin_billing_summary'])
  assert.doesNotMatch(await response.text(), /private SQL|synthetic-secret|57014|charged_characters|officialBills/)
})

test('current-month summary strips its presentation flag before SQL and never invokes the full cost RPC', async () => {
  const response = await request(new URLSearchParams({ ...range, officialCurrentMonth: 'true' }).toString())
  assert.equal(response.status, 200)
  assert.deepEqual(calls[3].args, { p_actor: USER, p_filter: range })
  const body = await response.json() as any
  const expected = currentMonthOfficialReportingBasis(Date.parse(body.snapshotAt))
  assert.deepEqual(body.officialBillingBasis, expected)
  assert.deepEqual(calls.at(-1)!.args.p_filter, { ...expected.periods.deepseek, provider: 'deepseek' })
  assert.equal(names().includes('admin_read'), false)
})

test('native-month boundaries and official account scope are preserved on the new RPC, even across rollover', async t => {
  const at = '2026-09-30T16:00:00Z'
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) + 86400000 })
  const dualEnv = { ...env, TRANSLATION_SELECTABLE_PROVIDERS: 'deepseek,openai', OPENAI_API_KEY: 'synthetic-openai',
    OPENAI_BILLING_ADMIN_KEY: 'synthetic-billing-admin', OPENAI_BILLING_PROJECT_ID: 'proj_synthetic', OPENAI_BILLING_API_KEY_IDS: 'key_synthetic' }
  const filter = { ...range, officialCurrentMonth: 'true' }
  const observed: Array<{ name: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, env.SUPABASE_URL)
    const name = url.pathname.split('/').at(-1)!, body = JSON.parse(String(init?.body)); observed.push({ name, body })
    if (name === 'admin_billing_summary') {
      assert.deepEqual(body, { p_actor: USER, p_filter: range })
      return reply({ totals: { charged_characters: 123, refunded_characters: 2 }, snapshotAt: at, officialBills: [{ scope: 'obsolete', official_usd_exact: '999' }] })
    }
    assert.equal(name, 'read_current_official_bills')
    const provider = body.p_filter.provider as 'openai' | 'deepseek'
    assert.deepEqual(body.p_filter, { ...currentMonthOfficialReportingBasis(Date.parse(at)).periods[provider], provider })
    assert.deepEqual(body.p_scopes.openai, { projectId: 'proj_synthetic', apiKeyIds: ['key_synthetic'] })
    assert.match(body.p_scopes.deepseek.credentialDigest, /^[a-f0-9]{64}$/)
    return reply([{ provider, official_usd_exact: '0.123456789012', currentAccount: true }])
  })
  const result = await supabaseAdminServices(dualEnv).rpc('admin_billing_summary', { p_actor: USER, p_filter: filter }) as any
  assert.deepEqual(filter, { ...range, officialCurrentMonth: 'true' })
  assert.deepEqual(observed.map(call => call.name), ['admin_billing_summary', 'read_current_official_bills', 'read_current_official_bills'])
  assert.deepEqual(result.totals, { charged_characters: 123, refunded_characters: 2 })
  assert.equal(result.officialBills.length, 2)
  assert.deepEqual(result.officialBillingBasis, currentMonthOfficialReportingBasis(Date.parse(at)))
  assert.doesNotMatch(JSON.stringify(result), /obsolete|synthetic-|credentialDigest|proj_synthetic|key_synthetic/)
})

test('one failed official bill read preserves character totals and the other provider without inventing a zero',async t=>{
  const dualEnv={...env,TRANSLATION_SELECTABLE_PROVIDERS:'deepseek,openai',OPENAI_API_KEY:'synthetic-openai',OPENAI_BILLING_ADMIN_KEY:'synthetic-billing',OPENAI_BILLING_PROJECT_ID:'proj_synthetic',OPENAI_BILLING_API_KEY_IDS:'key_synthetic'}
  let failed='deepseek',unauthorized=false
  t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,env.SUPABASE_URL)
    const name=url.pathname.split('/').at(-1),body=JSON.parse(String(init?.body))
    if(name==='admin_billing_summary')return reply({totals:{charged_characters:123,refunded_characters:2},snapshotAt:new Date().toISOString(),officialBills:[]})
    assert.equal(name,'read_current_official_bills')
    if(unauthorized)return reply({message:'admin_forbidden'},403)
    if(failed==='all'||body.p_filter.provider===failed)return reply({message:'private SQL failure with synthetic credential'},503)
    return reply([{provider:body.p_filter.provider,official_usd_exact:'0.123456789012'}])
  })
  const read=()=>supabaseAdminServices(dualEnv).rpc('admin_billing_summary',{p_actor:USER,p_filter:range}) as Promise<any>
  const partial=await read()
  assert.deepEqual(partial.totals,{charged_characters:123,refunded_characters:2})
  assert.deepEqual(partial.officialBills,[{provider:'openai',official_usd_exact:'0.123456789012'}])
  assert.deepEqual(partial.officialBillReadErrors,{deepseek:'unavailable'})
  assert.doesNotMatch(JSON.stringify(partial),/private SQL|synthetic|credential/)
  failed='all';const missing=await read()
  assert.deepEqual(missing.officialBills,[])
  assert.deepEqual(missing.officialBillReadErrors,{openai:'unavailable',deepseek:'unavailable'})
  assert.equal(missing.totals.charged_characters,123)
  unauthorized=true;await assert.rejects(read(),{message:'admin_forbidden'})
})
