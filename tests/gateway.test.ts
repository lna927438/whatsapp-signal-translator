import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, wallet, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
let providerCalls = 0
let provider: () => Promise<Response>
let loseCompletionResponse = false
const originalFetch = globalThis.fetch
const env: Env = { SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public',
  SUPABASE_SECRET_KEY: 'test-service', OPENAI_API_KEY: 'test-provider', OPENAI_MODEL: 'test-model' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
      providerCalls += 1
      return provider()
    }
    // Deliberately prohibit all real network access in these tests.
    assert.equal(url.origin, env.SUPABASE_URL)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/auth/v1/user') {
      const token = headers.get('Authorization')
      if (!['Bearer test-user', 'Bearer test-other'].includes(token || '')) return reply({}, 401)
      return reply({ id: token === 'Bearer test-other' ? OTHER : USER })
    }
    assert.equal(headers.get('apikey'), 'test-service')
    if (url.pathname === '/rest/v1/profiles') {
      const id = url.searchParams.get('id')!.slice(3)
      return reply((await asRole(db, 'service_role', 'select * from public.profiles where id=$1', [id])).rows)
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!
      let result
      try { result = await rpc(db, name, JSON.parse(String(init?.body))) }
      catch (error: any) { return reply({ message: error.message }, 400) }
      if (name === 'complete_translation' && loseCompletionResponse) {
        loseCompletionResponse = false
        throw new TypeError('Simulated lost response after successful commit')
      }
      return reply(result)
    }
    throw new Error('Unexpected request '+url.pathname)
  }
})
beforeEach(async () => {
  await reset(db)
  providerCalls = 0
  loseCompletionResponse = false
  provider = async () => reply({ output_text: '译文', model: 'test-model' })
})
after(async () => { globalThis.fetch = originalFetch; await db?.close() })

function request(id = 'request-one', patch: Record<string, unknown> = {}, token = 'test-user', headerId = id) {
  return worker.fetch(new Request('https://worker.invalid/api/translate', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-request-id': headerId },
    body: JSON.stringify({ requestId: id, text: 'hello', targetLanguage: 'zh-CN', ...patch }) }), env)
}
async function counts() {
  const r = await db.query<{ debits: number; usages: number }>(`select
    (select count(*)::integer from public.character_ledger where type='translation') as debits,
    (select count(*)::integer from public.translation_usage) as usages`)
  return r.rows[0]
}

test('successful retry replays the original result without a second AI call or debit', async () => {
  const first = await request()
  assert.equal(first.status,200)
  const result = await first.json()
  const repeated = await request()
  assert.equal(repeated.status,200)
  assert.deepEqual(await repeated.json(),result)
  assert.equal(providerCalls,1)
  assert.deepEqual(await wallet(db),{ balance:95,reserved_characters:0,lifetime_debited:5 })
  assert.deepEqual(await counts(),{ debits:1,usages:1 })
})

test('simultaneous requests from separate gateway calls acquire only one provider claim', async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered=resolve })
  const wait = new Promise<void>(resolve => { release=resolve })
  provider = async () => { entered(); await wait; return reply({ output_text:'译文',model:'test-model' }) }
  const first = request()
  await started
  try {
    const duplicate = await request()
    assert.equal(duplicate.status,202)
    assert.equal(providerCalls,1)
    assert.deepEqual(await wallet(db),{ balance:100,reserved_characters:5,lifetime_debited:0 })
  } finally { release() }
  assert.equal((await first).status,200)
  assert.deepEqual(await counts(),{ debits:1,usages:1 })
})

test('a reused ID cannot change the text, language or context', async () => {
  assert.equal((await request()).status,200)
  for (const patch of [{ text:'different' },{ targetLanguage:'de' },{ context:[{ role:'incoming',text:'different context' }] }]) {
    assert.equal((await request('request-one',patch)).status,409)
  }
  assert.equal(providerCalls,1)
})

test('the same ID is isolated per authenticated user', async () => {
  assert.equal((await request()).status,200)
  assert.equal((await request('request-one',{},'test-other')).status,200)
  assert.equal(providerCalls,2)
  assert.equal((await wallet(db,OTHER)).balance,95)
})

test('disabled accounts are rejected before both new requests and completed replays', async () => {
  assert.equal((await request()).status,200)
  await db.query("update public.profiles set status='blocked' where id=$1",[USER])
  assert.equal((await request()).status,403)
  assert.equal((await request('another')).status,403)
  assert.equal(providerCalls,1)
  assert.equal((await wallet(db)).balance,95)
})

test('disabling an account during inference prevents completion and releases its reservation', async () => {
  provider = async () => {
    await db.query("update public.profiles set status='disabled' where id=$1",[USER])
    return reply({ output_text:'译文',model:'test-model' })
  }
  assert.equal((await request()).status,403)
  assert.deepEqual(await wallet(db),{ balance:100,reserved_characters:0,lifetime_debited:0 })
  assert.deepEqual(await counts(),{ debits:0,usages:0 })
})

test('provider failure releases reservations and repeated failures do not call the provider again', async () => {
  provider = async () => reply({ error:{ message:'simulated failure' } },503)
  assert.equal((await request()).status,502)
  assert.equal((await request()).status,502)
  assert.equal(providerCalls,1)
  assert.deepEqual(await wallet(db),{ balance:100,reserved_characters:0,lifetime_debited:0 })
})

test('a lost completion response retries settlement without double debit or another AI call', async () => {
  loseCompletionResponse=true
  assert.equal((await request()).status,200)
  assert.equal(providerCalls,1)
  assert.deepEqual(await counts(),{ debits:1,usages:1 })
  assert.equal((await wallet(db)).balance,95)
})

test('reservations prevent concurrent translations from overspending a wallet', async () => {
  await db.query('update public.wallets set balance=5 where user_id=$1',[USER])
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(r=>{ entered=r })
  const wait = new Promise<void>(r=>{ release=r })
  provider=async()=>{ entered(); await wait; return reply({ output_text:'译文',model:'test-model' }) }
  const first=request()
  await started
  try { assert.equal((await request('second')).status,402); assert.equal(providerCalls,1) }
  finally { release() }
  assert.equal((await first).status,200)
  assert.equal((await wallet(db)).balance,0)
})

test('abandoned claims expire without another provider call or character debit', async () => {
  provider=async()=>{
    await db.exec("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second'")
    return reply({ output_text:'late result',model:'test-model' })
  }
  assert.equal((await request()).status,409)
  assert.equal((await request()).status,409)
  assert.equal(providerCalls,1)
  assert.equal((await wallet(db)).reserved_characters,0)
})

test('legacy body/header ID mismatch remains compatible and invalid IDs cannot reach inference', async () => {
  assert.equal((await request('legacy',{},'test-user','different-header')).status,200)
  for (const id of ['', 'x'.repeat(161), 'contains space']) assert.equal((await request(id)).status,400)
  assert.equal(providerCalls,1)
})

test('invalid sessions and unknown profile states fail closed', async () => {
  assert.equal((await request('bad',{},'invalid')).status,401)
  await db.query("update public.profiles set status='unexpected' where id=$1",[USER])
  assert.equal((await request()).status,403)
  assert.equal(providerCalls,0)
})

test('characters count Unicode code points after trimming', async () => {
  const response=await request('unicode',{ text:'  你😀a  ' })
  assert.equal(response.status,200)
  assert.equal((await response.json()).sourceCharacters,3)
  assert.equal((await wallet(db)).balance,97)
})
