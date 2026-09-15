import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,asRole,reset,USER,OTHER,wallet} from './fixture.ts'
import {supabaseAdminServices,validateMutation} from '../server/worker/src/admin.ts'
import {currentOfficialBillScopes} from '../server/worker/src/officialBillScopes.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>db.close())
beforeEach(async()=>{await db.exec('delete from public.admin_audit;delete from translator_private.provider_bill_snapshots');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const env={SUPABASE_URL:'https://scope-db.invalid',SUPABASE_SECRET_KEY:'test-service',SUPABASE_PUBLISHABLE_KEY:'test-public',OPENAI_BILLING_ADMIN_KEY:'test-admin',OPENAI_BILLING_PROJECT_ID:'proj_current',OPENAI_BILLING_API_KEY_IDS:'key_two,key_one',DEEPSEEK_API_KEY:'test-deepseek'}
const openai={projectId:'proj_current',apiKeyIds:['key_one','key_two']},deepseek={credentialDigest:'a'.repeat(64)},scopes={openai,deepseek}
const range={from:'2026-09-14',to:'2026-09-14',timezone:'UTC'}
const statement={...range,officialUsd:'0.123456789012',officialTokens:null,officialRequests:null,reference:'Official export synthetic fixture'}
const read=async(scopeValue:any=scopes,filter:any=range,actor=USER)=>(await asRole<any>(db,'service_role','select public.read_current_official_bills($1,$2,$3) r',[actor,filter,scopeValue])).rows[0].r
async function auto(scope:any,amount='0.012345678901'){
 const id=randomUUID();await asRole(db,'service_role','select public.record_official_bill($1,$2,$3,$4,$5,$6)',[id,'2026-09-14T00:00:00Z','2026-09-15T00:00:00Z',scope,amount,new Date().toISOString()]);return id
}
async function manual(provider='deepseek',scope:any=deepseek,data:any=statement,id=randomUUID()){
 return (await asRole<any>(db,'service_role','select public.record_scoped_official_statement($1,$2,$3,$4,$5,$6) r',[USER,id,provider,'Verified official statement fixture',data,scope])).rows[0].r
}

test('a newer old-account bill cannot replace the matching current project and exact key set',async()=>{
 const current=await auto({projectId:'proj_current',apiKeyIds:['key_two','key_one','key_one']})
 await auto({projectId:'proj_old',apiKeyIds:['key_one','key_two']},'9')
 await auto({projectId:'proj_current',apiKeyIds:['key_one']},'8')
 const rows=await read();assert.equal(rows.length,1);assert.equal(rows[0].id,current)
 assert.equal(rows[0].official_usd_exact,'0.012345678901');assert.equal(rows[0].currentAccount,true);assert.equal(rows[0].periodComplete,true);assert.equal(rows[0].currency,'USD')
 assert.equal('scope' in rows[0],false);assert.equal('actor_id' in rows[0],false)
 assert.deepEqual(await read({...scopes,openai:{projectId:'proj_current',apiKeyIds:['key_new']}}),[])
 assert.deepEqual(await read({openai:null,deepseek:null}),[])
})

test('unscoped legacy manual statements remain in history but never satisfy the current-account cost card',async()=>{
 await asRole(db,'service_role','select public.admin_mutate($1,$2,$3,$4,$5,$6)',[USER,randomUUID(),'cost.reconcile','deepseek','Historical unscoped fixture',{...statement,officialUsd:'7'}])
 assert.deepEqual(await read(),[])
 const id=randomUUID();await manual('deepseek',deepseek,statement,id)
 const rows=await read();assert.equal(rows.length,1);assert.equal(rows[0].id,id);assert.equal(rows[0].source,'manual_statement');assert.equal(rows[0].provisional,true)
 assert.equal(rows[0].official_usd_exact,'0.123456789012')
 assert.deepEqual(await read({...scopes,deepseek:{credentialDigest:'b'.repeat(64)}}),[])
 assert.equal((await db.query('select * from translator_private.provider_bill_snapshots')).rows.length,2)
})

test('official bills never cross timezones, partial periods, provider filters, or customer scopes',async()=>{
 await auto(openai)
 await manual('deepseek',deepseek,{...statement,timezone:'Asia/Shanghai'})
 assert.deepEqual((await read()).map((x:any)=>x.provider),['openai'])
 assert.deepEqual((await read(scopes,{...range,timezone:'Asia/Shanghai'})).map((x:any)=>x.provider),['deepseek'])
 assert.deepEqual(await read(scopes,{...range,provider:'deepseek'}),[])
 assert.deepEqual(await read(scopes,{...range,from:'2026-09-13'}),[])
 assert.deepEqual(await read(scopes,{...range,userId:OTHER}),[])
})

test('zero and signed official values are exact; repeated statement operation creates one immutable audit and snapshot',async()=>{
 const id=randomUUID(),data={...statement,officialUsd:'0',officialTokens:0,officialRequests:0,provisional:false}
 const outcome=await manual('deepseek',deepseek,data,id)
 assert.equal(outcome.status,'incomplete');assert.equal(outcome.differenceUsd,null);assert.equal(outcome.differenceUsdExact,null)
 assert.equal(outcome.comparisonReason,'local_account_scope_unavailable');assert.equal(outcome.comparisonBasis,'provider_all_accounts_unscoped')
 assert.equal((await manual('deepseek',deepseek,data,id)).replayed,true)
 const row=(await read())[0];assert.equal(row.official_usd_exact,'0.000000000000');assert.equal(row.provisional,false)
 await assert.rejects(manual('deepseek',deepseek,{...data,officialUsd:'1'},id),/operation_conflict/)
 await assert.rejects(manual('deepseek',{credentialDigest:'b'.repeat(64)},data,id),/operation_conflict/)
 const audits=(await db.query<any>('select * from public.admin_audit')).rows
 assert.equal(audits.length,1);assert.equal(audits[0].input.accountScopeBound,true)
 assert.equal('accountScope' in audits[0].input,false);assert.equal(JSON.stringify(audits).includes(deepseek.credentialDigest),false)
 await manual('deepseek',deepseek,{...statement,officialUsd:'-0.000000000001'})
 assert.equal((await read())[0].official_usd_exact,'-0.000000000001')
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
})

test('official scoped APIs deny ordinary clients and non-owner reads without changing previous role behavior',async()=>{
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select public.read_current_official_bills($1,$2,$3)',[USER,range,scopes]),/permission denied/)
  await assert.rejects(asRole(db,role,'select public.record_scoped_official_statement($1,$2,$3,$4,$5,$6)',[USER,randomUUID(),'deepseek','Unauthorized fixture',statement,deepseek]),/permission denied/)
 }
 await db.query("insert into public.admin_roles(user_id,role) values($1,'finance')",[OTHER]);await assert.rejects(read(scopes,range,OTHER),/admin_forbidden/)
 await assert.rejects(manual('deepseek',{},statement),/invalid_request/)
 await assert.rejects(manual('deepseek',deepseek,{...statement,currency:'CNY'}),/invalid_request/)
})

test('Worker injects current scopes and replaces unsafe legacy summaries without leaking scope or secrets',async t=>{
 const calls:string[]=[];let allowBills=true
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const name=new URL(String(input)).pathname.split('/').pop()!;calls.push(name);const body=JSON.parse(String(init?.body))
  if(name==='admin_read')return Response.json({totals:{cost_usd:123},...(allowBills?{officialBills:[{scope:{secret:'legacy'},official_usd_exact:'999'}]}:{})})
  assert.equal(name,'read_current_official_bills');assert.equal(body.p_actor,USER)
  assert.deepEqual(body.p_filter,{...range,provider:body.p_filter.provider,timezone:body.p_filter.provider==='openai'?'UTC':'Asia/Shanghai'})
  assert.deepEqual(body.p_scopes.openai,openai);assert.match(body.p_scopes.deepseek.credentialDigest,/^[a-f0-9]{64}$/)
  return Response.json([{provider:body.p_filter.provider,official_usd_exact:'0',currentAccount:true,periodComplete:true,currency:'USD'}])
 })
 const services=supabaseAdminServices(env),value=await services.rpc('admin_read',{p_actor:USER,p_kind:'costs',p_filter:range}) as any
 assert.equal(value.officialBills[0].official_usd_exact,'0');assert.ok(!JSON.stringify(value).includes('legacy'));assert.ok(!JSON.stringify(value).includes('test-deepseek'))
 assert.equal(value.officialBills.length,2);assert.deepEqual(value.officialBillingBasis,{kind:'provider_reporting_period',from:range.from,to:range.to,timezones:{openai:'UTC',deepseek:'Asia/Shanghai'}})
 allowBills=false;calls.length=0
 const ordinary=await services.rpc('admin_read',{p_actor:OTHER,p_kind:'costs',p_filter:range}) as any
 assert.equal('officialBills' in ordinary,false);assert.deepEqual(calls,['admin_read'])
})

