import {test} from 'node:test'
import assert from 'node:assert/strict'
import {billingRange,billingSyncStatus,syncOfficialCosts,syncDeepSeekBalance,syncBillingSnapshots,usdUnits,unitsUsd,type BillingSyncEnv} from '../server/worker/src/billingSync.ts'
import {usd} from '../website/src/admin/money.ts'
import {handleAdmin,supabaseAdminServices,type AdminServices} from '../server/worker/src/admin.ts'
const env:BillingSyncEnv={SUPABASE_URL:'https://billing-db.invalid',SUPABASE_SECRET_KEY:'test-service-only',OPENAI_BILLING_ADMIN_KEY:'test-admin-only',OPENAI_BILLING_PROJECT_ID:'proj_test',OPENAI_BILLING_API_KEY_IDS:'key_second,key_test',DEEPSEEK_API_KEY:'test-deepseek-only'}
const start=Date.parse('2026-09-14T00:00:00Z')/1000,now=Date.parse('2026-09-16T00:00:00Z')
const range={from:'2026-09-14',to:'2026-09-15'}
const bucket=(day:number,values:Array<string|number>=[])=>({object:'bucket',start_time:start+day*86400,end_time:start+(day+1)*86400,results:values.map(value=>({object:'organization.costs.result',project_id:'proj_test',api_key_id:'key_test',line_item:'inference',amount:{currency:'usd',value}}))})
const page=(data:unknown[],has_more=false,next_page:string|null=null)=>({object:'page',data,has_more,next_page})
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
type Call={url:URL;init:RequestInit|undefined}

