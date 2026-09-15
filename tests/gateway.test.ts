import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, wallet, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
let providerCalls = 0
let providerBody: any
let provider: () => Promise<Response>
let loseCompletionResponse = false
let loseFailureResponse = false
const originalFetch = globalThis.fetch
const env: Env = { API_RATE_LIMITER: { limit: async () => ({ success: true }) }, SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public',
  SUPABASE_SECRET_KEY: 'test-service', OPENAI_API_KEY: 'test-provider', OPENAI_MODEL: 'test-model' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if ((url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') || (url.origin === 'https://api.deepseek.com' && url.pathname === '/responses')) {
      providerCalls += 1
      providerBody = JSON.parse(String(init?.body))
      if (env.TRANSLATION_PROVIDER === 'deepseek') {
        assert.equal(url.origin, 'https://api.deepseek.com')
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-deepseek')
        const body = JSON.parse(String(init?.body))
        assert.equal(body.model, env.DEEPSEEK_MODEL || 'deepseek-v4-pro')
        assert.equal(body.reasoning.effort, 'none')
        assert.equal(body.store, false)
      }
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
      if (name === 'complete_translation_metered' && loseCompletionResponse) {
        loseCompletionResponse = false
        throw new TypeError('Simulated lost response after successful commit')
      }
      if (name === 'fail_translation_metered' && loseFailureResponse) { loseFailureResponse=false; throw new TypeError('Lost failed-settlement response') }
      return reply(result)
    }
    throw new Error('Unexpected request '+url.pathname)
  }
})
beforeEach(async () => {
  await reset(db)
  await db.exec('delete from translator_private.provider_circuits')
  providerCalls = 0
  delete env.TRANSLATION_PROVIDER
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_MODEL
  loseCompletionResponse = false
  loseFailureResponse = false
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

test('claimed work is retained past a disconnected desktop and failure settlement survives a lost reply', async () => {
  let release!:()=>void,entered!:()=>void
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),background:Promise<unknown>[]=[]
  provider=async()=>{entered();await gate;return reply({error:{message:'unavailable'}},503)}
  loseFailureResponse=true
  const abort=new AbortController()
  const response=worker.fetch(new Request('https://worker.invalid/api/translate',{method:'POST',headers:{Authorization:'Bearer test-user','Content-Type':'application/json'},body:JSON.stringify({requestId:'retained-work',text:'hello',targetLanguage:'zh-CN'}),signal:abort.signal}),env,{waitUntil(work){background.push(work)}})
  await started;abort.abort();release()
  assert.equal((await response).status,502);await Promise.all(background);assert.ok(background.length>=1)
  assert.equal((await request('retained-work')).status,502);assert.equal(providerCalls,1)
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
  assert.equal((await rpc(db,'translation_status',{p_user_id:USER,p_request_id:'retained-work'})).state,'failed')
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

test('a specific provider failure is safely persisted and replayed without exposing raw errors or debiting characters', async () => {
  provider = async () => reply({ error: { code: 'insufficient_quota', message: 'secret fragment and private project detail' } }, 429)
  const first = await request('quota-diagnostic')
  const body = await first.json()
  assert.equal(first.status, 502)
  assert.equal(body.error, 'provider_quota')
  assert.ok(!JSON.stringify(body).includes('secret fragment'))
  assert.deepEqual(await (await request('quota-diagnostic')).json(), body)
  assert.equal(providerCalls, 1)
  assert.deepEqual(await wallet(db), { balance: 100, reserved_characters: 0, lifetime_debited: 0 })
})


test('DeepSeek translation uses isolated key, non-thinking Responses, and correct usage provider with one debit on replay', async () => {
  env.TRANSLATION_PROVIDER = 'deepseek'; env.DEEPSEEK_API_KEY = 'test-deepseek'; env.DEEPSEEK_MODEL = 'deepseek-flash'
  provider = async () => reply({ output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }], model: 'deepseek-flash' })
  const first = await request()
  assert.equal(first.status, 200)
  assert.equal((await first.json()).translation, '你好')
  assert.equal((await request()).status, 200)
  assert.equal(providerCalls, 1)
  assert.deepEqual(await counts(), { debits: 1, usages: 1 })
  const usage = await db.query('select provider, model from public.translation_usage')
  assert.deepEqual(usage.rows, [{ provider: 'deepseek', model: 'deepseek-flash' }])
})

test('DeepSeek insufficient balance is terminal and releases characters without repeated upstream calls', async () => {
  env.TRANSLATION_PROVIDER = 'deepseek'; env.DEEPSEEK_API_KEY = 'test-deepseek'
  provider = async () => reply({ error: { message: 'secret should never escape' } }, 402)
  const first = await request()
  assert.equal(first.status, 502)
  assert.equal((await first.json()).error, 'provider_quota')
  assert.equal((await request()).status, 502)
  assert.equal(providerCalls, 1)
  assert.deepEqual(await counts(), { debits: 0, usages: 0 })
  assert.deepEqual(await wallet(db), { balance: 100, reserved_characters: 0, lifetime_debited: 0 })
})

test('a model switch replays completed Flash receipts without another call or debit and still rejects changed content', async () => {
  env.TRANSLATION_PROVIDER='deepseek';env.DEEPSEEK_API_KEY='test-deepseek';env.DEEPSEEK_MODEL='deepseek-flash'
  provider=async()=>reply({output_text:'你好',model:'deepseek-flash'})
  const original=await (await request('switch-completed')).json()
  env.DEEPSEEK_MODEL='deepseek-v4-pro'
  const replay=await request('switch-completed')
  assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original)
  for(const patch of [{text:'other'},{targetLanguage:'en'},{accountId:'other-account'},{context:[{role:'incoming',text:'different context'}]}]) {
    assert.equal((await request('switch-completed',patch)).status,409)
  }
  assert.equal(providerCalls,1);assert.deepEqual(await counts(),{debits:1,usages:1})
})

