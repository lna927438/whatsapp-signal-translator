import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg, { type PoolClient, type QueryResultRow } from 'pg'
import worker, { type Env } from '../server/worker/src/index.ts'

const USER = '10000000-0000-4000-8000-000000000001'
const OTHER = '10000000-0000-4000-8000-000000000002'
const databaseName = `translator_regression_${randomUUID().replaceAll('-', '')}`
const connection = process.env.TRANSLATOR_TEST_PG_URL
if (!connection) throw new Error('TRANSLATOR_TEST_PG_URL must point to a disposable local PostgreSQL 17 instance')
const target = new URL(connection)
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('PostgreSQL integration tests only accept loopback hosts')
const admin = new pg.Client({ connectionString: connection })
let pool: pg.Pool
let created = false
const backendIds = new Set<number>()

async function transaction<T>(run: (client: PoolClient) => Promise<T>, role?: 'service_role' | 'authenticated' | 'anon') {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("set local statement_timeout = '15s'")
    if (role) await client.query(`set local role ${role}`)
    const result = await run(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}

async function service<T extends QueryResultRow = any>(sql: string, values: unknown[] = []) {
  return transaction(async client => {
    backendIds.add((await client.query('select pg_backend_pid() as pid')).rows[0].pid)
    return client.query<T>(sql, values)
  }, 'service_role')
}

function claimArgs(id: string, characters = 5, user = USER) {
  return { user, id, hash: 'a'.repeat(64), characters, token: randomUUID() }
}
type Args = ReturnType<typeof claimArgs>
async function begin(a: Args) {
  return (await service('select public.begin_translation($1,$2,$3,$4,$5,$6) as result',
    [a.user, a.id, a.hash, a.characters, a.token, '{}'])).rows[0].result
}
async function complete(a: Args) {
  return (await service('select public.complete_translation($1,$2,$3,$4,$5,$6) as result',
    [a.user, a.id, a.token, '译文', 'test-model', 1])).rows[0].result
}
async function fail(a: Args) {
  return (await service('select public.fail_translation($1,$2,$3,$4) as result',
    [a.user, a.id, a.token, 'translation_failed'])).rows[0].result
}
async function wallet() {
  return (await pool.query(`select balance::int, reserved_characters::int,
    lifetime_debited::int from public.wallets where user_id=$1`, [USER])).rows[0]
}
async function counts() {
  return (await pool.query(`select
    (select count(*)::int from public.character_ledger where type='translation') as debits,
    (select count(*)::int from public.translation_usage) as usages`)).rows[0]
}
async function waitForLocks(minimum: number) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'`)
    if (rows[0].n >= minimum) return
    await delay(20)
  }
  throw new Error(`Did not observe ${minimum} simultaneous PostgreSQL lock waiters`)
}
async function contend<T>(operations: Array<() => Promise<T>>) {
  const blocker = await pool.connect()
  await blocker.query('begin')
  await blocker.query('select 1 from public.wallets where user_id=$1 for update', [USER])
  const pending = Promise.allSettled(operations.map(run => run()))
  try { await waitForLocks(operations.length) }
  finally { await blocker.query('rollback'); blocker.release() }
  return pending
}

before(async () => {
  await admin.connect()
  const version = (await admin.query('show server_version')).rows[0].server_version as string
  assert.match(version, /^17\./)
  console.log(`Native PostgreSQL ${version}; temporary database ${databaseName}`)
  // The supplied instance must be disposable. Only the uniquely named database
  // below is populated or dropped; no existing application's tables are touched.
  for (const [name, bypass] of [['anon', false], ['authenticated', false], ['service_role', true]] as const) {
    if (!(await admin.query('select 1 from pg_roles where rolname=$1', [name])).rowCount) {
      await admin.query(`create role ${name} nologin ${bypass ? 'bypassrls' : ''}`)
    }
  }
  await admin.query(`create database ${databaseName}`)
  created = true
  target.pathname = '/' + databaseName
  pool = new pg.Pool({ connectionString: target.toString(), max: 32, connectionTimeoutMillis: 5000 })
  await pool.query(`
    create schema auth;
    grant usage on schema auth to authenticated, service_role;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `)
  const directory = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8')
    await transaction(client => client.query(sql))
  }
})
beforeEach(async () => {
  await pool.query('delete from auth.users')
  await pool.query('insert into auth.users(id,email) values ($1,$2),($3,$4)',
    [USER, 'first@example.invalid', OTHER, 'second@example.invalid'])
  await pool.query('update public.wallets set balance=100,lifetime_credited=100')
  backendIds.clear()
})
after(async () => {
  await pool?.end()
  if (created) await admin.query(`drop database ${databaseName}`)
  await admin.end()
})

