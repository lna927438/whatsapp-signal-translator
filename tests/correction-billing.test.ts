import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,rpc,asRole,USER,OTHER,wallet} from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const ds={provider:'deepseek',model:'deepseek-v4-pro'},oai={provider:'openai',model:'gpt-5.6-luna'}
const metadata={metering_version:'2',provider:'deepseek',requested_model:ds.model,provider_plan:[ds],
 source_language:'zh-CN',target_language:'en-US',
 provider_correction:{...ds,maxAttempts:1},security_input_token_bound:5000,security_output_token_bound:1024}
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await reset(db);await db.exec('update translator_private.security_policy set user_daily_usd=5,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60,enabled=true')})
async function start(meta:any=metadata,user=USER){
 const args={p_user_id:user,p_request_id:randomUUID(),p_claim_token:randomUUID()}
 await rpc(db,'begin_translation',{...args,p_payload_hash:'b'.repeat(64),p_characters:4,p_metadata:meta});return args
}
function attempt(errorCode:string|null=null,correction=false,provider='deepseek',patch:Record<string,unknown>={}){
 const model=provider==='deepseek'?ds.model:oai.model,at=new Date().toISOString()
 return {provider,model,startedAt:at,finishedAt:at,errorCode,...(correction?{correction:true}:{}),
 receipt:{model,httpStatus:200,inputTokens:100,cachedTokens:0,cacheWriteTokens:0,outputTokens:50,totalTokens:150,reasoningTokens:0,serviceTier:'default',createdAt:at,...patch}}
}
const envelope=(attempts:any[],selectedProvider:string|null)=>({version:2,selectedProvider,attempts})
const complete=(args:any,r:any)=>rpc(db,'complete_translation_metered',{...args,p_translation:'Test result',p_model:r.attempts.at(-1).receipt.model,p_latency_ms:100,p_receipt:r})
const fail=(args:any,r:any)=>rpc(db,'fail_translation_metered',{...args,p_error_code:'translation_failed',p_receipt:r})
const rows=async(id:string)=>(await db.query<any>('select * from translator_private.provider_attempt_usage where request_id=$1 order by attempt_index',[id])).rows
const parent=async(id:string)=>(await db.query<any>('select * from translator_private.provider_usage where request_id=$1',[id])).rows[0]
const unknown={httpStatus:null,inputTokens:null,cachedTokens:null,cacheWriteTokens:null,outputTokens:null,totalTokens:null,reasoningTokens:null,createdAt:null}

for (const rejected of ['provider_wrong_language','protected_literal_mismatch','provider_not_translation']) test(`DS-only ${rejected} correction records both costs and concurrent replay debits once`,async()=>{
 const args=await start(),r=envelope([attempt(rejected),attempt(null,true)],'deepseek')
 const [a,b]=await Promise.all([complete(args,r),complete(args,r)])
 assert.equal(a.state,'completed');assert.deepEqual(a.response,b.response)
 assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4})
 const attempts=await rows(args.p_request_id);assert.equal(attempts.length,2);assert.deepEqual(attempts.map(v=>v.correction),[false,true])
 const p=await parent(args.p_request_id);assert.equal(p.provider,'deepseek');assert.equal(p.model,ds.model);assert.equal(p.cost_status,'calculated')
 const match=(await db.query<any>('select p.cost_usd=sum(a.cost_usd) matched from translator_private.provider_usage p join translator_private.provider_attempt_usage a using(user_id,request_id) where p.request_id=$1 group by p.cost_usd',[args.p_request_id])).rows[0]
 assert.equal(match.matched,true)
 assert.equal((await db.query<any>('select provider,source_characters from public.translation_usage')).rows[0].provider,'deepseek')
 const snap=(await asRole<any>(db,'service_role','select public.account_snapshot($1) s',[USER])).rows[0].s
 assert.equal(snap.wallet.balance,96);assert.equal(snap.usage[0].source_language,'zh-CN');assert.equal(snap.usage[0].target_language,'en-US')
 assert.equal((await db.query<any>("select count(*)::int n from public.character_ledger where type='translation'")).rows[0].n,1)
 await assert.rejects(complete(args,envelope([attempt()], 'deepseek')),/operation_conflict/)
})

test('legacy dual provider request may use three retained attempts but one debit and actual DS attribution',async()=>{
 const args=await start({...metadata,provider:'openai',requested_model:oai.model,provider_plan:[oai,ds]})
 const r=envelope([attempt('provider_auth',false,'openai',{...unknown,httpStatus:401}),attempt('protected_literal_mismatch'),attempt(null,true)],'deepseek')
 await complete(args,r);await complete(args,r)
 const attempts=await rows(args.p_request_id);assert.equal(attempts.length,3);assert.deepEqual(attempts.map(v=>v.provider),['openai','deepseek','deepseek'])
 assert.equal(attempts[0].cost_usd,null);assert.ok(attempts[1].cost_usd);assert.ok(attempts[2].cost_usd)
 const p=await parent(args.p_request_id);assert.equal(p.cost_usd,null);assert.equal(p.provider,'mixed')
 const reserve=(await db.query<any>('select maximum_usd from translator_private.cost_reservations where request_id=$1',[args.p_request_id])).rows[0]
 assert.ok(Number(p.budget_cost_usd)>=Number(reserve.maximum_usd))
 assert.equal((await wallet(db)).lifetime_debited,4)
 assert.equal((await db.query<any>('select provider from public.translation_usage')).rows[0].provider,'deepseek')
})

