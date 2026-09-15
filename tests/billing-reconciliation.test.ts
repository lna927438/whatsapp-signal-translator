import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,rpc,asRole,USER,OTHER,wallet} from './fixture.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>db.close())
beforeEach(async()=>{await db.exec('delete from public.admin_audit;delete from translator_private.provider_bill_snapshots;delete from translator_private.provider_balance_snapshots');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const plan=[{provider:'openai',model:'gpt-5.6-luna'},{provider:'deepseek',model:'deepseek-v4-pro'}]
async function translated(unknown=false){
 const now=new Date().toISOString(),id=randomUUID(),claim=randomUUID()
 await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:id,p_payload_hash:'a'.repeat(64),p_characters:7,p_claim_token:claim,p_metadata:{metering_version:'2',provider:'openai',requested_model:'gpt-5.6-luna',provider_plan:plan}})
 const attempts=plan.map((p,i)=>({...p,startedAt:now,finishedAt:now,errorCode:i?null:'provider_wrong_language',receipt:{model:p.model,httpStatus:200,createdAt:now,serviceTier:'default',inputTokens:100,cachedTokens:40,cacheWriteTokens:i?null:20,outputTokens:50,totalTokens:150,reasoningTokens:0,...(unknown&&!i?{inputTokens:null,outputTokens:null,cachedTokens:null,cacheWriteTokens:null,totalTokens:null,httpStatus:null}:{})}}))
 await rpc(db,'complete_translation_metered',{p_user_id:OTHER,p_request_id:id,p_claim_token:claim,p_translation:'synthetic',p_model:'deepseek-v4-pro',p_latency_ms:10,p_receipt:{version:2,selectedProvider:'deepseek',attempts}})
 return id
}
const costs=async(filter={})=>(await asRole<any>(db,'service_role','select public.admin_read($1,\'costs\',$2) r',[USER,filter])).rows[0].r