test('twenty blocked connections acquire exactly one claim for one request', async () => {
  const candidates = Array.from({ length: 20 }, () => claimArgs('same-id'))
  const results = await contend(candidates.map(a => () => begin(a)))
  assert.equal(backendIds.size, 20)
  const fulfilled = results.map(r => { assert.equal(r.status, 'fulfilled'); return r.value })
  assert.equal(fulfilled.filter(r => r.state === 'claimed').length, 1)
  assert.equal(fulfilled.filter(r => r.state === 'processing').length, 19)
  assert.deepEqual(await wallet(), { balance: 100, reserved_characters: 5, lifetime_debited: 0 })
  const winner = candidates[fulfilled.findIndex(r => r.state === 'claimed')]
  assert.equal((await complete(winner)).state, 'completed')
  assert.deepEqual(await counts(), { debits: 1, usages: 1 })
})

test('twenty simultaneous settlements produce one debit, one usage and identical results', async () => {
  const a = claimArgs('settle')
  await begin(a)
  const results = await contend(Array.from({ length: 20 }, () => () => complete(a)))
  const completed = results.map(r => { assert.equal(r.status, 'fulfilled'); return r.value })
  for (const r of completed) { assert.equal(r.state, 'completed'); assert.deepEqual(r.response, completed[0].response) }
  assert.deepEqual(await wallet(), { balance: 95, reserved_characters: 0, lifetime_debited: 5 })
  assert.deepEqual(await counts(), { debits: 1, usages: 1 })
})

test('distinct concurrent requests reserve only the available balance', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => claimArgs(`quota-${i}`, 10))
  const results = await contend(candidates.map(a => () => begin(a)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10)
  for (const r of results.filter(r => r.status === 'rejected')) assert.match(r.reason.message, /insufficient_characters/)
  assert.deepEqual(await wallet(), { balance: 100, reserved_characters: 100, lifetime_debited: 0 })
  await Promise.all(results.map((r, i) => r.status === 'fulfilled' ? complete(candidates[i]) : undefined))
  assert.deepEqual(await wallet(), { balance: 0, reserved_characters: 0, lifetime_debited: 100 })
  assert.deepEqual(await counts(), { debits: 10, usages: 10 })
})

test('completion and failure racing leave one consistent terminal outcome', async () => {
  const a = claimArgs('complete-vs-fail')
  await begin(a)
  const results = await contend([() => complete(a), () => fail(a)])
  const states = results.map(r => { assert.equal(r.status, 'fulfilled'); return r.value.state })
  assert.equal(states[0], states[1])
  const charged = states[0] === 'completed'
  assert.deepEqual(await wallet(), { balance: charged ? 95 : 100, reserved_characters: 0, lifetime_debited: charged ? 5 : 0 })
  assert.deepEqual(await counts(), { debits: charged ? 1 : 0, usages: charged ? 1 : 0 })
})

test('a committed suspension wins against a completion waiting on the profile lock', async () => {
  const a = claimArgs('suspend')
  await begin(a)
  const blocker = await pool.connect()
  await blocker.query('begin')
  await blocker.query("update public.profiles set status='disabled' where id=$1", [USER])
  const pending = complete(a)
  try { await waitForLocks(1) }
  finally { await blocker.query('commit'); blocker.release() }
  const result = await pending
  assert.equal(result.error, 'account_disabled')
  assert.deepEqual(await wallet(), { balance: 100, reserved_characters: 0, lifetime_debited: 0 })
  assert.deepEqual(await counts(), { debits: 0, usages: 0 })
})