test('failed Flash IDs remain terminal after a switch while a fresh retry uses Pro and charges once', async () => {
  env.TRANSLATION_PROVIDER='deepseek';env.DEEPSEEK_API_KEY='test-deepseek';env.DEEPSEEK_MODEL='deepseek-flash'
  provider=async()=>{throw new DOMException('simulated timeout','TimeoutError')}
  const original=await (await request('switch-failed')).json()
  env.DEEPSEEK_MODEL='deepseek-v4-pro'
  assert.deepEqual(await (await request('switch-failed')).json(),original)
  assert.equal(providerCalls,1);assert.equal((await wallet(db)).balance,100)
  provider=async()=>reply({output_text:'你好',model:'deepseek-v4-pro',usage:{input_tokens:100,input_tokens_details:{cached_tokens:40},output_tokens:50,total_tokens:150}})
  assert.equal((await request('switch-fresh-retry')).status,200)
  assert.equal((await request('switch-fresh-retry')).status,200)
  assert.equal(providerCalls,2);assert.deepEqual(await counts(),{debits:1,usages:1})
  const row=(await db.query<any>("select a.model,a.cost_status,a.input_rate,a.output_rate,a.cost_usd,p.cost_usd as total_cost_usd from translator_private.provider_attempt_usage a join translator_private.provider_usage p using(user_id,request_id) where a.request_id='switch-fresh-retry'")).rows[0]
  assert.equal(row.model,'deepseek-v4-pro');assert.equal(row.cost_status,'calculated')
  assert.ok([0.66,1.32].includes(Number(row.input_rate)));assert.ok([1.98,3.96].includes(Number(row.output_rate)))
  assert.ok([0.00013948,0.00027896].includes(Number(row.cost_usd)))
  assert.equal(row.total_cost_usd,row.cost_usd)
  assert.deepEqual(await wallet(db),{balance:95,reserved_characters:0,lifetime_debited:5})
})

