import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,USER} from './fixture.ts'
import {enabledBillingProviders,billingSyncStatusWithHistory,syncOfficialCostsWithStatus,syncBillingSnapshots} from '../server/worker/src/billingSync.ts'
import {currentOfficialBillScopes} from '../server/worker/src/officialBillScopes.ts'
import {supabaseAdminServices} from '../server/worker/src/admin.ts'
import {balanceRpcResponse} from './deepseek-balance-fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const scope={projectId:'proj_retired',apiKeyIds:['key_retired']}
const env={TRANSLATION_PROVIDER:'deepseek',TRANSLATION_FALLBACK_PROVIDER:'',DEEPSEEK_API_KEY:'test-ds',
 SUPABASE_URL:'https://retired-account.invalid',SUPABASE_SECRET_KEY:'test-server',SUPABASE_PUBLISHABLE_KEY:'test-public',
 OPENAI_BILLING_ADMIN_KEY:'test-old-admin',OPENAI_BILLING_PROJECT_ID:scope.projectId,OPENAI_BILLING_API_KEY_IDS:scope.apiKeyIds[0]}
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await db.exec('delete from translator_private.openai_billing_sync;delete from translator_private.provider_bill_snapshots');await reset(db)})

test('disabled OpenAI never reads status or calls provider APIs even if stale credentials remain in memory',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Retired provider must not be contacted')})
 assert.deepEqual(enabledBillingProviders(env),['deepseek'])
 assert.deepEqual(enabledBillingProviders({...env,TRANSLATION_PROVIDER:undefined}),['openai','deepseek'])
 const status=await billingSyncStatusWithHistory(env)
 assert.equal(status.configured,false);assert.equal(status.reason,'provider_disabled')
 assert.equal(status.sync.status,'unknown');assert.equal(status.sync.lastSuccessAt,null);assert.equal(status.sync.errorCode,null)
 const scopes=await currentOfficialBillScopes(env);assert.equal(scopes.openai,null);assert.ok(scopes.deepseek)
 await assert.rejects(syncOfficialCostsWithStatus(env,{from:'2026-09-14',to:'2026-09-14'}),/billing_not_configured/)
})

test('DS-only scheduled billing still refreshes DS and never calls retired official Costs',async t=>{
 const calls:string[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=String(input);calls.push(url);assert.equal(url.includes('openai'),false)
  if(url.includes('api.deepseek.com'))return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1.00000001',granted_balance:'0',topped_up_balance:'1.00000001'}]})
  const r=balanceRpcResponse(url,String(init?.body));assert.ok(r);return r
 })
 const result=await syncBillingSnapshots(env)
 assert.ok('skipped' in result.openai);assert.ok('sync' in result.deepseek);assert.equal(result.deepseek.sync.status,'fresh')
 assert.ok(calls.some(v=>v.includes('api.deepseek.com')))
})

test('cost cards contain only active-provider official bills, while explicit historical filters retain local costs',async t=>{
 const calls:any[]=[],services=supabaseAdminServices(env)
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,b=JSON.parse(String(init?.body));calls.push({path,body:b})
  if(path.endsWith('/admin_read'))return Response.json({totals:{source_characters:100,cost_usd:0.1},officialBills:[{provider:'openai',official_usd:999}]})
  assert.ok(path.endsWith('/read_current_official_bills'));assert.equal(b.p_scopes.openai,null)
  assert.equal(b.p_filter.provider,'deepseek');return Response.json([{provider:'deepseek',official_usd_exact:'0.190000000000'}])
 })
 const result:any=await services.rpc('admin_read',{p_actor:USER,p_kind:'costs',p_filter:{from:'2026-09-01',to:'2026-09-15'}})
 assert.deepEqual(result.enabledProviders,['deepseek']);assert.deepEqual(result.officialBills.map((v:any)=>v.provider),['deepseek'])
 const historical:any=await services.rpc('admin_read',{p_actor:USER,p_kind:'costs',p_filter:{from:'2026-09-01',to:'2026-09-15',provider:'openai'}})
 assert.deepEqual(historical.officialBills,[]);assert.deepEqual(historical.totals,{source_characters:100,cost_usd:0.1})
 assert.equal(calls.filter(v=>v.path.endsWith('/read_current_official_bills')).length,1)
 await assert.rejects(services.rpc('admin_mutate',{p_actor:USER,p_action:'cost.reconcile',p_target:'openai',p_data:{}}),/billing_not_configured/)
})

test('retiring account identifiers preserves all money, customer ledgers and unrelated DS records and is repeatable',async()=>{
 const at=new Date().toISOString(),id=randomUUID()
 await asRole(db,'service_role','select public.record_official_bill($1,$2,$3,$4,$5,$6)',[id,'2026-09-01T00:00:00Z','2026-09-16T00:00:00Z',scope,'0.048528700000',at])
 await asRole(db,'service_role','select public.record_openai_billing_sync($1,$2,$3,$4,$5)',[scope,randomUUID(),at,at,'billing_account_deactivated'])
 const dsScope={credentialDigest:'a'.repeat(64)}
 await db.query("insert into translator_private.provider_bill_snapshots(id,provider,period_from,period_to,timezone,source,scope,official_usd,reference) values($1,'deepseek',$2,$3,'Asia/Shanghai','manual_statement',$4,0.19,'Synthetic statement')",
  [randomUUID(),'2026-08-31T16:00:00Z','2026-09-15T16:00:00Z',dsScope])
 const snapshot=async()=>({bills:(await db.query<any>("select to_jsonb(b)-'scope' b from translator_private.provider_bill_snapshots b order by id")).rows,
 wallets:(await db.query('select * from public.wallets order by user_id')).rows,ledger:(await db.query('select * from public.character_ledger order by id')).rows})
 const before=await snapshot(),sql=await readFile(new URL('../supabase/migrations/20260916010100_remove_retired_openai_account_scope.sql',import.meta.url),'utf8')
 await db.exec(sql);await db.exec(sql)
 assert.deepEqual(await snapshot(),before)
 assert.equal((await db.query('select * from translator_private.openai_billing_sync')).rows.length,0)
 const bills=(await db.query<any>('select provider,scope from translator_private.provider_bill_snapshots order by provider')).rows
 assert.deepEqual(bills,[{provider:'deepseek',scope:dsScope},{provider:'openai',scope:{retired:true,accountInformationRemoved:true}}])
 assert.equal(JSON.stringify(bills).includes('proj_retired'),false);assert.equal(JSON.stringify(bills).includes('key_retired'),false)
})