test('legacy debit requests remain idempotent under real connection contention', async () => {
  const results = await contend(Array.from({ length: 20 }, () => () => service(
    "select public.consume_characters($1,5,'legacy-duplicate') as balance", [USER])))
  for (const r of results) { assert.equal(r.status, 'fulfilled'); assert.equal(Number(r.value.rows[0].balance), 95) }
  assert.deepEqual(await wallet(), { balance: 95, reserved_characters: 0, lifetime_debited: 5 })
  assert.deepEqual(await counts(), { debits: 1, usages: 0 })
})

test('ordinary roles cannot truncate, mutate protected profile fields or call privileged RPCs', async () => {
  for (const role of ['anon', 'authenticated'] as const) {
    await assert.rejects(transaction(c => c.query('truncate public.wallets'), role), /permission denied/)
    await assert.rejects(transaction(c => c.query("select public.begin_translation($1,'bad',$2,1,$3,'{}')", [USER, 'a'.repeat(64), randomUUID()]), role), /permission denied/)
  }
  await assert.rejects(transaction(c => c.query("update public.profiles set status='active'"), 'authenticated'), /permission denied/)
  const result = await transaction(async c => {
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [USER])
    return c.query("update public.profiles set display_name='Own name' where id=$1 returning id", [USER])
  }, 'authenticated')
  assert.equal(result.rowCount, 1)
})

test('usage insertion failure rolls back native PostgreSQL settlement atomically', async () => {
  const a = claimArgs('native-rollback')
  await begin(a)
  await pool.query("alter table public.translation_usage add constraint reject_test_usage check (request_id <> 'native-rollback')")
  try {
    await assert.rejects(complete(a), /reject_test_usage/)
    assert.deepEqual(await wallet(), { balance: 100, reserved_characters: 5, lifetime_debited: 0 })
    assert.deepEqual(await counts(), { debits: 0, usages: 0 })
  } finally { await pool.query('alter table public.translation_usage drop constraint reject_test_usage') }
  assert.equal((await complete(a)).state, 'completed')
})

test('twenty gateway calls backed by real PostgreSQL invoke the model once', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  const wait = new Promise<void>(r => { release = r })
  const env: Env = { SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public',
    SUPABASE_SECRET_KEY: 'test-service', OPENAI_API_KEY: 'test-provider', OPENAI_MODEL: 'test-model' }
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
      calls++; entered(); await wait
      return reply({ output_text: '译文', model: 'test-model' })
    }
    assert.equal(url.origin, env.SUPABASE_URL)
    if (url.pathname === '/auth/v1/user') return reply({ id: USER })
    assert.equal(new Headers(init?.headers).get('apikey'), 'test-service')
    if (url.pathname === '/rest/v1/profiles') return reply((await service('select * from public.profiles where id=$1', [USER])).rows)
    const a = JSON.parse(String(init?.body))
    const name = url.pathname.split('/').at(-1)
    try {
      if (name === 'begin_translation') return reply((await service('select public.begin_translation($1,$2,$3,$4,$5,$6) as result',
        [a.p_user_id, a.p_request_id, a.p_payload_hash, a.p_characters, a.p_claim_token, a.p_metadata])).rows[0].result)
      if (name === 'complete_translation') return reply((await service('select public.complete_translation($1,$2,$3,$4,$5,$6) as result',
        [a.p_user_id, a.p_request_id, a.p_claim_token, a.p_translation, a.p_model, a.p_latency_ms])).rows[0].result)
    } catch (error: any) { return reply({ message: error.message }, 400) }
    throw new Error('Unexpected mock endpoint')
  }
  const request = () => worker.fetch(new Request('https://worker.invalid/api/translate', {
    method: 'POST', headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'gateway-concurrent', text: 'hello', targetLanguage: 'zh-CN' })
  }), env)
  const first = request()
  try {
    await started
    const duplicates = await Promise.all(Array.from({ length: 19 }, request))
    assert.ok(duplicates.every(r => r.status === 202))
    assert.equal(calls, 1)
    release()
    const result = await first
    assert.equal(result.status, 200)
    assert.deepEqual(await (await request()).json(), await result.json())
    assert.equal(calls, 1)
    assert.deepEqual(await counts(), { debits: 1, usages: 1 })
  } finally { release(); await first; globalThis.fetch = originalFetch }
})
