import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { type Env } from '../server/worker/src/index.ts'
import { database, reset, asRole, rpc, wallet, USER, OTHER } from './fixture.ts'

type Provider = 'openai' | 'deepseek'
type ProviderCall = { provider: Provider; body: any; signal?: AbortSignal | null }
let db: Awaited<ReturnType<typeof database>>
let calls: ProviderCall[] = []
let settlements: { name: string; receipt: any }[] = []
let handler: (call: ProviderCall) => Promise<Response>
let beforeClaim: (() => void) | undefined
let loseCompletionResponse = false
let loseFailureResponse = false
const originalFetch = globalThis.fetch
const env: Env = {
  API_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_URL: 'https://database.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-service',
  TRANSLATION_PROVIDER: 'openai', TRANSLATION_FALLBACK_PROVIDER: 'deepseek',
  OPENAI_API_KEY: 'isolated-openai-secret', OPENAI_MODEL: 'gpt-5.6-luna',
  DEEPSEEK_API_KEY: 'isolated-deepseek-secret', DEEPSEEK_MODEL: 'deepseek-v4-pro'
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function success(call: ProviderCall, text = '你好') {
  return reply({ id: 'response-'+call.provider, model: call.body.model, status: 'completed', output_text: text,
    service_tier: 'default', usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 46 } })
}
const correctionInput={text:'早上好呀',sourceLanguage:'auto',targetLanguage:'en-US'}
const isCorrection=(call:ProviderCall)=>call.body.instructions.includes('A previous translation was rejected:')
const routeSignatures: Record<string, string[]> = {
  provider_route_acquire: ['p_user_id','p_request_id','p_claim_token','p_provider','p_model'],
  provider_route_outcome: ['p_user_id','p_request_id','p_claim_token','p_provider','p_model','p_generation','p_probe_token','p_success','p_error_code']
}

before(async () => {
  db = await database()
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    if (url.origin === 'https://api.openai.com' || url.origin === 'https://api.deepseek.com') {
      const provider: Provider = url.origin === 'https://api.openai.com' ? 'openai' : 'deepseek'
      assert.equal(url.pathname, provider === 'openai' ? '/v1/responses' : '/responses')
      assert.equal(headers.get('Authorization'), 'Bearer isolated-'+provider+'-secret')
      assert.equal(headers.get('apikey'), null)
      const body = JSON.parse(String(init?.body))
      assert.ok(!JSON.stringify(body).includes('-secret'), 'provider credentials must never enter message content')
      assert.equal(body.store, false)
      const call = { provider, body, signal: init?.signal }
      calls.push(call)
      return handler(call)
    }
    // Every network destination is checked. No provider key can leak through a
    // fallback URL, database RPC or an accidental real network request.
    assert.equal(url.origin, env.SUPABASE_URL)
    assert.ok(!String(headers.get('Authorization')).includes('isolated-'))
    if (url.pathname === '/auth/v1/user') {
      const token = headers.get('Authorization')
      if (!['Bearer test-user','Bearer test-other'].includes(token || '')) return reply({},401)
      return reply({ id: token === 'Bearer test-other' ? OTHER : USER })
    }
    assert.equal(headers.get('apikey'), 'test-service')
    if (url.pathname === '/rest/v1/profiles') {
      return reply((await asRole(db,'service_role','select * from public.profiles where id=$1',[url.searchParams.get('id')!.slice(3)])).rows)
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!
      const args = JSON.parse(String(init?.body))
      if (name === 'begin_translation') beforeClaim?.()
      if (name === 'complete_translation_metered' || name === 'fail_translation_metered') settlements.push({ name, receipt: args.p_receipt })
      let result: unknown
      try {
        const parameters = routeSignatures[name]
        if (parameters) {
          result = (await asRole<{ result: unknown }>(db,'service_role',
            `select public.${name}(${parameters.map((_,index) => '$'+(index+1)).join(',')}) as result`,parameters.map(key => args[key]))).rows[0].result
        } else result = await rpc(db,name,args)
      } catch (error: any) { return reply({ message: error.message },400) }
      if (name === 'complete_translation_metered' && loseCompletionResponse) {
        loseCompletionResponse = false
        throw new TypeError('Response lost after the transaction committed')
      }
      if (name === 'fail_translation_metered' && loseFailureResponse) {
        loseFailureResponse = false
        throw new TypeError('Response lost after failed settlement committed')
      }
      return reply(result)
    }
    throw new Error('Unexpected destination '+url.pathname)
  }
})
beforeEach(async () => {
  await reset(db)
  await db.exec('delete from translator_private.provider_circuits; update translator_private.security_policy set enabled=true,user_daily_usd=100000,global_daily_usd=1000000,user_requests_per_minute=600,user_concurrency=32')
  calls = []; settlements = []; loseCompletionResponse = false; loseFailureResponse = false; beforeClaim = undefined
  env.TRANSLATION_PROVIDER = 'openai'; env.TRANSLATION_FALLBACK_PROVIDER = 'deepseek'
  env.OPENAI_MODEL = 'gpt-5.6-luna'; env.DEEPSEEK_MODEL = 'deepseek-v4-pro'
  env.OPENAI_API_KEY = 'isolated-openai-secret'; env.DEEPSEEK_API_KEY = 'isolated-deepseek-secret'
  handler = async call => success(call)
})
after(async () => { globalThis.fetch = originalFetch; await db?.close() })

