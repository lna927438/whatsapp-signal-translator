import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,rpc,asRole,USER,OTHER,wallet} from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const plan=[{provider:'openai',model:'gpt-5.6-luna'},{provider:'deepseek',model:'deepseek-v4-pro'}]
const metadata={metering_version:'2',provider:'openai',requested_model:'gpt-5.6-luna',provider_plan:plan,security_input_token_bound:5000,security_output_token_bound:1024}
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await reset(db);await db.exec('update translator_private.security_policy set user_daily_usd=5,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60,enabled=true')})
async function start(id=randomUUID(),user=USER,meta=metadata){
 const args={p_user_id:user,p_request_id:id,p_claim_token:randomUUID()}
 await rpc(db,'begin_translation',{...args,p_payload_hash:'a'.repeat(64),p_characters:7,p_metadata:meta});return args
}
const epoch=()=>new Date().toISOString()
function attempt(provider='openai',errorCode:string|null=null,patch:Record<string,unknown>={}){
 const model=plan.find(p=>p.provider===provider)!.model,now=epoch()
 return {provider,model,startedAt:now,finishedAt:now,errorCode,receipt:{model,httpStatus:200,inputTokens:100,cachedTokens:40,cacheWriteTokens:20,outputTokens:50,totalTokens:150,reasoningTokens:10,serviceTier:'default',createdAt:now,responseId:'synthetic',requestId:'synthetic',...patch}}
}
const unknown=(provider='openai')=>attempt(provider,'provider_timeout',{httpStatus:null,inputTokens:null,cachedTokens:null,cacheWriteTokens:null,outputTokens:null,totalTokens:null,reasoningTokens:null,createdAt:null})
const envelope=(attempts:any[],selectedProvider:string|null)=>({version:2,attempts,selectedProvider})
const complete=(args:any,r:any)=>rpc(db,'complete_translation_metered',{...args,p_translation:'测试译文',p_model:r.attempts.at(-1).receipt.model,p_latency_ms:50,p_receipt:r})
const fail=(args:any,r:any)=>rpc(db,'fail_translation_metered',{...args,p_error_code:'provider_timeout',p_receipt:r})
const parent=async(id:string)=>(await db.query<any>('select * from translator_private.provider_usage where request_id=$1',[id])).rows[0]
const attempts=async(id:string)=>(await db.query<any>('select * from translator_private.provider_attempt_usage where request_id=$1 order by attempt_index',[id])).rows

test('primary success prices explicit cache-write input and debits characters exactly once',async()=>{
 const args=await start(),r=envelope([attempt()], 'openai')
 const first=await complete(args,r),second=await complete(args,r)
 assert.equal(first.state,'completed');assert.deepEqual(second.response,first.response)
 assert.deepEqual(await wallet(db),{balance:93,reserved_characters:0,lifetime_debited:7})
 const rows=await attempts(args.p_request_id);assert.equal(rows.length,1)
 assert.equal(rows[0].cache_write_tokens,20);assert.equal(Number(rows[0].cost_usd),0.0000738)
 assert.equal(Number((await parent(args.p_request_id)).cost_usd),0.0000738)
 assert.equal((await db.query<any>('select provider from public.translation_usage')).rows[0].provider,'openai')
})

test('primary timeout then backup success preserves unknown primary cost and one customer debit',async()=>{
 const args=await start(),r=envelope([unknown(),attempt('deepseek',null,{cacheWriteTokens:null})],'deepseek')
 assert.equal((await complete(args,r)).state,'completed');await complete(args,r)
 assert.deepEqual(await wallet(db),{balance:93,reserved_characters:0,lifetime_debited:7})
 const rows=await attempts(args.p_request_id),sum=await parent(args.p_request_id)
 assert.equal(rows.length,2);assert.equal(rows[0].cost_usd,null);assert.ok(Number(rows[0].maximum_usd)>0)
 assert.ok(Number(rows[1].cost_usd)>0);assert.equal(sum.provider,'mixed');assert.equal(sum.cost_usd,null)
 assert.equal(sum.cost_status,'unknown_attempt_cost');assert.ok(Number(sum.budget_cost_usd)>=0.01313384)
 const request=(await db.query<any>('select metadata from translator_private.translation_requests')).rows[0].metadata
 assert.equal(request.provider,'openai');assert.deepEqual(request.provider_plan,plan);assert.equal(request.selected_provider,'deepseek')
 assert.equal((await db.query<any>('select provider from public.translation_usage')).rows[0].provider,'deepseek')
 assert.equal((await db.query<any>("select count(*)::int n from public.character_ledger where type='translation'")).rows[0].n,1)
})

