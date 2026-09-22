import {test} from 'node:test'
import assert from 'node:assert/strict'
import worker from '../server/worker/src/index.ts'
import type {Env} from '../server/worker/src/index.ts'
const env={DEEPSEEK_API_KEY:'test-deepseek',OPENAI_BILLING_ADMIN_KEY:'test-admin',OPENAI_BILLING_PROJECT_ID:'proj_test',OPENAI_BILLING_API_KEY_IDS:'key_test',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'test-service'} as Env
const status=(value='fresh')=>({provider:'deepseek',available:true,balances:[{currency:'USD',total:'3.00',granted:'1.00',paid:'2.00'}],fetchedAt:new Date().toISOString(),stale:false,sync:{status:value}})
for(const cron of ['*/5 * * * *','17 * * * *'])test(`scheduled billing dispatch isolates ${cron}`,async t=>{
 const calls:string[]=[],logs:unknown[]=[]
 t.mock.method(console,'info',(value:string)=>logs.push(JSON.parse(value)))
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=new URL(String(input));calls.push(url.hostname+url.pathname)
  if(url.pathname.endsWith('/claim_deepseek_balance_refresh'))return Response.json({...status(),claimed:true})
  if(url.hostname==='api.deepseek.com')return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'3.00',granted_balance:'1.00',topped_up_balance:'2.00'}]})
  if(url.pathname.endsWith('/finish_deepseek_balance_refresh'))return Response.json(status())
  if(url.hostname==='api.openai.com'){
   const start=Number(url.searchParams.get('start_time')),end=Number(url.searchParams.get('end_time'))
   return Response.json({object:'page',has_more:false,data:Array.from({length:(end-start)/86400},(_,i)=>({object:'bucket',start_time:start+i*86400,end_time:start+(i+1)*86400,results:[]}))})
  }
  assert.ok(['/rest/v1/rpc/record_official_bill','/rest/v1/rpc/record_openai_billing_sync','/rest/v1/rpc/security_housekeeping'].includes(url.pathname),'No character or translation mutations')
  return Response.json({})
 })
 await worker.scheduled({cron} as any,env)
 assert.equal(calls.some(path=>path.startsWith('api.openai.com')),true)
 assert.equal(calls.some(path=>path.startsWith('api.deepseek.com')),cron!=='17 * * * *')
 assert.equal(calls.some(path=>path.endsWith('/security_housekeeping')),cron==='17 * * * *')
 assert.equal(calls.filter(path=>path.endsWith('/record_openai_billing_sync')).length,cron==='*/5 * * * *'?1:0)
 assert.equal(logs.length,cron==='17 * * * *'?2:1);assert.ok(!JSON.stringify(logs).includes('3.00'),'Logs contain no balance amounts')
})

for(const failed of ['maintenance','billing'] as const)test(`hourly ${failed} failure cannot block its independent peer`,async t=>{
 const calls:string[]=[],logs:any[]=[]
 t.mock.method(console,'info',(value:string)=>logs.push(JSON.parse(value)))
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const url=new URL(String(input));calls.push(url.pathname)
  if(url.pathname.endsWith('/security_housekeeping')){
   if(failed==='maintenance')throw Error('private maintenance failure test-service')
   return Response.json({expired:0})
  }
  if(url.hostname==='api.openai.com'){
   if(failed==='billing')return Response.json({error:{code:'account_deactivated',message:'private billing failure test-admin'}},{status:401})
   const start=Number(url.searchParams.get('start_time')),end=Number(url.searchParams.get('end_time'))
   return Response.json({object:'page',has_more:false,data:Array.from({length:(end-start)/86400},(_,i)=>({object:'bucket',start_time:start+i*86400,end_time:start+(i+1)*86400,results:[]}))})
  }
  assert.equal(url.pathname,'/rest/v1/rpc/record_official_bill');return Response.json({})
 })
 await worker.scheduled({cron:'17 * * * *'} as any,env)
 assert.ok(calls.includes('/rest/v1/rpc/security_housekeeping'));assert.ok(calls.includes('/v1/organization/costs'))
 assert.equal(calls.includes('/rest/v1/rpc/record_official_bill'),failed==='maintenance')
 const maintenance=logs.find(x=>x.event==='security_housekeeping'),billing=logs.find(x=>x.event==='billing_backfill')
 assert.equal(billing.ok,failed==='maintenance');assert.equal(billing.errorCode,failed==='billing'?'billing_account_deactivated':null)
 if(failed==='maintenance')assert.equal(maintenance.errorCode,'maintenance_unavailable')
 assert.ok(!/test-service|test-admin|private .* failure/.test(JSON.stringify(logs)))
})
test('billing cron reports failed balance refresh instead of a cached balance as successful',async t=>{
 const logs:any[]=[];t.mock.method(console,'info',(value:string)=>logs.push(JSON.parse(value)))
 t.mock.method(globalThis,'fetch',async()=>Response.json({...status('error'),claimed:false}))
 await worker.scheduled({cron:'*/5 * * * *'} as any,{...env,OPENAI_BILLING_ADMIN_KEY:undefined})
 assert.equal(logs[0].providers.find((row:any)=>row.provider==='deepseek').ok,false)
})

test('retired or unknown cron events cannot invoke billing or security maintenance',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Unexpected cron must not call external services')})
 for(const cron of ['* * * * *','unexpected'])await worker.scheduled({cron} as any,env)
})