function request(id = 'dual-one', patch: Record<string, unknown> = {}, token = 'test-user') {
  return worker.fetch(new Request('https://worker.invalid/api/translate',{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-request-id':id},
    body:JSON.stringify({requestId:id,text:'hello',targetLanguage:'zh-CN',...patch})}),env)
}
async function ledger() {
  return (await db.query<{ debits: number; usage: number }>(`select
    (select count(*)::integer from public.character_ledger where type='translation') debits,
    (select count(*)::integer from public.translation_usage) usage`)).rows[0]
}
async function attempts(id = 'dual-one') {
  return (await db.query<{ provider: Provider; error_code: string | null; http_status: number | null }>(
    'select provider,error_code,http_status from translator_private.provider_attempt_usage where request_id=$1 order by attempt_index',[id])).rows
}

test('OpenAI is primary: one call, one character debit and the winning provider is recorded', async () => {
  const response = await request()
  assert.equal(response.status,200)
  const body = await response.json()
  assert.equal(body.translation,'你好')
  assert.deepEqual(calls.map(call => [call.provider,call.body.model]),[['openai','gpt-5.6-luna']])
  assert.deepEqual(await wallet(db),{balance:95,reserved_characters:0,lifetime_debited:5})
  assert.deepEqual(await ledger(),{debits:1,usage:1})
  assert.deepEqual(await attempts(),[{provider:'openai',error_code:null,http_status:200}])
  assert.deepEqual((await db.query('select provider,model from public.translation_usage')).rows,[{provider:'openai',model:'gpt-5.6-luna'}])
  const metadata = (await db.query<{metadata:any}>('select metadata from translator_private.translation_requests')).rows[0].metadata
  assert.equal(metadata.metering_version,'2')
  assert.deepEqual(metadata.provider_plan,[{provider:'openai',model:'gpt-5.6-luna'},{provider:'deepseek',model:'deepseek-v4-pro'}])
  assert.equal(settlements[0].receipt.version,2)
  assert.equal(settlements[0].receipt.selectedProvider,'openai')
  assert.equal(settlements[0].receipt.attempts.length,1)
  assert.deepEqual(await (await request()).json(),body)
  assert.equal(calls.length,1)
})