test('Worker native provider statements preserve business filters, never conflate UTC/GMT8 boundaries, and honor provider/user selections',async t=>{
 const requested:any[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body))
  if(String(input).endsWith('/admin_read'))return Response.json({officialBills:[],timezone:body.p_filter.timezone,from:'2026-09-13T16:00:00Z',toExclusive:'2026-09-14T16:00:00Z'})
  requested.push(body.p_filter);return Response.json([])
 })
 const services=supabaseAdminServices(env),filter={...range,timezone:'Asia/Shanghai',provider:'openai'}
 const value=await services.rpc('admin_read',{p_actor:USER,p_kind:'costs',p_filter:filter}) as any
 assert.deepEqual(requested,[{...range,provider:'openai'}]);assert.equal(value.timezone,'Asia/Shanghai');assert.equal(value.from,'2026-09-13T16:00:00Z')
 assert.deepEqual(value.officialBills,[]);assert.equal(value.officialBillingBasis.timezones.deepseek,'Asia/Shanghai')
 requested.length=0;const user=await services.rpc('admin_read',{p_actor:USER,p_kind:'costs',p_filter:{...range,userId:OTHER}}) as any
 assert.deepEqual(requested,[]);assert.deepEqual(user.officialBills,[])
})

test('public form cannot forge account scopes; current credentials are injected only after validation',async t=>{
 const data={...statement,timezone:'Asia/Shanghai'}
 const operation={operationId:randomUUID(),action:'cost.reconcile',target:'deepseek',reason:'Verified official data',data}
 assert.throws(()=>validateMutation({...operation,data:{...data,accountScope:{credentialDigest:'b'.repeat(64)}}}),/invalid_request/)
 assert.throws(()=>validateMutation({...operation,data:{...data,provisional:'false'}}),/invalid_request/)
 const checked=validateMutation({...operation,data:{...data,provisional:true}})
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  assert.ok(String(input).endsWith('/record_scoped_official_statement'));const body=JSON.parse(String(init?.body))
  assert.deepEqual(body.p_scope,(await currentOfficialBillScopes(env)).deepseek);assert.equal(body.p_data.provisional,true);assert.equal('scope' in body.p_data,false)
  return Response.json({source:'manual_statement',currentAccount:true})
 })
 await supabaseAdminServices(env).rpc('admin_mutate',{p_actor:USER,p_operation:checked.operationId,p_action:checked.action,p_target:checked.target,p_reason:checked.reason,p_data:checked.data})
 await assert.rejects(supabaseAdminServices({...env,DEEPSEEK_API_KEY:''}).rpc('admin_mutate',{p_actor:USER,p_operation:checked.operationId,p_action:checked.action,p_target:'deepseek',p_reason:checked.reason,p_data:checked.data}),/billing_not_configured/)
})

