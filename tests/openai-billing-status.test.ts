import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,USER,wallet} from './fixture.ts'
import {billingSyncStatusWithHistory,syncOfficialCostsWithStatus,syncBillingSnapshots,type BillingSyncEnv} from '../server/worker/src/billingSync.ts'
import {handleAdmin,supabaseAdminServices,type AdminServices} from '../server/worker/src/admin.ts'
import {balanceRpcResponse} from './deepseek-balance-fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const scope={projectId:'proj_billing_status',apiKeyIds:['key_one']}
const env:BillingSyncEnv={SUPABASE_URL:'https://billing-status-db.invalid',SUPABASE_SECRET_KEY:'test-server',OPENAI_BILLING_ADMIN_KEY:'test-admin-private',OPENAI_BILLING_PROJECT_ID:scope.projectId,OPENAI_BILLING_API_KEY_IDS:'key_one'}
const today=new Date().toISOString().slice(0,10),range={from:today,to:today},start=Date.parse(today+'T00:00:00Z')/1000
const successfulPage={object:'page',has_more:false,next_page:null,data:[{object:'bucket',start_time:start,end_time:start+86400,
 results:[{object:'organization.costs.result',project_id:scope.projectId,api_key_id:'key_one',line_item:'inference',amount:{currency:'usd',value:'0.050000000001'}}]}]}
before(async()=>{db=await database()});after(async()=>db.close())
beforeEach(async()=>{await db.exec('delete from translator_private.openai_billing_sync;delete from translator_private.provider_bill_snapshots');await reset(db)})
async function record(id:string,started:string,finished:string,error:string|null,s=scope){
 return (await asRole<any>(db,'service_role','select public.record_openai_billing_sync($1,$2,$3,$4,$5) r',[s,id,started,finished,error])).rows[0].r
}
async function state(s=scope){return (await asRole<any>(db,'service_role','select public.read_openai_billing_sync($1) r',[s])).rows[0].r}
async function databaseReply(input:string|URL,init?:RequestInit){
 const url=String(input);if(!url.startsWith(env.SUPABASE_URL))return null
 const b=JSON.parse(String(init?.body));assert.equal(init?.redirect==='manual'||url.endsWith('/record_official_bill'),true)
 if(url.endsWith('/record_openai_billing_sync'))return Response.json(await record(b.p_attempt,b.p_started_at,b.p_finished_at,b.p_error,b.p_scope))
 if(url.endsWith('/read_openai_billing_sync'))return Response.json(await state(b.p_scope))
 if(url.endsWith('/record_official_bill')){
  await asRole(db,'service_role','select public.record_official_bill($1,$2,$3,$4,$5,$6)',[b.p_id,b.p_from,b.p_to,b.p_scope,b.p_usd,b.p_fetched_at]);return Response.json({})
 }
 throw Error('unexpected database route')
}
async function previousBill(){
 const id=randomUUID(),at=new Date(Date.now()-300000).toISOString()
 await asRole(db,'service_role','select public.record_official_bill($1,$2,$3,$4,$5,$6)',[id,new Date(start*1000).toISOString(),new Date((start+86400)*1000).toISOString(),scope,'0.048528700000',at]);return {id,at}
}

test('deactivated official account is classified and persisted without overwriting the last successful amount',async t=>{
 const old=await previousBill(),before=await wallet(db);let providerCalls=0
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const reply=await databaseReply(input,init);if(reply)return reply;providerCalls++
  return Response.json({error:{code:'account_deactivated',message:'private provider text test-admin-private'}},{status:401})
 })
 await assert.rejects(syncOfficialCostsWithStatus(env,range),e=>e instanceof Error&&e.message==='billing_account_deactivated')
 const status=await billingSyncStatusWithHistory(env)
 assert.equal(status.configured,true);assert.equal(status.sync.status,'error');assert.equal(status.sync.errorCode,'billing_account_deactivated')
 assert.match(status.sync.message,/账号已停用/);assert.match(status.sync.message,/官方申诉/)
 assert.equal(Date.parse(status.sync.lastSuccessAt!),Date.parse(old.at));assert.ok(status.sync.lastAttemptAt)
 assert.equal(providerCalls,1);assert.equal(JSON.stringify(status).includes('test-admin-private'),false);assert.equal(JSON.stringify(status).includes('private provider text'),false)
 const rows=(await db.query<any>('select id,official_usd::text as amount from translator_private.provider_bill_snapshots')).rows
 assert.deepEqual(rows,[{id:old.id,amount:'0.048528700000'}]);assert.deepEqual(await wallet(db),before)
})