for (const [status,errorCode] of [[401,'provider_auth'],[402,'provider_quota'],[403,'provider_permission'],[404,'provider_model'],[429,'provider_rate_limit'],[503,'provider_unavailable']] as const) {
  test(`OpenAI HTTP ${status} uses DeepSeek once, preserving both attempts but charging the customer once`,async () => {
    handler = async call => call.provider === 'openai' ? reply({error:{message:'private upstream detail must not escape'}},status) : success(call)
    const response = await request()
    assert.equal(response.status,200)
    assert.ok(!JSON.stringify(await response.json()).includes('private upstream detail'))
    assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
    assert.deepEqual(await wallet(db),{balance:95,reserved_characters:0,lifetime_debited:5})
    assert.deepEqual(await ledger(),{debits:1,usage:1})
    assert.deepEqual(await attempts(),[{provider:'openai',error_code:errorCode,http_status:status},{provider:'deepseek',error_code:null,http_status:200}])
    assert.equal(settlements[0].receipt.selectedProvider,'deepseek')
    assert.equal((await db.query<{provider:string}>('select provider from public.translation_usage')).rows[0].provider,'deepseek')
    assert.equal((await request()).status,200)
    assert.equal(calls.length,2)
  })
}

test('a primary timeout switches providers without repeating an ambiguous OpenAI request',async () => {
  handler = async call => {
    if (call.provider === 'openai') throw new DOMException('simulated upstream timeout','TimeoutError')
    return success(call)
  }
  assert.equal((await request()).status,200)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await attempts(),[{provider:'openai',error_code:'provider_timeout',http_status:null},{provider:'deepseek',error_code:null,http_status:200}])
  assert.equal((await request()).status,200)
  assert.equal(calls.length,2)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('a primary body-read timeout retains HTTP 200 evidence and switches to a usable backup',async () => {
  handler = async call => {
    if (call.provider !== 'openai') return success(call)
    const response = success(call)
    response.json = async () => { throw new DOMException('body timed out','TimeoutError') }
    return response
  }
  assert.equal((await request()).status,200)
  assert.deepEqual(await attempts(),[{provider:'openai',error_code:'provider_timeout',http_status:200},{provider:'deepseek',error_code:null,http_status:200}])
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('the primary deadline aborts the attempt and leaves a bounded budget for the backup',async () => {
  const originalTimeout = AbortSignal.timeout
  const durations = new WeakMap<AbortSignal,number>()
  const seen: number[] = []
  AbortSignal.timeout = (milliseconds: number) => {
    const signal = originalTimeout(Math.min(milliseconds,15))
    durations.set(signal,milliseconds)
    return signal
  }
  // AbortSignal timers are unref'ed. Keep this one bounded test alive until its
  // accelerated primary deadline fires; no live endpoint or multi-second wait.
  const keepAlive = setTimeout(() => undefined,1000)
  try {
    handler = async call => {
      assert.ok(call.signal)
      const duration = durations.get(call.signal)
      assert.ok(duration && duration > 0)
      seen.push(duration)
      if (call.provider === 'deepseek') return success(call)
      await new Promise<never>((_,reject) => {
        if (call.signal!.aborted) reject(call.signal!.reason)
        else call.signal!.addEventListener('abort',() => reject(call.signal!.reason),{once:true})
      })
      throw new Error('Primary must be aborted')
    }
    assert.equal((await request('bounded-deadlines')).status,200)
    assert.equal(seen.length,2)
    assert.ok(seen[0] <= 8000)
    assert.ok(seen[1] <= 12000)
    assert.ok(seen[0]+seen[1] <= 20000)
    assert.equal((await attempts('bounded-deadlines'))[0].error_code,'provider_timeout')
    assert.deepEqual(await ledger(),{debits:1,usage:1})
  } finally { AbortSignal.timeout = originalTimeout; clearTimeout(keepAlive) }
})

test('time spent before a claim reduces both provider deadlines while fallback still settles once',async () => {
  const originalNow = Date.now, originalTimeout = AbortSignal.timeout
  const durations = new WeakMap<AbortSignal,number>()
  let elapsed = 0
  const seen: number[] = []
  Date.now = () => originalNow()+elapsed
  AbortSignal.timeout = (milliseconds: number) => {
    const signal = originalTimeout(milliseconds)
    durations.set(signal,milliseconds)
    return signal
  }
  beforeClaim = () => { elapsed=15_000 }
  try {
    handler = async call => {
      seen.push(call.signal ? durations.get(call.signal) || 0 : 0)
      return call.provider === 'openai' ? reply({error:{}},503) : success(call)
    }
    const response = await request('slow-preclaim')
    assert.equal(response.status,200)
    const result = await response.json()
    assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
    assert.equal(seen.length,2)
    assert.ok(seen[0] > 0 && seen[0] <= 5000,'the primary must receive only the remaining request budget')
    assert.ok(seen[1] > 0 && seen[1] <= seen[0],'fallback cannot restart or extend the request deadline')
    assert.deepEqual(await (await request('slow-preclaim')).json(),result)
    assert.equal(calls.length,2)
    assert.equal((await attempts('slow-preclaim')).length,2)
    assert.deepEqual(await wallet(db),{balance:95,reserved_characters:0,lifetime_debited:5})
    assert.deepEqual(await ledger(),{debits:1,usage:1})
  } finally { Date.now=originalNow; AbortSignal.timeout=originalTimeout; beforeClaim=undefined }
})

test('an exhausted request deadline before inference releases the claim without calling either provider',async () => {
  const originalNow = Date.now
  let elapsed = 0
  Date.now = () => originalNow()+elapsed
  beforeClaim = () => { elapsed=21_000 }
  try {
    const response = await request('expired-preclaim')
    assert.equal(response.status,502)
    const result = await response.json()
    assert.deepEqual(await (await request('expired-preclaim')).json(),result)
    assert.equal(calls.length,0)
    assert.deepEqual(await attempts('expired-preclaim'),[])
    assert.equal(settlements.at(-1)!.receipt.selectedProvider,null)
    assert.deepEqual(settlements.at(-1)!.receipt.attempts,[])
    assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
    assert.deepEqual(await ledger(),{debits:0,usage:0})
  } finally { Date.now=originalNow; beforeClaim=undefined }
})

test('untranslated output from the primary cannot become a successful charged result',async () => {
  const source = "You're very direct, George!"
  handler = async call => success(call,call.provider === 'openai' ? source : '你很直接，George！')
  const response = await request('wrong-language',{text:source})
  assert.equal(response.status,200)
  assert.equal((await response.json()).translation,'你很直接，George！')
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.equal((await attempts('wrong-language'))[0].error_code,'provider_wrong_language')
  assert.equal((await wallet(db)).lifetime_debited,Array.from(source).length)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('missing protected numbers are repaired through the backup without exposing tokens or charging twice',async () => {
  handler = async call => success(call,call.provider === 'openai' ? '请拨打电话' : '请拨打 '+call.body.input)
  const response = await request('protected-number',{text:'Call 5551234'})
  assert.equal(response.status,200)
  const body = await response.json()
  assert.ok(body.translation.includes('5551234'))
  assert.ok(!body.translation.includes('HDPROTECT'))
  assert.equal((await attempts('protected-number'))[0].error_code,'protected_literal_mismatch')
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('both providers failing releases all characters, preserves both receipts, and replays a terminal result',async () => {
  handler = async call => {
    if (call.provider === 'openai') return reply({error:{}},503)
    throw new DOMException('backup timed out','TimeoutError')
  }
  const response = await request()
  assert.equal(response.status,502)
  const body = await response.json()
  assert.deepEqual(await (await request()).json(),body)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
  assert.deepEqual(await ledger(),{debits:0,usage:0})
  assert.equal((await attempts()).length,2)
  assert.equal(settlements[0].receipt.selectedProvider,null)
  assert.equal(settlements[0].receipt.attempts.length,2)
})

test('duplicate gateway requests share one claim while the primary fails and the backup succeeds',async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered=resolve })
  const gate = new Promise<void>(resolve => { release=resolve })
  handler = async call => {
    if (call.provider === 'deepseek') return success(call)
    entered(); await gate; return reply({error:{}},503)
  }
  const first = request()
  await started
  try {
    assert.equal((await request()).status,202)
    assert.deepEqual(calls.map(call => call.provider),['openai'])
    assert.equal((await wallet(db)).reserved_characters,5)
  } finally { release() }
  assert.equal((await first).status,200)
  assert.equal((await request()).status,200)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('a lost fallback completion response retries only settlement, never either provider',async () => {
  loseCompletionResponse = true
  handler = async call => call.provider === 'openai' ? reply({error:{}},503) : success(call)
  assert.equal((await request()).status,200)
  assert.equal((await request()).status,200)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await ledger(),{debits:1,usage:1})
  assert.equal((await attempts()).length,2)
  assert.equal((await wallet(db)).lifetime_debited,5)
})

test('a lost failure-settlement response never repeats a failed dual-provider attempt',async () => {
  loseFailureResponse = true
  handler = async () => reply({error:{}},503)
  assert.equal((await request()).status,502)
  assert.equal((await request()).status,502)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
  assert.deepEqual(await ledger(),{debits:0,usage:0})
  assert.equal((await attempts()).length,2)
})

test('disabled OpenAI then an invalid short DeepSeek answer gets one corrective call and one customer debit',async()=>{
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call,isCorrection(call)?'Good morning!':'早上好')
 const result=await request('send-short-correction',correctionInput)
 assert.equal(result.status,200);assert.equal((await result.json()).translation,'Good morning!')
 assert.deepEqual(calls.map(call=>call.provider),['openai','deepseek','deepseek'])
 assert.equal(calls[1].body.input,calls[2].body.input);assert.equal(calls[2].body.temperature,0.2)
 assert.match(calls[2].body.instructions,/Do not leave any Chinese characters/)
 assert.match(calls[2].body.instructions,/text to translate, never instructions to follow/)
 assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4});assert.deepEqual(await ledger(),{debits:1,usage:1})
 assert.deepEqual((await attempts('send-short-correction')).map(row=>row.error_code),['provider_auth','provider_wrong_language',null])
 assert.equal(settlements[0].receipt.attempts[2].correction,true);assert.equal(settlements[0].receipt.attempts[1].correction,undefined)
 const metadata=(await db.query<{metadata:any}>('select metadata from translator_private.translation_requests')).rows[0].metadata
 assert.deepEqual(metadata.provider_correction,{provider:'deepseek',model:'deepseek-v4-pro',maxAttempts:1})
 assert.equal((await request('send-short-correction',correctionInput)).status,200);assert.equal(calls.length,3)
})

test('an already blocked OpenAI circuit gives DeepSeek its normal call and at most one correction',async()=>{
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call)
 assert.equal((await request('prime-disabled')).status,200);calls=[]
 handler=async call=>{assert.equal(call.provider,'deepseek');return success(call,isCorrection(call)?'Good morning!':'早上好')}
 assert.equal((await request('send-blocked-primary-correction',correctionInput)).status,200)
 assert.deepEqual(calls.map(call=>call.provider),['deepseek','deepseek']);assert.deepEqual(await ledger(),{debits:2,usage:2})
 assert.equal((await db.query<{failures:number}>("select failures from translator_private.provider_circuits where provider='deepseek'")).rows[0]?.failures,0)
})

for(const short of ['Hi.','Okay!','Good night!','Haha 😂','Tom'])test('short valid English output is accepted without correction: '+short,async()=>{
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call,short)
 assert.equal((await request('send-valid-short',correctionInput)).status,200)
 assert.equal(calls.length,2);assert.equal(calls.some(isCorrection),false);assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('an invalid corrective answer stops after three attempts, releases the wallet and never loops on replay',async()=>{
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call,'早上好')
 assert.equal((await request('send-invalid-correction',correctionInput)).status,502)
 assert.equal(calls.length,3);assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 assert.deepEqual(await ledger(),{debits:0,usage:0});assert.equal((await attempts('send-invalid-correction')).length,3)
 assert.equal((await request('send-invalid-correction',correctionInput)).status,502);assert.equal(calls.length,3)
})

test('a completed answer missing a protected literal can be corrected without losing its original receipt',async()=>{
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call,isCorrection(call)?'Please call '+call.body.input.match(/__HDPROTECTED_\d+__/g).join(' '):'Please call me.')
 const result=await request('send-corrected-literal',{text:'请拨打5551234',targetLanguage:'en-US'})
 assert.equal(result.status,200);assert.equal((await result.json()).translation,'Please call 5551234')
 assert.deepEqual((await attempts('send-corrected-literal')).map(row=>row.error_code),['provider_auth','protected_literal_mismatch',null])
 assert.deepEqual(await ledger(),{debits:1,usage:1})
})

