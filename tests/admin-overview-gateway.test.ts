import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
let actor = USER
let calls: string[] = []
let authStatus = 200
let edgeAllowed = true
let overviewUnavailable = false
let sessionId: string
const originalFetch = globalThis.fetch
const env: Env = { API_RATE_LIMITER: { limit: async () => ({ success: edgeAllowed }) },
  SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public', SUPABASE_SECRET_KEY: 'fixture-service' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, env.SUPABASE_URL, 'No external calls are allowed')
    calls.push(url.pathname)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      return reply({ id: actor, factors: [{ factor_type: 'totp', status: 'verified' }] }, authStatus)
    }
    assert.equal(headers.get('apikey'), env.SUPABASE_SECRET_KEY)
    const name = url.pathname.split('/').at(-1)!
    const args = JSON.parse(String(init?.body))
    try {
      if (name === 'admin_session_active') {
        return reply((await asRole<{ value: boolean }>(db, 'service_role', 'select public.admin_session_active($1,$2) value', [args.p_actor, args.p_session])).rows[0].value)
      }
      if (name === 'security_rate_limit' || name === 'record_security_event') return reply(await rpc(db, name, args))
      if (name === 'admin_overview') {
        assert.deepEqual(args, { p_actor: actor })
        if (overviewUnavailable) return reply({ message: 'private database detail' }, 503)
        return reply((await asRole<{ value: unknown }>(db, 'service_role', 'select public.admin_overview($1) value', [args.p_actor])).rows[0].value)
      }
      assert.equal(name, 'admin_read', 'No expensive cost RPC may be used for the overview')
      return reply((await asRole<{ value: unknown }>(db, 'service_role', 'select public.admin_read($1,$2,$3::jsonb) value', [args.p_actor, args.p_kind, JSON.stringify(args.p_filter)])).rows[0].value)
    } catch (error) { return reply({ message: (error as Error).message }, 400) }
  }
})
beforeEach(async () => {
  await reset(db)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')", [USER])
  sessionId = randomUUID()
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [sessionId, USER])
  actor = USER; calls = []; authStatus = 200; edgeAllowed = true; overviewUnavailable = false
})
after(async () => { globalThis.fetch = originalFetch; await db.close() })

function token(patch: Record<string, unknown> = {}) {
  const now = Date.now()/1000
  const value = { sub: actor, iss: env.SUPABASE_URL + '/auth/v1', aud: 'authenticated', role: 'authenticated',
    aal: 'aal2', amr: [{ method: 'totp', timestamp: now }], session_id: sessionId, iat: now-5, exp: now+3600, ...patch }
  return Buffer.from('{"alg":"RS256"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.fixture-signature'
}
function request(path = 'overview', patch: Record<string, unknown> = {}, origin = 'https://admin.hellodog.net') {
  return worker.fetch(new Request('https://worker.invalid/api/admin/' + path, { headers: { Authorization: 'Bearer ' + token(patch), Origin: origin } }), env)
}
const authCalls = ['/auth/v1/user','/rest/v1/rpc/admin_session_active','/rest/v1/rpc/security_rate_limit']

test('overview uses its lightweight RPC only after fresh authentication, active session, and admin rate limiting', async () => {
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(calls, [...authCalls, '/rest/v1/rpc/admin_overview'])
  const body = await response.json() as any
  assert.equal(body.users, 2)
  assert.equal(body.todayCharacters, 0)
  assert.equal(body.costs.mismatches, 0)
  assert.ok(body.snapshotAt)
  assert.doesNotMatch(JSON.stringify(body), /fixture-service|source_text|translation_text/)
})

test('other admin reads retain their original RPC and validated filter contract', async () => {
  const response = await request('users?q=first')
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [...authCalls, '/rest/v1/rpc/admin_read'])
  assert.equal((await response.json() as any).rows.length, 1)
})

test('ordinary accounts cannot use the lightweight overview or forge its actor', async () => {
  actor = OTHER
  await db.query('update auth.sessions set user_id=$1 where id=$2', [OTHER, sessionId])
  const response = await request()
  // The existing session guard rejects non-admin accounts before the RPC.
  assert.equal(response.status, 401)
  assert.deepEqual(calls, authCalls.slice(0, 2))
  await assert.rejects(asRole(db, 'service_role', 'select public.admin_overview($1)', [OTHER]), /admin_forbidden/)
  actor = USER
  await db.query('update auth.sessions set user_id=$1 where id=$2', [USER, sessionId])
  const forged = await request('overview?p_actor=' + OTHER)
  assert.equal(forged.status, 400)
})

test('missing MFA, revoked sessions, and denied auth cannot reach overview data', async () => {
  assert.equal((await request('overview', { aal: 'aal1', amr: [] })).status, 403)
  assert.ok(!calls.includes('/rest/v1/rpc/admin_overview'))
  calls = []
  await db.query('delete from auth.sessions where id=$1', [sessionId])
  assert.equal((await request()).status, 401)
  assert.deepEqual(calls, authCalls.slice(0, 2))
  for (const status of [401,503]) {
    calls = []; authStatus = status
    assert.equal((await request()).status, status)
    assert.deepEqual(calls, ['/auth/v1/user'])
  }
})

test('admin account rate limits and edge limits still protect the lightweight path', async () => {
  await db.query("insert into translator_private.api_rate_windows(user_id,bucket,scope,requests) values($1,floor(extract(epoch from clock_timestamp())/60),'admin',120)", [USER])
  const response = await request()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.ok(!calls.includes('/rest/v1/rpc/admin_overview'))
  calls = []; edgeAllowed = false
  assert.equal((await request()).status, 429)
  assert.deepEqual(calls, [])
})

test('invalid filters and origins are rejected; unavailable overview is never returned as zero counts', async () => {
  assert.equal((await request('overview?timezone=invalid')).status, 400)
  assert.ok(!calls.includes('/rest/v1/rpc/admin_overview'))
  calls = []
  assert.equal((await request('overview', {}, 'https://attacker.invalid')).status, 403)
  assert.deepEqual(calls, [])
  overviewUnavailable = true
  const response = await request()
  assert.equal(response.status, 503)
  assert.doesNotMatch(await response.text(), /private database detail|"users"|"todayCharacters"/)
})

test('health exposes hotfix capabilities without touching authentication or account data', async () => {
  const response = await worker.fetch(new Request('https://worker.invalid/health'), env)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.features.clientMeConsolidated, true)
  assert.equal(body.features.adminOverviewLightweight, true)
  assert.deepEqual(calls, [])
})