test('pending Flash work stays pending across a model switch and settles its original result exactly once', async () => {
  env.TRANSLATION_PROVIDER='deepseek';env.DEEPSEEK_API_KEY='test-deepseek';env.DEEPSEEK_MODEL='deepseek-flash'
  let release!:()=>void,entered!:()=>void
  const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
  provider=async()=>{entered();await hold;return reply({output_text:'你好',model:'deepseek-flash'})}
  const first=request('switch-pending');await started
  try {env.DEEPSEEK_MODEL='deepseek-v4-pro';assert.equal((await request('switch-pending')).status,202);assert.equal(providerCalls,1)}
  finally {release()}
  assert.equal((await first).status,200);assert.equal((await request('switch-pending')).status,200)
  assert.equal(providerCalls,1);assert.deepEqual(await counts(),{debits:1,usages:1})
})

test('a response body timeout keeps its HTTP evidence and does not become an empty success or charge', async () => {
  provider=async()=>{const response=reply({});response.json=async()=>{throw new DOMException('body interrupted','TimeoutError')};return response}
  const result=await (await request('body-timeout')).json()
  assert.equal(result.error,'provider_timeout')
  const row=(await db.query<any>("select http_status from translator_private.provider_usage where request_id='body-timeout'")).rows[0]
  assert.equal(row.http_status,200);assert.equal(providerCalls,1)
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
})

test('quality terms and URL protection settle the original character count and replay without a second debit',async()=>{
 const text='Acme https://x.test/7'
 provider=async()=>reply({output_text:providerBody.input,model:'test-model'})
 const patch={text,quality:{tone:'business',glossary:[{source:'Acme',target:'艾克米'}]}}
 const first=await request('protected-quality',patch)
 assert.equal(first.status,200)
 const result:any=await first.json();assert.equal(result.translation,'艾克米 https://x.test/7');assert.equal(result.sourceCharacters,Array.from(text).length)
 assert.ok(providerBody.instructions.includes('business'));assert.ok(!providerBody.input.includes('https://'))
 assert.equal((await request('protected-quality',patch)).status,200);assert.equal(providerCalls,1)
 assert.deepEqual(await counts(),{debits:1,usages:1})
 const status=await worker.fetch(new Request('https://worker.invalid/api/translation-status?requestId=protected-quality',{headers:{Authorization:'Bearer test-user'}}),env)
 assert.equal((await status.json() as any).response.requestId,'protected-quality')
 const snapshot=await worker.fetch(new Request('https://worker.invalid/api/account-snapshot',{headers:{Authorization:'Bearer test-user'}}),env)
 const data:any=await snapshot.json();assert.equal(data.reconciliation.translationDebit,Array.from(text).length);assert.equal(data.reconciliation.duplicateDebits,0)
})

test('provider dropping a protected number fails the request without any debit',async()=>{
 const first=await request('dropped-number',{text:'Please call 5551234'})
 assert.equal(first.status,502);assert.deepEqual(await counts(),{debits:0,usages:0})
 assert.equal((await wallet(db)).balance,100);assert.equal((await wallet(db)).reserved_characters,0)
})

test('an untranslated English sentence is rejected before character settlement and replay cannot debit it',async()=>{
 provider=async()=>reply({output_text:"You're very direct, George!",model:'test-model',usage:{input_tokens:20,output_tokens:8,total_tokens:28}});
 const body={text:"You're very direct, George!",targetLanguage:'zh-CN'};
 assert.equal((await request('wrong-language',body)).status,502);
 assert.deepEqual(await counts(),{debits:0,usages:0});
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0});
 assert.equal((await request('wrong-language',body)).status,502);assert.equal(providerCalls,1);
 provider=async()=>reply({output_text:'你很直接，George！',model:'test-model'});
 assert.equal((await request('recovered-language',body)).status,200);
 assert.deepEqual(await counts(),{debits:1,usages:1});
})
