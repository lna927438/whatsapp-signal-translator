import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,asRole,reset,wallet} from './fixture.ts'
import {refreshDeepSeekBalance,parseDeepSeekBalance} from '../server/worker/src/deepseekBalance.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>db.close())
beforeEach(async()=>{await db.exec('delete from translator_private.provider_balance_refresh;delete from translator_private.provider_balance_snapshots');await reset(db)})
const env={DEEPSEEK_API_KEY:'test-only',SUPABASE_URL:'https://balance-db.invalid',SUPABASE_SECRET_KEY:'test-db'}
const scope='a'.repeat(64),otherScope='b'.repeat(64)
const balance={is_available:true,balance_infos:[{currency:'USD',total_balance:'123456789.123456789012',granted_balance:'0.000000000001',topped_up_balance:'123456789.123456789011'},{currency:'CNY',total_balance:'-0.01',granted_balance:'0',topped_up_balance:'-0.01'}]}
async function claim(digest=scope,token=randomUUID()){return {token,data:(await asRole<any>(db,'service_role','select public.claim_deepseek_balance_refresh($1,$2) r',[digest,token])).rows[0].r}}
async function finish(token:string,result:any,error:string|null=null,digest=scope){return (await asRole<any>(db,'service_role','select public.finish_deepseek_balance_refresh($1,$2,$3,$4) r',[digest,token,result,error])).rows[0].r}
const result=()=>({...parseDeepSeekBalance(balance),fetchedAt:new Date().toISOString()})
async function mockRpc(input:string|URL,init?:RequestInit){
 const url=new URL(String(input));if(url.hostname!=='balance-db.invalid')return null
 const args=JSON.parse(String(init?.body)),name=url.pathname.split('/').pop()
 if(name==='claim_deepseek_balance_refresh')return Response.json((await claim(args.p_scope,args.p_token)).data)
 assert.equal(name,'finish_deepseek_balance_refresh')
 return Response.json(await finish(args.p_token,args.p_result,args.p_error,args.p_scope))
}

test('parallel admin/cron refreshes make one provider call and preserve both exact currencies',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const rpc=await mockRpc(input,init);if(rpc)return rpc
  calls++;assert.equal(String(input),'https://api.deepseek.com/user/balance');assert.equal(init?.redirect,'manual')
  await new Promise(resolve=>setTimeout(resolve,20));return Response.json(balance)
 })
 const responses=await Promise.all(Array.from({length:20},()=>refreshDeepSeekBalance(env)))
 assert.equal(calls,1);assert.equal(responses.filter(x=>x.sync.status==='fresh').length,1)
 const fresh=await refreshDeepSeekBalance(env);assert.equal(calls,1)
 assert.equal(fresh.balances[0].total,'123456789.123456789012');assert.equal(fresh.balances[1].total,'-0.01')
 assert.equal(fresh.snapshotAt,fresh.fetchedAt);assert.ok(!JSON.stringify(fresh).includes('scope_digest'));assert.ok(!JSON.stringify(fresh).includes('credentialDigest'))
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,1)
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
})

test('failed refresh keeps the last success and timestamp, exposes error, and remains throttled',async t=>{
 let fail=false,calls=0
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{const rpc=await mockRpc(input,init);if(rpc)return rpc;calls++;return fail?new Response(null,{status:429}):Response.json(balance)})
 const good=await refreshDeepSeekBalance(env);fail=true
 await db.exec("update translator_private.provider_balance_refresh set next_refresh_at=clock_timestamp()-interval '1 second'")
 const failed=await refreshDeepSeekBalance(env)
 assert.equal(failed.sync.status,'error');assert.equal(failed.sync.lastError,'provider_rate_limited');assert.equal(failed.stale,true)
 assert.equal(failed.fetchedAt,good.fetchedAt);assert.deepEqual(failed.balances,good.balances)
 await refreshDeepSeekBalance(env);assert.equal(calls,2)
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,1)
})

test('expired snapshots stay visible but marked stale; a new credential never reuses the previous account',async()=>{
 const first=await claim(),value=result();await finish(first.token,value)
 await db.query("update translator_private.provider_balance_snapshots set fetched_at=clock_timestamp()-interval '121 seconds' where id=$1",[first.token])
 const stale=(await claim()).data;assert.equal(stale.claimed,false);assert.equal(stale.stale,true);assert.equal(stale.sync.status,'stale')
 const changed=await claim(otherScope);assert.equal(changed.data.claimed,true);assert.equal(changed.data.available,null);assert.deepEqual(changed.data.balances,[]);assert.equal(changed.data.fetchedAt,null)
 assert.deepEqual(await finish(first.token,value,null,scope),{ignored:true})
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,1)
})