test('billing scope cannot use an inference secret as an API key ID; absent admin credentials make no external calls',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('must not call')})
 assert.equal(billingSyncStatus({...env,OPENAI_BILLING_ADMIN_KEY:''}).configured,false)
 assert.equal(billingSyncStatus({...env,OPENAI_BILLING_API_KEY_IDS:'sk-proj-test'}).configured,false)
 await assert.rejects(syncOfficialCosts({...env,OPENAI_BILLING_ADMIN_KEY:''},range,now),/billing_not_configured/)
 assert.equal(calls,0);assert.ok(!JSON.stringify(billingSyncStatus(env)).includes('test-admin-only'))
})
test('official Costs are scoped, paginated and summed as exact decimals including negative adjustments',async t=>{
 const calls:Call[]=[],stored:any[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=new URL(String(input));calls.push({url,init})
  if(url.hostname==='billing-db.invalid'){stored.push(JSON.parse(String(init?.body)));return json({})}
  assert.equal(url.origin+url.pathname,'https://api.openai.com/v1/organization/costs')
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-admin-only');assert.equal(init?.redirect,'manual')
  assert.deepEqual(url.searchParams.getAll('project_ids[]'),['proj_test']);assert.deepEqual(url.searchParams.getAll('api_key_ids[]'),['key_second','key_test'])
  assert.deepEqual(url.searchParams.getAll('group_by[]'),['project_id','api_key_id','line_item'])
  if(!url.searchParams.has('page'))return json(page([bucket(0,[0.1,-0.03])],true,'cursor1'))
  return json(page([bucket(1,[0.2,'0.000000000001'])]))
 })
 const result=await syncOfficialCosts(env,range,now)
 assert.equal(result.officialUsd,'0.270000000001');assert.equal(result.provisional,true);assert.equal(calls.length,3)
 assert.equal(stored[0].p_usd,'0.270000000001');assert.deepEqual(stored[0].p_scope,{projectId:'proj_test',apiKeyIds:['key_second','key_test']})
 assert.ok(!JSON.stringify(stored).includes('test-admin-only'));assert.ok(!JSON.stringify(result).includes('test-admin-only'))
})
test('numeric JSON amounts retain precision beyond JavaScript Number',async t=>{
 let stored:any
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  if(String(input).startsWith(env.SUPABASE_URL)){stored=JSON.parse(String(init?.body));return json({})}
  const body=JSON.stringify(page([bucket(0,['precision-placeholder']),bucket(1)]))
  return new Response(body.replace('"precision-placeholder"','123456789.123456789012'))
 })
 await syncOfficialCosts(env,range,now);assert.equal(stored.p_usd,'123456789.123456789012')
})
test('lost snapshot storage reply repeats the identical UUID and body without repeating inference or Costs retrieval',async t=>{
 let api=0;const bodies:string[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  if(!String(input).startsWith(env.SUPABASE_URL)){api++;return json(page([bucket(0),bucket(1)]))}
  bodies.push(String(init?.body));if(bodies.length===1)throw Error('reply lost');return json({})
 })
 const result=await syncOfficialCosts(env,range,now);assert.equal(result.officialUsd,'0.000000000000');assert.equal(api,1);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1])
})
for(const [name,body] of [
 ['missing day',page([bucket(0)])],
 ['duplicate day',page([bucket(0),bucket(0),bucket(1)])],
 ['wrong project',page([{...bucket(0,[1]),results:[{...bucket(0,[1]).results[0],project_id:'proj_unrelated'}]},bucket(1)])],
 ['wrong key',page([{...bucket(0,[1]),results:[{...bucket(0,[1]).results[0],api_key_id:'key_unrelated'}]},bucket(1)])],
 ['wrong currency',page([{...bucket(0,[1]),results:[{...bucket(0,[1]).results[0],amount:{value:1,currency:'cny'}}]},bucket(1)])],
 ['unrepresentable precision',page([bucket(0,['0.0000000000001']),bucket(1)])],
 ['missing pagination cursor',page([bucket(0)],true,null)],
] as const)test(`incomplete official bill (${name}) never overwrites the last snapshot`,async t=>{
 let writes=0;t.mock.method(globalThis,'fetch',async(input:string|URL)=>{if(String(input).startsWith(env.SUPABASE_URL))writes++;return json(body)})
 await assert.rejects(syncOfficialCosts(env,range,now),/billing_data_incomplete/);assert.equal(writes,0)
})
test('permission failure is sanitized and leaves existing snapshots untouched',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('secret upstream details test-admin-only',{status:403})})
 await assert.rejects(syncOfficialCosts(env,range,now),e=>e instanceof Error&&e.message==='billing_permission');assert.equal(calls,1)
})
test('DeepSeek balances preserve currencies and negative amounts without deriving spending from a balance delta',async t=>{
 let stored:any;t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  if(String(input).startsWith(env.SUPABASE_URL)){stored=JSON.parse(String(init?.body));return json({})}
  assert.equal(String(input),'https://api.deepseek.com/user/balance');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-deepseek-only');assert.equal(init?.redirect,'manual')
  return json({is_available:false,balance_infos:[{currency:'USD',total_balance:'-0.000000000001',granted_balance:'0',topped_up_balance:'-0.000000000001'},{currency:'CNY',total_balance:'10.10',granted_balance:'1',topped_up_balance:'9.1'}]})
 })
 const result=await syncDeepSeekBalance(env);assert.equal(stored.p_balances[0].total,'-0.000000000001');assert.equal(stored.p_balances[1].total,'10.10')
 assert.equal('cost' in result,false);assert.equal('officialUsd' in result,false)
})

for(const operation of ['openai','deepseek','admin'] as const)test(`${operation} billing rejects redirects without following credentials or writing snapshots`,async t=>{
 const calls:Call[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  calls.push({url:new URL(String(input)),init})
  assert.equal(init?.redirect,'manual')
  return new Response(null,{status:302,headers:{Location:'https://unrelated.invalid/collect'}})
 })
 const services=supabaseAdminServices({...env,SUPABASE_PUBLISHABLE_KEY:'test-public'})
 await assert.rejects(operation==='openai'?syncOfficialCosts(env,range,now):operation==='deepseek'?syncDeepSeekBalance(env):services.providerBalance!(),/unavailable/)
 assert.equal(calls.length,1)
 assert.equal(calls[0].url.hostname,operation==='openai'?'api.openai.com':'api.deepseek.com')
})