test('statement forms reject explicit foreign reporting timezones and default omitted timezone to provider native',async t=>{
 const operation={operationId:randomUUID(),action:'cost.reconcile',target:'deepseek',reason:'Verified official data',data:statement}
 assert.throws(()=>validateMutation(operation),/invalid_request/)
 assert.throws(()=>validateMutation({...operation,target:'openai',data:{...statement,timezone:'Asia/Shanghai'}}),/invalid_request/)
 const calls:any[]=[]
 t.mock.method(globalThis,'fetch',async(_input:string|URL,init?:RequestInit)=>{calls.push(JSON.parse(String(init?.body)));return Response.json({ok:true})})
 const services=supabaseAdminServices(env)
 for(const provider of ['deepseek','openai']){
  const {timezone:omitted,...withoutTimezone}=statement
  const checked=validateMutation({...operation,target:provider,data:withoutTimezone})
  const args={p_actor:USER,p_operation:checked.operationId,p_action:checked.action,p_target:provider,p_reason:checked.reason,p_data:checked.data}
  await services.rpc('admin_mutate',args)
  assert.equal(calls.at(-1).p_data.timezone,provider==='openai'?'UTC':'Asia/Shanghai')
  await assert.rejects(services.rpc('admin_mutate',{...args,p_data:{...withoutTimezone,timezone:provider==='openai'?'Asia/Shanghai':'UTC'}}),/invalid_request/)
 }
 assert.equal(calls.length,2)
})
