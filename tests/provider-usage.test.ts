import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,rpc,wallet,USER,OTHER} from './fixture.ts'
import {captureProviderReceipt,providerReceipt} from '../server/worker/src/providerUsage.ts'
import {validateMutation} from '../server/worker/src/admin.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()})
after(async()=>{await db.close()})
beforeEach(async()=>{await db.exec('delete from translator_private.admin_policy;delete from public.admin_audit');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const read=async(kind:string,filter={},actor=USER)=>(await asRole<{r:any}>(db,'service_role','select public.admin_read($1,$2,$3::jsonb) r',[actor,kind,JSON.stringify(filter)])).rows[0].r
const mutate=async(action:string,target:string,data:unknown,id=randomUUID(),actor=USER)=>(await asRole<{r:any}>(db,'service_role','select public.admin_mutate($1,$2,$3,$4,$5,$6::jsonb) r',[actor,id,action,target,'添加字符操作',JSON.stringify(data)])).rows[0].r
async function begin(id='metered'){
  const claim=randomUUID()
  await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:id,p_payload_hash:'b'.repeat(64),p_characters:7,p_claim_token:claim,p_metadata:{provider:'deepseek',requested_model:'deepseek-flash',metering_version:'1'}})
  await db.query("update translator_private.provider_usage set started_at='2026-09-11T02:00:00Z' where user_id=$1 and request_id=$2",[OTHER,id])
  return {p_user_id:OTHER,p_request_id:id,p_claim_token:claim}
}
function receipt(patch={}){return {...providerReceipt('deepseek-flash'),inputTokens:100,cachedTokens:40,outputTokens:50,totalTokens:150,reasoningTokens:10,httpStatus:200,createdAt:'2026-09-11T02:00:00Z',responseId:'response-actual',requestId:'provider-request-actual',...patch}}
async function complete(args:Record<string,unknown>,r=receipt()){
  return rpc(db,'complete_translation_metered',{...args,p_translation:'Test translation',p_model:'deepseek-flash',p_latency_ms:50,p_receipt:r})
}
test('actual cache, input and output tokens use official peak USD rates without charging reasoning twice',async()=>{
  const args=await begin();const first=await complete(args);const second=await complete(args)
  assert.equal(first.state,second.state);assert.deepEqual(first.response,second.response)
  const row=(await read('translations')).rows[0]
  assert.equal(row.input_tokens,100);assert.equal(row.cached_tokens,40);assert.equal(row.output_tokens,50);assert.equal(row.total_tokens,150)
  assert.equal(row.cost_usd,0.00007824);assert.equal(row.price_period,'peak');assert.equal(row.cost_status,'calculated')
  assert.equal(row.charged,7);assert.equal(row.debit_count,1)
  assert.equal((await wallet(db,OTHER)).balance,93)
  const totals=(await read('costs')).totals
  assert.equal(totals.cost_usd,0.00007824);assert.equal(totals.metered_requests,1)
})
test('official peak boundaries use UTC weekdays, including Friday-to-weekend transition',async()=>{
  for(const [at,expected] of [['2026-09-11T00:59:59Z',false],['2026-09-11T01:00:00Z',true],['2026-09-11T04:00:00Z',false],['2026-09-11T06:00:00Z',true],['2026-09-11T10:00:00Z',false],['2026-09-12T02:00:00Z',false]] as const){
    assert.equal((await asRole<{p:boolean}>(db,'service_role','select translator_private.deepseek_peak($1) p',[at])).rows[0].p,expected)
  }
})
test('paid provider response that fails translation validation is still accounted without a customer debit',async()=>{
  const args=await begin()
  await rpc(db,'fail_translation_metered',{...args,p_error_code:'provider_request',p_receipt:receipt()})
  const row=(await read('translations')).rows[0]
  assert.equal(row.charged,0);assert.equal(row.cost_usd,0.00007824);assert.equal(row.cost_status,'calculated')
  assert.equal((await read('costs')).totals.provider_only_requests,1)
  assert.deepEqual(await wallet(db,OTHER),{balance:100,reserved_characters:0,lifetime_debited:0})
})
test('timeouts, missing cache split, unknown models and historical records remain unpriced',async()=>{
  let args=await begin('timeout');await rpc(db,'fail_translation_metered',{...args,p_error_code:'provider_timeout',p_receipt:providerReceipt('deepseek-flash')})
  args=await begin('cache-missing');await complete(args,receipt({cachedTokens:null}))
  args=await begin('other-model');await complete(args,receipt({model:'unknown-model'}))
  const legacy=randomUUID();await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:'legacy',p_payload_hash:'c'.repeat(64),p_characters:7,p_claim_token:legacy,p_metadata:{}})
  await rpc(db,'complete_translation',{p_user_id:OTHER,p_request_id:'legacy',p_claim_token:legacy,p_translation:'old result',p_model:'old-model',p_latency_ms:1})
  const rows=(await read('translations')).rows
  for(const [id,status] of [['timeout','unknown_response'],['cache-missing','missing_cache'],['other-model','unknown_price'],['legacy','historical_unavailable']]){const r=rows.find((r:any)=>r.request_id===id);assert.equal(r.cost_status,status);assert.equal(r.cost_usd,null)}
  const t=(await read('costs')).totals;assert.equal(t.cost_usd,null);assert.equal(t.unpriced_requests,4);assert.equal(t.historical_requests,1)
})
test('receipt projection excludes source text and rejects inconsistent or fractional counters',()=>{
  const r=providerReceipt('deepseek-flash'),now=Date.now()
  captureProviderReceipt(r,{id:'resp-safe',model:'deepseek-flash',created_at:now/1000,output_text:'private body',usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:5}}},new Response('{}',{headers:{'x-request-id':'request-safe'}}),now,now)
  assert.equal(r.totalTokens,120);assert.equal(r.requestId,'request-safe');assert.ok(!JSON.stringify(r).includes('private body'))
  captureProviderReceipt(r,{usage:{input_tokens:10,output_tokens:5,total_tokens:99,input_tokens_details:{cached_tokens:40}}},new Response('{}'),now,now)
  assert.equal(r.inputTokens,null);assert.equal(r.cachedTokens,null)
})
test('a relative character addition works during a translation and is idempotent after a lost response',async()=>{
  const args=await begin(),id=randomUUID()
  await complete(args)
  const first=await mutate('wallet.add',OTHER,{amount:1000},id)
  assert.equal(first.balanceAfter,1093)
  for(let i=0;i<5;i++)assert.equal((await mutate('wallet.add',OTHER,{amount:1000},id)).balanceAfter,1093)
  assert.equal((await read('operation',{operationId:id})).found,true)
  assert.equal((await wallet(db,OTHER)).balance,1093)
  assert.equal((await db.query('select * from public.admin_audit where id=$1',[id])).rows.length,1)
  await assert.rejects(mutate('wallet.add',OTHER,{amount:1001},id),/operation_conflict/)
  assert.throws(()=>validateMutation({operationId:randomUUID(),action:'wallet.add',target:OTHER,reason:'test',data:{amount:-1}}))
})
test('single owner policy prevents creating, replacing or removing another admin and rejects ordinary clients',async()=>{
  await db.query('insert into translator_private.admin_policy(user_id) values($1)',[USER])
  assert.equal((await read('session')).singleAdmin,true)
  await assert.rejects(mutate('role.set',OTHER,{role:'owner'}),/single_owner/)
  await assert.rejects(db.query('delete from public.admin_roles where user_id=$1',[USER]),/single_owner/)
  await assert.rejects(read('costs',{},OTHER),/admin_forbidden/)
  for(const role of ['anon','authenticated'] as const){
    await assert.rejects(asRole(db,role,'select * from translator_private.provider_usage'),/permission denied/)
    await assert.rejects(asRole(db,role,"select public.admin_read($1,'costs','{}')",[USER]),/permission denied/)
  }
})
test('official bill comparison is an audited snapshot and never calls incomplete history matched',async()=>{
  const args=await begin();await complete(args)
  const day='2026-09-11' // This fixture's provider call is fixed to this day, independent of request creation.
  const data={from:day,to:day,officialUsd:'0.000078240000',officialTokens:150,officialRequests:1,reference:'Local exact bill fixture'}
  const id=randomUUID(),match=await mutate('cost.reconcile','deepseek',data,id)
  assert.equal(match.status,'matched');assert.equal(match.differenceUsd,0)
  await complete(await begin('missing'),receipt({cachedTokens:null}))
  assert.equal((await mutate('cost.reconcile','deepseek',data,id)).status,'matched') // immutable snapshot
  const incomplete=await mutate('cost.reconcile','deepseek',data)
  assert.equal(incomplete.status,'incomplete');assert.equal(incomplete.differenceUsd,null)
})