for(const kind of ['timeout','body-timeout','empty','incomplete','missing-status','http503'])test('a DeepSeek '+kind+' does not authorize a second ambiguous call',async()=>{
 handler=async call=>{
  if(call.provider==='openai')return reply({error:{}},401)
  if(kind==='timeout')throw new DOMException('synthetic timeout','TimeoutError')
  if(kind==='body-timeout'){const result=success(call);result.json=async()=>{throw new DOMException('synthetic body timeout','TimeoutError')};return result}
  if(kind==='incomplete')return reply({status:'incomplete',output_text:'早上好'})
  if(kind==='missing-status')return reply({output_text:'早上好'})
  return kind==='http503'?reply({error:{}},503):success(call,'')
 }
 assert.equal((await request('send-no-blind-correction',correctionInput)).status,502);assert.equal(calls.length,2)
 assert.deepEqual(await ledger(),{debits:0,usage:0});assert.equal((await wallet(db)).reserved_characters,0)
})

test('correction cannot extend the original request deadline or run after it is exhausted',async()=>{
 const originalNow=Date.now;let elapsed=0
 Date.now=()=>originalNow()+elapsed
 try{
  handler=async call=>{if(call.provider==='openai')return reply({error:{}},401);elapsed=21_000;return success(call,'早上好')}
  assert.equal((await request('send-expired-correction',correctionInput)).status,502);assert.equal(calls.length,2)
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 }finally{Date.now=originalNow}
})