test('a crashed lease expires; a stale completion cannot overwrite its replacement and exact completion replay is idempotent',async()=>{
 const first=await claim()
 await db.exec("update translator_private.provider_balance_refresh set lease_until=clock_timestamp()-interval '1 second',next_refresh_at=clock_timestamp()-interval '1 second'")
 const second=await claim();assert.equal(second.data.claimed,true);assert.equal(second.data.sync.lastError,'timeout')
 assert.equal((await finish(first.token,result())).ignored,true)
 const value=result();await finish(second.token,value);await finish(second.token,value)
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,1)
 await assert.rejects(finish(second.token,{...value,available:false}),/operation_conflict/)
 const row=(await db.query<any>('select * from translator_private.provider_balance_refresh')).rows[0]
 assert.equal(row.lease_token,null);assert.equal(row.last_error,null)
})

test('a lost storage response retries the identical outcome without querying DeepSeek twice',async t=>{
 let providerCalls=0,finishCalls=0;const bodies:string[]=[]
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  const rpc=await mockRpc(input,init)
  if(rpc){if(String(input).endsWith('/finish_deepseek_balance_refresh')){bodies.push(String(init?.body));if(++finishCalls===1)throw Error('lost reply')}return rpc}
  providerCalls++;return Response.json(balance)
 })
 const state=await refreshDeepSeekBalance(env);assert.equal(state.sync.status,'fresh');assert.equal(providerCalls,1);assert.equal(finishCalls,2);assert.equal(bodies[0],bodies[1])
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,1)
})

test('missing or malformed money is never a numeric zero; invalid provider responses cannot replace history',async t=>{
 for(const altered of [{...balance,balance_infos:[{...balance.balance_infos[0],total_balance:1}]},{...balance,balance_infos:[balance.balance_infos[0],balance.balance_infos[0]]},{...balance,balance_infos:[]}])assert.throws(()=>parseDeepSeekBalance(altered),/provider_invalid_response/)
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>await mockRpc(input,init)||Response.json({...balance,balance_infos:[{...balance.balance_infos[0],total_balance:'1.0000000000001'}]}))
 const state=await refreshDeepSeekBalance(env);assert.equal(state.available,null);assert.deepEqual(state.balances,[]);assert.equal(state.sync.lastError,'provider_invalid_response');assert.equal(state.fetchedAt,null)
 const empty=await refreshDeepSeekBalance({...env,DEEPSEEK_API_KEY:''});assert.equal(empty.sync.status,'not_configured');assert.equal(empty.available,null)
})

test('official balance components must reconcile exactly, including fractions below floating-point precision',async()=>{
 const inconsistent={...balance,balance_infos:[{...balance.balance_infos[0],total_balance:'123456789.123456789013'}]}
 assert.throws(()=>parseDeepSeekBalance(inconsistent),/provider_invalid_response/)
 assert.equal(parseDeepSeekBalance(balance).balances[0].total,'123456789.123456789012')
 const current=await claim(),bad=result();bad.balances[0].total='123456789.123456789013'
 await assert.rejects(finish(current.token,bad),/invalid_request/)
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,0)
})

test('balance state and refresh RPCs are service-only; numeric JSON and forged outcome tokens are rejected',async()=>{
 const first=await claim()
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select public.claim_deepseek_balance_refresh($1,$2)',[scope,randomUUID()]),/permission denied/)
  await assert.rejects(asRole(db,role,'select public.finish_deepseek_balance_refresh($1,$2,$3,$4)',[scope,first.token,result(),null]),/permission denied/)
  await assert.rejects(asRole(db,role,'select * from translator_private.provider_balance_refresh'),/permission denied/)
 }
 const bad=result();(bad.balances[0] as any).total=0
 await assert.rejects(finish(first.token,bad),/invalid_request/)
 assert.equal((await finish(randomUUID(),result())).ignored,true)
 assert.equal((await db.query('select * from translator_private.provider_balance_snapshots')).rows.length,0)
})
