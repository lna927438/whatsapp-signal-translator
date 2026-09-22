import {test} from 'node:test'
import assert from 'node:assert/strict'
import {handleAdmin,supabaseAdminServices,type AdminServices} from '../server/worker/src/admin.ts'
import {currentMonthOfficialReportingBasis} from '../server/worker/src/officialBillScopes.ts'

const actor='10000000-0000-4000-8000-000000000001'
const env={TRANSLATION_PROVIDER:'deepseek',TRANSLATION_SELECTABLE_PROVIDERS:'deepseek,openai',DEEPSEEK_API_KEY:'synthetic-deepseek',
 OPENAI_BILLING_ADMIN_KEY:'synthetic-billing',OPENAI_BILLING_PROJECT_ID:'proj_month_test',OPENAI_BILLING_API_KEY_IDS:'key_month_test',
 SUPABASE_URL:'https://native-billing.invalid',SUPABASE_SECRET_KEY:'synthetic-service',SUPABASE_PUBLISHABLE_KEY:'synthetic-public'}
const cases=[
 ['2026-09-22T15:59:59Z','2026-09-01','2026-09-22','2026-09-01','2026-09-22'],
 ['2026-09-22T16:00:00Z','2026-09-01','2026-09-22','2026-09-01','2026-09-23'],
 ['2026-09-30T16:00:00Z','2026-09-01','2026-09-30','2026-10-01','2026-10-01'],
 ['2026-12-31T16:00:00Z','2026-12-01','2026-12-31','2027-01-01','2027-01-01'],
 ['2027-01-01T00:00:00Z','2027-01-01','2027-01-01','2027-01-01','2027-01-01'],
 ['2028-02-29T16:00:00Z','2028-02-01','2028-02-29','2028-03-01','2028-03-01']
] as const

for(const [at,openaiFrom,openaiTo,deepseekFrom,deepseekTo] of cases)test(`overview official months use supplier boundaries at ${at}`,async t=>{
 const expected={kind:'provider_current_month',periods:{openai:{from:openaiFrom,to:openaiTo,timezone:'UTC'},
  deepseek:{from:deepseekFrom,to:deepseekTo,timezone:'Asia/Shanghai'}},timezones:{openai:'UTC',deepseek:'Asia/Shanghai'}}
 assert.deepEqual(currentMonthOfficialReportingBasis(Date.parse(at)),expected)
 // An API call can finish after midnight. Its database snapshot, rather than a
 // later local clock reading, binds both official reporting periods.
 t.mock.timers.enable({apis:['Date'],now:Date.parse(at)+86400000})
 const receiptFilter={from:openaiFrom,to:openaiTo,timezone:'UTC'},filter={...receiptFilter,officialCurrentMonth:'true'}
 const from=openaiFrom+'T00:00:00Z',toExclusive=new Date(Date.parse(openaiTo+'T00:00:00Z')+86400000).toISOString()
 const calls:Array<{name:string;body:any}>=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=new URL(String(input));assert.equal(url.origin,env.SUPABASE_URL)
  assert.equal(init?.redirect,'manual')
  const name=url.pathname.split('/').pop()!,body=JSON.parse(String(init?.body));calls.push({name,body})
  if(name==='admin_read'){
   assert.deepEqual(body,{p_actor:actor,p_kind:'costs',p_filter:receiptFilter})
   return Response.json({from,toExclusive,timezone:'UTC',snapshotAt:at,totals:{known_cost_usd_exact:'0.25'},
    officialBills:[{provider:'openai',official_usd_exact:'999',scope:'obsolete-unscoped-summary'}]})
  }
  assert.equal(name,'read_current_official_bills')
  const provider=body.p_filter.provider as 'openai'|'deepseek'
  assert.deepEqual(body.p_filter,{...expected.periods[provider],provider})
  assert.deepEqual(body.p_scopes.openai,{projectId:'proj_month_test',apiKeyIds:['key_month_test']})
  assert.match(body.p_scopes.deepseek.credentialDigest,/^[a-f0-9]{64}$/)
  return Response.json([{provider,official_usd_exact:provider==='openai'?'0.003493200000':'1.800000000000',currentAccount:true}])
 })
 const result=await supabaseAdminServices(env).rpc('admin_read',{p_actor:actor,p_kind:'costs',p_filter:filter}) as any
 assert.deepEqual(filter,{...receiptFilter,officialCurrentMonth:'true'},'Caller filter is immutable')
 assert.equal(result.from,from);assert.equal(result.toExclusive,toExclusive);assert.equal(result.timezone,'UTC')
 assert.equal(result.snapshotAt,at);assert.equal(result.totals.known_cost_usd_exact,'0.25')
 assert.deepEqual(result.officialBillingBasis,expected)
 assert.deepEqual(calls.map(c=>c.name),['admin_read','read_current_official_bills','read_current_official_bills'])
 assert.equal(result.officialBills.length,2)
 assert.ok(!/obsolete-unscoped-summary|credentialDigest|synthetic-|proj_month_test|key_month_test/.test(JSON.stringify(result)))
})