test('a lost correction settlement response repeats only the transaction and keeps one customer debit',async()=>{
 loseCompletionResponse=true
 handler=async call=>call.provider==='openai'?reply({error:{}},401):success(call,isCorrection(call)?'Good morning!':'早上好')
 assert.equal((await request('send-correction-commit-loss',correctionInput)).status,200)
 assert.equal(calls.length,3);assert.equal((await attempts('send-correction-commit-loss')).length,3)
 assert.deepEqual(await ledger(),{debits:1,usage:1});assert.equal((await wallet(db)).lifetime_debited,4)
})

test('concurrent retries during the corrective call share one claim and never duplicate inference',async()=>{
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 handler=async call=>{if(call.provider==='openai')return reply({error:{}},401);if(!isCorrection(call))return success(call,'早上好');entered();await gate;return success(call,'Good morning!')}
 const first=request('send-correction-concurrent',correctionInput);await started
 try{assert.equal((await request('send-correction-concurrent',correctionInput)).status,202);assert.equal(calls.length,3)}finally{release()}
 assert.equal((await first).status,200);assert.equal(calls.length,3);assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('DeepSeek-only configuration works with all OpenAI credentials and model absent, including one correction',async()=>{
 env.TRANSLATION_PROVIDER='deepseek';delete env.TRANSLATION_FALLBACK_PROVIDER;delete env.OPENAI_API_KEY;delete env.OPENAI_MODEL
 handler=async call=>{assert.equal(call.provider,'deepseek');return success(call,isCorrection(call)?'Good morning!':'早上好')}
 const response=await request('send-deepseek-only-correction',correctionInput)
 assert.equal(response.status,200);assert.equal((await response.json()).translation,'Good morning!')
 assert.deepEqual(calls.map(call=>call.provider),['deepseek','deepseek'])
 const metadata=(await db.query<{metadata:any}>('select metadata from translator_private.translation_requests')).rows[0].metadata
 assert.deepEqual(metadata.provider_plan,[{provider:'deepseek',model:'deepseek-v4-pro'}])
 assert.deepEqual(metadata.provider_correction,{provider:'deepseek',model:'deepseek-v4-pro',maxAttempts:1})
 assert.equal(settlements[0].receipt.attempts.length,2);assert.equal(settlements[0].receipt.attempts[1].correction,true)
 assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4});assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('DeepSeek-only invalid correction settles zero and does not prevent the next independent message',async()=>{
 env.TRANSLATION_PROVIDER='deepseek';delete env.TRANSLATION_FALLBACK_PROVIDER;delete env.OPENAI_API_KEY;delete env.OPENAI_MODEL
 handler=async call=>success(call,'早上好')
 assert.equal((await request('send-deepseek-bad',correctionInput)).status,502);assert.equal(calls.length,2)
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 handler=async call=>success(call,'Good morning!')
 assert.equal((await request('send-deepseek-next',correctionInput)).status,200);assert.equal(calls.length,3)
 assert.equal((await request('send-deepseek-bad',correctionInput)).status,502);assert.equal(calls.length,3)
 assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('DeepSeek-only zero balance rejects before any normal or corrective provider call',async()=>{
 env.TRANSLATION_PROVIDER='deepseek';delete env.TRANSLATION_FALLBACK_PROVIDER;delete env.OPENAI_API_KEY;delete env.OPENAI_MODEL
 await db.query('update public.wallets set balance=0 where user_id=$1',[USER])
 assert.equal((await request('send-deepseek-no-credit',correctionInput)).status,402)
 assert.equal(calls.length,0);assert.equal(settlements.length,0);assert.deepEqual(await ledger(),{debits:0,usage:0})
})

for (const rejection of ['session','account','characters','cost','paused'] as const) {
  test(`${rejection} rejection never reaches either provider or opens a failover attempt`,async () => {
    if (rejection === 'account') await db.query("update public.profiles set status='disabled' where id=$1",[USER])
    if (rejection === 'characters') await db.query('update public.wallets set balance=0 where user_id=$1',[USER])
    if (rejection === 'cost') await db.exec('update translator_private.security_policy set user_daily_usd=0.0001')
    if (rejection === 'paused') await db.exec('update translator_private.security_policy set enabled=false')
    const response = await request('rejected',{},rejection === 'session' ? 'invalid-session' : 'test-user')
    assert.equal(response.status,{session:401,account:403,characters:402,cost:429,paused:503}[rejection])
    assert.equal(calls.length,0)
    assert.equal(settlements.length,0)
    assert.deepEqual(await ledger(),{debits:0,usage:0})
    assert.equal((await wallet(db)).reserved_characters,0)
  })
}

test('an open primary circuit skips OpenAI for another user while DeepSeek keeps translating',async () => {
  handler = async call => call.provider === 'openai' ? reply({error:{}},401) : success(call)
  assert.equal((await request('first-user')).status,200)
  assert.equal((await request('next-user',{},'test-other')).status,200)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek','deepseek'])
  assert.deepEqual(await attempts('next-user'),[{provider:'deepseek',error_code:null,http_status:200}])
  assert.equal((await wallet(db)).balance,95)
  assert.equal((await wallet(db,OTHER)).balance,95)
  assert.deepEqual(await ledger(),{debits:2,usage:2})
})

test('when both circuits are open, a new request fails without upstream calls or a character debit',async () => {
  handler = async () => reply({error:{}},401)
  assert.equal((await request('open-both')).status,502)
  assert.deepEqual(calls.map(call => call.provider),['openai','deepseek'])
  const firstCalls = calls.length
  assert.equal((await request('both-open')).status,502)
  assert.equal(calls.length,firstCalls)
  assert.deepEqual(await attempts('both-open'),[])
  assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
  assert.deepEqual(await ledger(),{debits:0,usage:0})
  assert.equal(settlements.at(-1)!.receipt.selectedProvider,null)
  assert.deepEqual(settlements.at(-1)!.receipt.attempts,[])
})

test('a failed request does not lock later messages when a provider becomes usable',async () => {
  handler = async () => reply({error:{}},503)
  assert.equal((await request('failed-before')).status,502)
  handler = async call => success(call)
  assert.equal((await request('fresh-after')).status,200)
  assert.equal((await request('failed-before')).status,502)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
  assert.equal((await wallet(db)).reserved_characters,0)
})

test('routing changes replay the original request but cannot change its text, language or conversation',async () => {
  const original = await (await request('stable-route')).json()
  env.TRANSLATION_PROVIDER = 'deepseek'; env.TRANSLATION_FALLBACK_PROVIDER = 'openai'
  assert.deepEqual(await (await request('stable-route')).json(),original)
  for (const patch of [{text:'changed'},{targetLanguage:'de'},{accountId:'another-account'},
    {conversationId:'another-contact'},{context:[{role:'incoming',text:'changed context'}]}]) {
    assert.equal((await request('stable-route',patch)).status,409)
  }
  assert.equal(calls.length,1)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('enabling failover replays an old DeepSeek completion without inference or another debit',async () => {
  env.TRANSLATION_PROVIDER = 'deepseek'; delete env.TRANSLATION_FALLBACK_PROVIDER
  const original = await (await request('legacy-complete')).json()
  env.TRANSLATION_PROVIDER = 'openai'; env.TRANSLATION_FALLBACK_PROVIDER = 'deepseek'
  const replay = await request('legacy-complete')
  assert.equal(replay.status,200)
  assert.deepEqual(await replay.json(),original)
  assert.equal(calls.length,1)
  assert.equal((await request('legacy-complete',{text:'changed'})).status,409)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('enabling failover preserves an old terminal failure while a fresh request uses the primary',async () => {
  env.TRANSLATION_PROVIDER = 'deepseek'; delete env.TRANSLATION_FALLBACK_PROVIDER
  handler = async () => reply({error:{}},503)
  const failed = await request('legacy-failed')
  assert.equal(failed.status,502)
  const original = await failed.json()
  env.TRANSLATION_PROVIDER = 'openai'; env.TRANSLATION_FALLBACK_PROVIDER = 'deepseek'
  handler = async call => success(call)
  assert.deepEqual(await (await request('legacy-failed')).json(),original)
  assert.equal(calls.length,1)
  assert.equal((await wallet(db)).balance,100)
  assert.equal((await request('fresh-route')).status,200)
  assert.deepEqual(calls.map(call => call.provider),['deepseek','openai'])
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})

test('enabling failover during an old pending request cannot start a second inference',async () => {
  env.TRANSLATION_PROVIDER = 'deepseek'; delete env.TRANSLATION_FALLBACK_PROVIDER
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered=resolve })
  const gate = new Promise<void>(resolve => { release=resolve })
  handler = async call => { entered(); await gate; return success(call) }
  const first = request('legacy-pending')
  await started
  try {
    env.TRANSLATION_PROVIDER = 'openai'; env.TRANSLATION_FALLBACK_PROVIDER = 'deepseek'
    assert.equal((await request('legacy-pending')).status,202)
    assert.deepEqual(calls.map(call => call.provider),['deepseek'])
    assert.equal((await wallet(db)).reserved_characters,5)
  } finally { release() }
  assert.equal((await first).status,200)
  assert.equal((await request('legacy-pending')).status,200)
  assert.equal(calls.length,1)
  assert.deepEqual(await ledger(),{debits:1,usage:1})
})