test('a failed correction and a correction with an unknown response never charge characters',async()=>{
 for(const last of [attempt('provider_not_translation',true),attempt('provider_timeout',true,'deepseek',unknown)]){
  const args=await start(),r=envelope([attempt('provider_not_translation'),last],null)
  // Real attempts are ordered even when test fixtures were allocated earlier.
  last.startedAt=r.attempts[0].finishedAt;last.finishedAt=last.startedAt
  await fail(args,r);await fail(args,r)
  assert.equal((await rows(args.p_request_id)).length,2);assert.equal((await wallet(db)).lifetime_debited,0)
 }
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 assert.equal((await db.query<any>('select count(*)::int n from public.translation_usage')).rows[0].n,0)
})

test('only explicitly invalid complete DS responses authorize correction; no auth, timeout, empty, unknown or repeated correction',async()=>{
 for(const [error,status] of [['provider_timeout',null],['provider_auth',401],['provider_unavailable',503],['provider_empty',200],['provider_wrong_language',201],['provider_wrong_language',null],['provider_not_translation',201],['provider_not_translation',null],['translation_outcome_unknown',200]] as const){
  const args=await start(),r=envelope([attempt(error,false,'deepseek',{httpStatus:status}),attempt(null,true)],'deepseek')
  await assert.rejects(complete(args,r),/invalid_request/)
  assert.equal((await rows(args.p_request_id)).length,0);await fail(args,envelope([],null))
 }
 for(const attempts of [
  [attempt(null,true)],
  [attempt('provider_wrong_language'),attempt(null)],
  [attempt('provider_wrong_language'),{...attempt(null,true),correction:'true'}],
  [attempt('provider_wrong_language'),attempt('provider_wrong_language',true),attempt(null,true)],
  [attempt('provider_wrong_language'),attempt(null,true,'openai')],
  [attempt('provider_wrong_language'),attempt('provider_wrong_language',true),attempt(null,false,'openai')]
 ]){
  const args=await start();await assert.rejects(complete(args,envelope(attempts,'deepseek')),/invalid_request/)
  await fail(args,envelope([],null))
 }
 assert.equal((await wallet(db)).lifetime_debited,0)
})

test('old no-correction claims cannot acquire an unreserved extra attempt; malformed correction plan is rejected',async()=>{
 const {provider_correction,...legacy}=metadata
 const args=await start(legacy)
 await assert.rejects(complete(args,envelope([attempt('provider_wrong_language'),attempt(null,true)],'deepseek')),/invalid_request/)
 await fail(args,envelope([],null))
 for(const bad of [
  {...provider_correction,maxAttempts:2},{...provider_correction,maxAttempts:'1'},
  {...provider_correction,provider:'openai'},null,true
 ])await assert.rejects(start({...metadata,provider_correction:bad}),/invalid_request/)
 await assert.rejects(start({...metadata,provider_plan:[oai],provider:'openai',requested_model:oai.model}),/invalid_request/)
 const legacyArgs=await start(legacy);await complete(legacyArgs,envelope([attempt()],'deepseek'))
 assert.equal((await wallet(db)).lifetime_debited,4)
})

test('admission and finalized unknown-cost budgets include the full correction bound for all users',async()=>{
 const bound=async(meta:any)=>(await db.query<any>('select translator_private.translation_cost_bound($1,4,10,40,now())::text n',[meta])).rows[0].n
 const {provider_correction,...legacy}=metadata
 assert.equal(Number(await bound(metadata)),2*Number(await bound(legacy)))
 const dual={...metadata,provider:'openai',requested_model:oai.model,provider_plan:[oai,ds]}
 assert.equal(Number(await bound(dual)),Number(await bound({...dual,provider_correction:undefined}))+Number(await bound(legacy)))
 await db.exec('update translator_private.security_policy set user_daily_usd=0.015,global_daily_usd=0.015')
 await assert.rejects(start(),/cost_limit/)
 await db.exec('update translator_private.security_policy set user_daily_usd=0.03,global_daily_usd=0.03')
 const args=await start();await fail(args,envelope([attempt('provider_wrong_language'),attempt('provider_timeout',true,'deepseek',unknown)],null))
 const p=await parent(args.p_request_id);assert.equal(p.cost_usd,null);assert.ok(Number(p.budget_cost_usd)>=Number(await bound(metadata)))
 await assert.rejects(start(),/cost_limit/);await assert.rejects(start(metadata,OTHER),/cost_limit/)
 assert.equal((await wallet(db)).lifetime_debited,0)
})

test('no-provider skips release correction reserves; client roles cannot call billing helpers or insert attempts',async()=>{
 await db.exec('update translator_private.security_policy set user_daily_usd=0.022,global_daily_usd=0.022')
 for(let i=0;i<3;i++){
  const args=await start();await fail(args,envelope([],null));const p=await parent(args.p_request_id)
  assert.equal(Number(p.cost_usd),0);assert.equal(Number(p.budget_cost_usd),0)
 }
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select translator_private.has_provider_correction($1)',[metadata]),/permission denied/)
  await assert.rejects(asRole(db,role,'select translator_private.record_provider_usage($1,$2,$3,$4)',[USER,'forged',randomUUID(),envelope([],null)]),/permission denied/)
 }
 assert.equal((await wallet(db)).reserved_characters,0)
})