test('successful recovery clears the saved error and advances actual success time; account scope changes read unknown',async t=>{
 const old=await previousBill(),at=new Date(Date.now()-2000).toISOString()
 await record(randomUUID(),at,at,'billing_account_deactivated')
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>(await databaseReply(input,init))||Response.json(successfulPage))
 await syncOfficialCostsWithStatus(env,range)
 const status=await billingSyncStatusWithHistory(env)
 assert.equal(status.sync.status,'fresh');assert.equal(status.sync.errorCode,null);assert.ok(Date.parse(status.sync.lastSuccessAt!)>Date.parse(old.at))
 assert.equal((await db.query('select * from translator_private.provider_bill_snapshots')).rows.length,2)
 const changed=await billingSyncStatusWithHistory({...env,OPENAI_BILLING_API_KEY_IDS:'key_new'})
 assert.equal(changed.sync.status,'unknown');assert.equal(changed.sync.errorCode,null);assert.equal(changed.sync.lastSuccessAt,null)
 assert.equal((await billingSyncStatusWithHistory({...env,OPENAI_BILLING_ADMIN_KEY:''})).configured,false)
})

test('late older outcomes cannot replace newer status; identical completion replay is idempotent and corruption fails closed',async()=>{
 const old=new Date(Date.now()-4000).toISOString(),current=new Date(Date.now()-2000).toISOString(),finished=new Date(Date.now()-1000).toISOString(),id=randomUUID()
 await record(id,current,finished,'billing_account_deactivated')
 assert.deepEqual(await record(id,current,finished,'billing_account_deactivated'),{recorded:true,replayed:true})
 assert.deepEqual(await record(randomUUID(),old,finished,null),{recorded:false,outdated:true})
 assert.equal((await state()).errorCode,'billing_account_deactivated')
 await assert.rejects(record(id,current,finished,null),/operation_conflict/)
 await assert.rejects(record(randomUUID(),current,finished,'raw_private_provider_error'),/invalid_request/)
 await assert.rejects(record(randomUUID(),current,finished,null,{} as any),/invalid_request/)
 assert.equal((await db.query('select * from translator_private.openai_billing_sync')).rows.length,1)
})

test('sync-state storage is private and owner status GET awaits its safe result',async()=>{
 const at=new Date().toISOString()
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select public.read_openai_billing_sync($1)',[scope]),/permission denied/)
  await assert.rejects(asRole(db,role,'select public.record_openai_billing_sync($1,$2,$3,$4,$5)',[scope,randomUUID(),at,at,'billing_permission']),/permission denied/)
  await assert.rejects(asRole(db,role,'select * from translator_private.openai_billing_sync'),/permission denied/)
 }
 let role='support',reads=0
 const services:AdminServices={origins:[],authenticate:async()=>({id:USER,aal:'aal2',enrolled:true,mfaAt:Date.now()/1000,sessionId:'test'}),rpc:async()=>({role}),
  billingStatus:async()=>{reads++;return {configured:true,sync:{status:'error',errorCode:'billing_account_deactivated',message:'账号已停用'}}}}
 const request=()=>new Request('https://api.hellodog.net/api/admin/billing-status',{headers:{Authorization:'Bearer test'}})
 assert.equal((await handleAdmin(request(),services)).status,403);assert.equal(reads,0)
 role='owner';const response=await handleAdmin(request(),services);assert.equal(response.status,200);assert.equal((await response.json() as any).sync.errorCode,'billing_account_deactivated');assert.equal(reads,1)
})

test('status storage failures cannot hide deactivation or prevent the independent DeepSeek refresh',async t=>{
 const writes:string[]=[],logs:string[]=[]
 t.mock.method(console,'warn',(value:string)=>{logs.push(value)})
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=String(input)
  if(url.includes('api.openai.com'))return Response.json({error:{code:'account_deactivated',message:'must not escape'}},{status:401})
  if(url.endsWith('/record_openai_billing_sync')){writes.push(String(init?.body));return new Response(null,{status:503})}
  if(url.includes('api.deepseek.com'))return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1.00',granted_balance:'0',topped_up_balance:'1.00'}]})
  const result=balanceRpcResponse(url,String(init?.body));assert.ok(result);return result
 })
 const result=await syncBillingSnapshots({...env,DEEPSEEK_API_KEY:'test-deepseek'})
 assert.deepEqual(result.openai,{error:'billing_account_deactivated'});assert.ok('sync' in result.deepseek);assert.equal(result.deepseek.sync.status,'fresh')
 assert.equal(writes.length,2);assert.equal(writes[0],writes[1]);assert.deepEqual(logs,['billing_sync_status_unavailable'])
 assert.equal(writes[0].includes('must not escape'),false)
})

test('manual production entrypoint preserves classification; malformed caller range does not write an account outage',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  calls++;return (await databaseReply(input,init))||Response.json({error:{code:'account_deactivated'}},{status:403})
 })
 const services=supabaseAdminServices({...env,SUPABASE_PUBLISHABLE_KEY:'test-public'})
 await assert.rejects(services.syncBilling!({from:'not-a-date',to:today}),/invalid_request/);assert.equal(calls,0)
 await assert.rejects(services.syncBilling!(range),/billing_account_deactivated/)
 assert.equal((await state()).errorCode,'billing_account_deactivated')
})