test('both providers fail without charging characters, and replay cannot rewrite receipts',async()=>{
 const args=await start(),r=envelope([unknown(),unknown('deepseek')],null)
 assert.equal((await fail(args,r)).state,'failed');await fail(args,r)
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 assert.equal((await attempts(args.p_request_id)).length,2)
 await assert.rejects(fail(args,envelope([unknown()],null)),/operation_conflict/)
 assert.ok(Number((await parent(args.p_request_id)).budget_cost_usd)>0)
})

test('both priced attempts contribute even when a paid primary answer failed validation',async()=>{
 const args=await start(),r=envelope([attempt('openai','provider_invalid_output'),attempt('deepseek',null,{cacheWriteTokens:null})],'deepseek')
 await complete(args,r)
 const rows=await attempts(args.p_request_id),p=await parent(args.p_request_id)
 assert.equal(p.cost_status,'calculated')
 assert.ok(Math.abs(Number(p.cost_usd)-rows.reduce((n,r)=>n+Number(r.cost_usd),0))<1e-12)
 assert.equal((await wallet(db)).lifetime_debited,7)
})

test('circuit skips allow ordered subsets, while both unavailable retains a terminal uncharged record',async()=>{
 const backup=await start();await complete(backup,envelope([attempt('deepseek')],'deepseek'))
 assert.equal((await attempts(backup.p_request_id)).length,1)
 const closed=await start();await fail(closed,envelope([],null))
 assert.equal((await attempts(closed.p_request_id)).length,0)
 assert.equal(Number((await parent(closed.p_request_id)).cost_usd),0)
 assert.equal((await wallet(db)).lifetime_debited,7)
})

test('admission reserves both providers at full cache-write or uncached peak rates',async()=>{
 const cost=(await db.query<any>('select translator_private.translation_cost_bound($1,7,10,40,now()) n',[metadata])).rows[0].n
 assert.equal(Number(cost),0.01313384)
 for(const user of [USER,OTHER]){const args=await start(randomUUID(),user);const p=await parent(args.p_request_id);assert.equal(p.provider,'openai')}
 for(const bad of [[],[plan[0],plan[0]],[...plan,plan[0]],[{provider:'invalid',model:'x'}]]){
   await assert.rejects(start(randomUUID(),USER,{...metadata,provider_plan:bad} as any),/invalid_request/)
 }
})

test('unknown mixed bills retain daily limits after success instead of releasing primary cost as zero',async()=>{
 await db.exec('update translator_private.security_policy set user_daily_usd=0.025,global_daily_usd=0.025')
 const args=await start();await complete(args,envelope([unknown(),attempt('deepseek')],'deepseek'))
 await assert.rejects(start(),/cost_limit/);await assert.rejects(start(randomUUID(),OTHER),/cost_limit/)
 assert.equal((await db.query<any>('select count(*)::int n from translator_private.cost_reservations')).rows[0].n,1)
})

test('zero attempted providers release the full admission budget and cannot be recorded as success',async()=>{
 await db.exec('update translator_private.security_policy set user_daily_usd=0.014,global_daily_usd=0.014')
 for(let i=0;i<3;i++){
   const args=await start(),r=envelope([],null)
   await assert.rejects(rpc(db,'complete_translation_metered',{...args,p_translation:'forged',p_model:'gpt-5.6-luna',p_latency_ms:1,p_receipt:r}),/invalid_request/)
   await assert.rejects(rpc(db,'complete_translation_metered',{...args,p_translation:'forged',p_model:'gpt-5.6-luna',p_latency_ms:1,p_receipt:envelope([],'openai')}),/invalid_request/)
   assert.equal((await fail(args,r)).state,'failed');await fail(args,r)
   const row=await parent(args.p_request_id)
   assert.equal(row.cost_status,'not_attempted');assert.equal(Number(row.cost_usd),0);assert.equal(Number(row.budget_cost_usd),0)
   assert.equal(row.input_tokens,0);assert.equal(row.total_tokens,0);assert.equal((await attempts(args.p_request_id)).length,0)
 }
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 const result=(await asRole<any>(db,'service_role',"select translator_private.admin_cost_summary('{}') r")).rows[0].r
 assert.equal(result.totals.unpriced_requests,0);assert.equal(result.totals.cost_usd,0);assert.equal(result.totals.metered_requests,0)
 // Budget is immediately available to another customer after all-circuit skips.
 const next=await start(randomUUID(),OTHER);assert.ok(next.p_request_id)
})