test('DeepSeek billing trims configured credentials consistently with translation and skips blank credentials',async t=>{
 let providerCalls=0
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  if(String(input).startsWith(env.SUPABASE_URL))return json({})
  providerCalls++;assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-deepseek-only')
  return json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1',granted_balance:'0',topped_up_balance:'1'}]})
 })
 const padded={...env,DEEPSEEK_API_KEY:' \r\ntest-deepseek-only \r\n'}
 await syncDeepSeekBalance(padded)
 await supabaseAdminServices({...padded,SUPABASE_PUBLISHABLE_KEY:'test-public'}).providerBalance!()
 assert.equal(providerCalls,2)
 assert.deepEqual(await syncDeepSeekBalance({...env,DEEPSEEK_API_KEY:' \r\n'}),{skipped:true,reason:'not_configured'})
 await assert.rejects(supabaseAdminServices({...env,DEEPSEEK_API_KEY:' \r\n',SUPABASE_PUBLISHABLE_KEY:'test-public'}).providerBalance!(),/unavailable/)
 assert.equal(providerCalls,2)
})
test('a failed OpenAI sync cannot prevent DeepSeek balance synchronization or call translation/character RPCs',async t=>{
 const calls:string[]=[];t.mock.method(globalThis,'fetch',async(input:string|URL)=>{
  const url=String(input);calls.push(url)
  if(url.startsWith('https://api.openai.com'))return json({},403)
  if(url==='https://api.deepseek.com/user/balance')return json({is_available:true,balance_infos:[{currency:'USD',total_balance:'3',granted_balance:'1',topped_up_balance:'2'}]})
  assert.equal(url,env.SUPABASE_URL+'/rest/v1/rpc/record_provider_balance');return json({})
 })
 const result=await syncBillingSnapshots(env,now);assert.deepEqual(result.openai,{error:'billing_permission'});assert.ok('provider' in result.deepseek);assert.equal(result.deepseek.provider,'deepseek');assert.equal(calls.length,3)
})
test('DeepSeek still synchronizes before OpenAI admin key configuration',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async(input:string|URL)=>{calls++;assert.ok(!String(input).includes('openai.com'));return String(input).startsWith(env.SUPABASE_URL)?json({}):json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1',granted_balance:'0',topped_up_balance:'1'}]})})
 const result=await syncBillingSnapshots({...env,OPENAI_BILLING_ADMIN_KEY:''},now);assert.ok('skipped' in result.openai);assert.equal(result.openai.skipped,true);assert.ok('provider' in result.deepseek);assert.equal(result.deepseek.provider,'deepseek');assert.equal(calls,2)
})
test('billing date validation and USD display retain original precision and explicit unknowns',()=>{
 assert.throws(()=>billingRange({from:'2026-02-30',to:'2026-03-01'},now),/invalid_request/)
 assert.throws(()=>billingRange({...range,userId:'unrelated'},now),/invalid_request/)
 assert.throws(()=>billingRange({from:'2026-01-01',to:'2026-09-01'},now),/invalid_request/)
 assert.equal(unitsUsd(usdUnits('-1.2e-4')),'-0.000120000000');assert.equal(unitsUsd(usdUnits('0.1')+usdUnits('0.2')),'0.300000000000')
 assert.throws(()=>usdUnits('NaN'),/billing_data_incomplete/);assert.throws(()=>unitsUsd(10n**24n),/billing_data_incomplete/)
 assert.equal(usd('123456789.123456789012'),'$123,456,789.123456789012');assert.equal(usd('-0.000000000001'),'-$0.000000000001')
 assert.equal(usd(null),'待核算');assert.equal(usd('0'),'$0.00')
})
test('official billing endpoints require the owner and recent MFA before touching provider services',async()=>{
 let external=0,role='owner',aal:'aal1'|'aal2'='aal2',mfaAt=Date.now()/1000
 const services:AdminServices={origins:['https://admin.hellodog.net'],authenticate:async()=>({id:'10000000-0000-4000-8000-000000000001',aal,enrolled:true,mfaAt,sessionId:'fixture'}),rpc:async()=>({role}),billingStatus:()=>({configured:true}),syncBilling:async()=>{external++;return {officialUsd:'0.00'}}}
 const req=()=>new Request('https://api.hellodog.net/api/admin/billing-sync',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json',Origin:'https://admin.hellodog.net'},body:JSON.stringify(range)})
 role='support';assert.equal((await handleAdmin(req(),services)).status,403);assert.equal(external,0)
 role='owner';aal='aal1';assert.equal((await handleAdmin(req(),services)).status,403);assert.equal(external,0)
 aal='aal2';mfaAt=Date.now()/1000-660;assert.equal((await handleAdmin(req(),services)).status,403);assert.equal(external,0)
 mfaAt=Date.now()/1000;assert.equal((await handleAdmin(req(),services)).status,200);assert.equal(external,1)
})