test('a non-owner current-month receipt report never queries or receives official account scope',async t=>{
 const calls:string[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=new URL(String(input));calls.push(url.pathname)
  assert.equal(url.pathname,'/rest/v1/rpc/admin_read')
  assert.deepEqual(JSON.parse(String(init?.body)).p_filter,{from:'2026-09-01',to:'2026-09-22',timezone:'UTC'})
  return Response.json({totals:{known_cost_usd_exact:'0.25'},snapshotAt:'2026-09-22T18:00:00Z'})
 })
 const value=await supabaseAdminServices(env).rpc('admin_read',{p_actor:actor,p_kind:'costs',p_filter:{from:'2026-09-01',to:'2026-09-22',timezone:'UTC',officialCurrentMonth:'true'}}) as any
 assert.equal(calls.length,1);assert.equal('officialBills' in value,false);assert.equal('officialBillingBasis' in value,false)
 assert.equal('enabledProviders' in value,false);assert.equal(value.totals.known_cost_usd_exact,'0.25')
})

test('the current-month flag is accepted only on unfiltered UTC costs requests',async()=>{
 let reads=0
 const services:AdminServices={origins:[],authenticate:async()=>({id:actor,aal:'aal2',enrolled:true,mfaAt:Date.now()/1000,sessionId:'test-session'}),
  rpc:async(name,args)=>{reads++;assert.equal(name,'admin_read');assert.equal(args.p_kind,'costs');return {ok:true}}}
 const request=(suffix:string)=>new Request('https://api.hellodog.net/api/admin/'+suffix,{headers:{Authorization:'Bearer synthetic'}})
 const invalid=[
  'costs?timezone=UTC&officialCurrentMonth=false',
  'costs?timezone=UTC&officialCurrentMonth=1',
  'costs?timezone=UTC&officialCurrentMonth=',
  'costs?timezone=UTC&officialCurrentMonth=TRUE',
  'costs?officialCurrentMonth=true',
  'costs?timezone=Asia%2FShanghai&officialCurrentMonth=true',
  'costs?timezone=UTC&officialCurrentMonth=true&provider=openai',
  'costs?timezone=UTC&officialCurrentMonth=true&userId='+actor,
  'overview?timezone=UTC&officialCurrentMonth=true',
  'users?timezone=UTC&officialCurrentMonth=true'
 ]
 for(const suffix of invalid){
  const result=await handleAdmin(request(suffix),services)
  assert.equal(result.status,400,suffix);assert.equal((await result.json() as any).error,'invalid_request')
 }
 assert.equal(reads,0)
 const result=await handleAdmin(request('costs?from=2026-09-01&to=2026-09-22&timezone=UTC&officialCurrentMonth=true'),services)
 assert.equal(result.status,200);assert.equal(reads,1)
})