test('missing cache writes or service tier never fabricate exact zero; bad counters are rejected',async()=>{
 for(const [patch,status] of [[{cacheWriteTokens:null},'missing_cache_write'],[{serviceTier:null},'unknown_service_tier'],[{serviceTier:'priority'},'unknown_service_tier']] as const){
  const args=await start();await complete(args,envelope([attempt('openai',null,patch)],'openai'))
  const row=(await attempts(args.p_request_id))[0];assert.equal(row.cost_status,status);assert.equal(row.cost_usd,null)
 }
 for(const patch of [{cacheWriteTokens:-1},{cacheWriteTokens:1.5},{cacheWriteTokens:'0'},{cacheWriteTokens:61},{cachedTokens:101},{reasoningTokens:51}]){
  const args=await start();await assert.rejects(complete(args,envelope([attempt('openai',null,patch)],'openai')),/invalid_request/)
  await fail(args,envelope([],null))
 }
})

test('forged claims, duplicate/out-of-order providers, invalid winners and client roles cannot settle',async()=>{
 const args=await start()
 for(const r of [envelope([attempt('deepseek'),attempt()], 'openai'),envelope([attempt(),attempt()], 'openai'),
   envelope([attempt()], 'deepseek'),envelope([attempt('openai','provider_timeout')],'openai')]){
  await assert.rejects(complete(args,r),/invalid_request/)
 }
 await assert.rejects(complete({...args,p_claim_token:randomUUID()},envelope([attempt()],'openai')),/request_id_conflict/)
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select * from translator_private.provider_attempt_usage'),/permission denied/)
  await assert.rejects(asRole(db,role,'select translator_private.record_provider_usage($1,$2,$3,$4)',[USER,args.p_request_id,args.p_claim_token,envelope([attempt()],'openai')]),/permission denied/)
  await assert.rejects(asRole(db,role,"select public.complete_translation_metered($1,$2,$3,'x','gpt-5.6-luna',10,$4)",[USER,args.p_request_id,args.p_claim_token,envelope([attempt()],'openai')]),/permission denied/)
 }
 assert.equal((await attempts(args.p_request_id)).length,0);assert.equal((await wallet(db)).lifetime_debited,0)
})

test('known partial provider charges above the original estimate stay in the budget',async()=>{
 const args=await start();await complete(args,envelope([unknown(),attempt('deepseek',null,{inputTokens:200000,cachedTokens:0,cacheWriteTokens:null,totalTokens:200050})],'deepseek'))
 const rows=await attempts(args.p_request_id),p=await parent(args.p_request_id)
 assert.equal(p.cost_usd,null)
 assert.ok(Number(p.budget_cost_usd)>=Number(rows[0].maximum_usd)+Number(rows[1].cost_usd))
 await db.query('update translator_private.security_policy set user_daily_usd=$1',[Number(p.budget_cost_usd)+0.005])
 await assert.rejects(start(),/cost_limit/)
})

test('expired results keep provider receipts without a late customer debit',async()=>{
 const args=await start();await db.query("update translator_private.translation_requests set expires_at=now()-interval '1 second' where request_id=$1",[args.p_request_id])
 const r=envelope([attempt()],'openai');assert.equal((await complete(args,r)).state,'failed')
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 assert.equal((await attempts(args.p_request_id)).length,1);assert.ok(Number((await parent(args.p_request_id)).cost_usd)>0)
})

test('administrator pricing metadata identifies both official sources without changing totals shape',async()=>{
 const args=await start();await complete(args,envelope([attempt()],'openai'))
 const result=(await asRole<any>(db,'service_role',"select translator_private.admin_cost_summary('{}') r")).rows[0].r
 assert.equal(result.priceVersion,'provider-attempts-usd-2026-09-15');assert.match(result.pricingSource,/openai/)
 assert.deepEqual(result.pricingSources.map((s:any)=>s.provider),['openai','deepseek'])
 assert.equal(result.totals.requests,1);assert.equal(result.totals.charged_characters,7)
})