test('provider filters include every mixed attempt but attribute customer characters only to the winner',async()=>{
 await translated();const all=await costs(),openai=await costs({provider:'openai'}),ds=await costs({provider:'deepseek'})
 assert.equal(all.totals.requests,1);assert.equal(all.totals.provider_requests,2);assert.equal(all.totals.charged_characters,7)
 assert.equal(openai.totals.charged_characters,0);assert.equal(ds.totals.charged_characters,7)
 assert.ok(openai.totals.cost_usd>0);assert.ok(ds.totals.cost_usd>0)
 assert.ok(Math.abs(all.totals.cost_usd-openai.totals.cost_usd-ds.totals.cost_usd)<1e-12)
 assert.equal(openai.users[0].charged_characters,0);assert.equal(ds.users[0].charged_characters,7)
 assert.deepEqual(await wallet(db,OTHER),{balance:93,reserved_characters:0,lifetime_debited:7})
})
test('known backup charges remain visible while a missing primary receipt prevents a false complete total',async()=>{
 await translated(true);const all=await costs(),openai=await costs({provider:'openai'}),ds=await costs({provider:'deepseek'})
 assert.equal(all.totals.cost_usd,null);assert.ok(all.totals.known_cost_usd>0)
 assert.equal(all.totals.known_cost_usd,ds.totals.cost_usd);assert.equal(openai.totals.known_cost_usd,0)
 assert.equal(all.totals.unpriced_requests,1);assert.equal(all.totals.missing_receipt_requests,1)
 assert.match(all.totals.known_cost_usd_exact,/^0\.\d+$/)
})
test('UTC cost days follow actual provider call time without silently moving customer debits',async()=>{
 const id=await translated()
 await db.query("update translator_private.translation_requests set created_at='2026-09-15T00:01:00Z' where request_id=$1",[id])
 await db.query("update translator_private.provider_attempt_usage set started_at='2026-09-14T23:59:59Z',finished_at='2026-09-15T00:00:01Z' where request_id=$1",[id])
 const old=await costs({from:'2026-09-14',to:'2026-09-14',timezone:'UTC'}),next=await costs({from:'2026-09-15',to:'2026-09-15',timezone:'UTC'})
 assert.ok(old.totals.cost_usd>0);assert.equal(old.totals.charged_characters,0);assert.ok(old.days[0].cost_usd>0)
 assert.equal(next.totals.cost_usd,0);assert.equal(next.totals.charged_characters,7)
 const local=await costs({from:'2026-09-15',to:'2026-09-15'});assert.equal(local.timezone,'Asia/Shanghai');assert.equal(local.totals.charged_characters,7);assert.ok(local.totals.cost_usd>0)
})
test('official snapshots preserve exact USD, scope, update time and immutability; ordinary clients cannot write',async()=>{
 const id=randomUUID(),at=new Date().toISOString(),scope={projectId:'proj_test',apiKeyIds:['key_test']},args=[id,'2026-09-14T00:00:00Z','2026-09-15T00:00:00Z',scope,'0.123456789012',at]
 const query='select public.record_official_bill($1,$2,$3,$4,$5,$6) r'
 await asRole(db,'service_role',query,args);await asRole(db,'service_role',query,args)
 const rows=await costs({from:'2026-09-14',to:'2026-09-14',timezone:'UTC'});assert.equal(rows.officialBills.length,1)
 assert.equal(rows.officialBills[0].official_usd_exact,'0.123456789012');assert.equal(rows.officialBills[0].provisional,true)
 await assert.rejects(asRole(db,'service_role',query,[...args.slice(0,4),'0.2',at]),/operation_conflict/)
 for(const role of ['anon','authenticated'] as const)await assert.rejects(asRole(db,role,query,args),/permission denied/)
 assert.equal((await costs({from:'2026-09-14',to:'2026-09-14'})).officialBills.length,0)
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
})
test('GMT+8 costs also follow the actual call, including retries across the local midnight boundary',async()=>{
 const id=await translated()
 await db.query("update translator_private.translation_requests set created_at='2026-09-14T15:59:00Z' where request_id=$1",[id])
 await db.query("update translator_private.provider_attempt_usage set started_at='2026-09-14T16:01:00Z',finished_at='2026-09-14T16:01:01Z' where request_id=$1",[id])
 const old=await costs({from:'2026-09-14',to:'2026-09-14',timezone:'Asia/Shanghai'}),next=await costs({from:'2026-09-15',to:'2026-09-15',timezone:'Asia/Shanghai'})
 assert.equal(old.totals.cost_usd,0);assert.equal(old.totals.charged_characters,7)
 assert.ok(next.totals.cost_usd>0);assert.equal(next.totals.charged_characters,0);assert.ok(next.days[0].known_cost_usd>0)
})
test('manual bill comparison accepts missing token totals and keeps one audited snapshot',async()=>{
 await translated();const local=await costs({provider:'deepseek'}),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),id=randomUUID()
 const data={from:day,to:day,officialUsd:local.totals.known_cost_usd_exact,officialTokens:null,officialRequests:null,reference:'Official statement fixture',timezone:'Asia/Shanghai'}
 const args=[USER,id,'cost.reconcile','deepseek','本地账单验收',data],query='select public.admin_mutate($1,$2,$3,$4,$5,$6) r'
 const result=(await asRole<any>(db,'service_role',query,args)).rows[0].r;assert.equal(result.status,'matched');assert.equal(result.officialTokens,null)
 await asRole(db,'service_role',query,args);assert.equal((await db.query('select id from translator_private.provider_bill_snapshots')).rows.length,1)
})
test('DeepSeek official balances are separate snapshots, never inferred translation spend',async()=>{
 const balances=[{currency:'USD',total:'12.123456789012',granted:'2',paid:'10.123456789012'}]
 const args=[randomUUID(),balances,true,new Date().toISOString()];await asRole(db,'service_role','select public.record_provider_balance($1,$2,$3,$4)',args)
 const value=await costs();assert.equal(value.providerBalance.balances[0].total,'12.123456789012');assert.equal(value.totals.cost_usd,0)
 assert.equal(value.totals.charged_characters,0);assert.equal((await wallet(db)).balance,100)
})
test('official negative adjustments and negative balances stay signed without changing customer wallets',async()=>{
 const at=new Date().toISOString(),scope={projectId:'proj_test',apiKeyIds:['key_test']}
 await asRole(db,'service_role','select public.record_official_bill($1,$2,$3,$4,$5,$6)',[randomUUID(),'2026-09-14T00:00:00Z','2026-09-15T00:00:00Z',scope,'-0.000000000001',at])
 const balances=[{currency:'USD',total:'-0.000000000001',granted:'0',paid:'-0.000000000001'}]
 await asRole(db,'service_role','select public.record_provider_balance($1,$2,$3,$4)',[randomUUID(),balances,false,at])
 const value=await costs({from:'2026-09-14',to:'2026-09-14',timezone:'UTC'})
 assert.equal(value.officialBills[0].official_usd_exact,'-0.000000000001');assert.equal(value.providerBalance.balances[0].total,'-0.000000000001')
 assert.equal(value.totals.known_cost_usd,0);assert.equal((await wallet(db)).balance,100)
})
test('cost-reader roles cannot obtain owner-only official account balances or statement snapshots',async()=>{
 for(const role of ['support','finance','admin']){
  await db.query("insert into public.admin_roles(user_id,role) values($1,$2) on conflict(user_id) do update set role=excluded.role",[OTHER,role])
  const other=(await asRole<any>(db,'service_role',"select public.admin_read($1,'costs','{}') r",[OTHER])).rows[0].r
  assert.equal('providerBalance' in other,false);assert.equal('officialBills' in other,false);assert.ok(other.totals)
 }
 const owner=await costs();assert.equal('providerBalance' in owner,true);assert.equal('officialBills' in owner,true)
})
