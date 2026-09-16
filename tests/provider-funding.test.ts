import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,USER,OTHER,wallet} from './fixture.ts'
import {validateMutation,supabaseAdminServices} from '../server/worker/src/admin.ts'
import {deepSeekCredentialDigest,refreshDeepSeekBalance} from '../server/worker/src/deepseekBalance.ts'
let db:Awaited<ReturnType<typeof database>>
const scope='a'.repeat(64),secondScope='b'.repeat(64)
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{
 await db.exec('delete from translator_private.provider_funding_state;delete from translator_private.provider_funding_confirmations;delete from translator_private.provider_balance_refresh;delete from translator_private.provider_balance_snapshots;delete from public.admin_audit')
 await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])
})
async function state(digest=scope){return (await asRole<any>(db,'service_role','select translator_private.deepseek_balance_status($1) r',[digest])).rows[0].r}
async function observe(paid='19.70',granted='0.00',digest=scope,error:string|null=null){
 await db.exec("update translator_private.provider_balance_refresh set next_refresh_at=clock_timestamp()-interval '1 second'")
 const token=randomUUID();await asRole(db,'service_role','select public.claim_deepseek_balance_refresh($1,$2)',[digest,token])
 const n=(s:string)=>{const[a,b='']=s.split('.');return BigInt(a+b.padEnd(12,'0'))},sum=n(paid)+n(granted),total=(sum/1000000000000n)+'.'+(sum%1000000000000n).toString().padStart(12,'0')
 const data={available:true,balances:[{currency:'USD',paid,granted,total}],fetchedAt:new Date().toISOString()}
 return (await asRole<any>(db,'service_role','select public.finish_deepseek_balance_refresh($1,$2,$3,$4) r',[digest,token,error?null:data,error])).rows[0].r
}
async function form(topups='20',refunds='0',digest=scope){return {currency:'USD',cumulativeTopUps:topups,cumulativeCashRefunds:refunds,balanceFetchedAt:(await state(digest)).fetchedAt,reference:'owner confirmed funding record'}}
async function confirm(data:any,op=randomUUID(),digest=scope,actor=USER){return (await asRole<any>(db,'service_role','select public.confirm_deepseek_funding($1,$2,$3,$4,$5) r',[actor,op,'Confirmed actual provider funds',data,digest])).rows[0].r}

test('confirmed 20 minus official paid 19.70 is precisely 0.30 and never rewrites bills or customer money',async()=>{
 const first=await observe();assert.equal(first.funding.status,'unconfigured');assert.equal(first.funding.usedPaid,null)
 const beforeWallet=await wallet(db),bills=(await db.query('select count(*) n from translator_private.provider_bill_snapshots')).rows
 const result=await confirm(await form());assert.equal(result.funding.status,'ready');assert.equal(result.funding.usedPaid,'0.300000000000')
 assert.equal(result.funding.scope,'current_account_lifetime');assert.equal(result.funding.paidBalance,'19.70')
 assert.equal(result.funding.balanceFetchedAt,(await state()).fetchedAt)
 assert.deepEqual(await wallet(db),beforeWallet);assert.deepEqual((await db.query('select count(*) n from translator_private.provider_bill_snapshots')).rows,bills)
 assert.equal((await db.query<any>('select count(*)::int n from public.character_ledger')).rows[0].n,0)
 const audit=(await db.query<any>('select input,result from public.admin_audit')).rows[0]
 assert.equal(audit.input.accountScopeBound,true);assert.ok(!JSON.stringify(audit).includes(scope))
})

test('subsequent official balance sampling recalculates exact paid spending and excludes grants and grant expiry',async()=>{
 await observe();await confirm(await form())
 let current=await observe('19.60','5.00');assert.equal(current.funding.usedPaid,'0.400000000000');assert.equal(current.funding.grantedBalance,'5.00')
 current=await observe('19.60','0.00');assert.equal(current.funding.usedPaid,'0.400000000000');assert.equal(current.funding.status,'ready')
 current=await observe('19.599999999999');assert.equal(current.funding.usedPaid,'0.400000000001')
})

test('paid increase requires confirmation, survives later consumption, then an actual top-up preserves spending',async()=>{
 await observe();await confirm(await form())
 await assert.rejects(confirm(await form('40')),/funding_movement_not_observed/)
 let current=await observe('39.70');assert.equal(current.funding.status,'needs_confirmation');assert.equal(current.funding.usedPaid,null)
 current=await observe('19.69');assert.equal(current.funding.status,'needs_confirmation')
 await observe('39.60');const recorded=await confirm(await form('40'));assert.equal(recorded.funding.usedPaid,'0.400000000000')
 assert.equal((await state()).funding.status,'ready')
 assert.equal((await db.query<any>('select count(*)::int n from translator_private.provider_funding_confirmations')).rows[0].n,2)
})

test('cash returned to the payer is subtracted separately; provider wallet refunds need confirmation and reduce net usage',async()=>{
 await observe();await confirm(await form())
 await observe('14.70');const returned=await confirm(await form('20','5'));assert.equal(returned.funding.usedPaid,'0.300000000000');assert.equal(returned.funding.netPaidFunding,'15.000000000000')
 let current=await observe('14.80');assert.equal(current.funding.status,'needs_confirmation')
 current=await confirm(await form('20','5'));assert.equal(current.funding.usedPaid,'0.200000000000')
 await assert.rejects(confirm(await form('19.99','5')),/funding_totals_decreased/)
 await assert.rejects(confirm(await form('20','4')),/funding_totals_decreased/)
})

test('failed or expired balance sampling retains old money as stale and cannot confirm new funding',async()=>{
 await observe();await confirm(await form())
 const old=(await state()).funding
 const failed=await observe('0','0',scope,'provider_unavailable')
 assert.equal(failed.funding.status,'stale');assert.equal(failed.funding.usedPaid,old.usedPaid);assert.equal(failed.funding.balanceFetchedAt,old.balanceFetchedAt)
 await assert.rejects(confirm(await form()),/stale_provider_balance/)
 await observe();await db.exec("update translator_private.provider_balance_snapshots set fetched_at=clock_timestamp()-interval '121 seconds'")
 assert.notEqual((await state()).funding.status,'ready')
})

test('duplicate confirmation is exact and idempotent, including concurrent submissions and account mismatch replay',async()=>{
 await observe();const data=await form(),id=randomUUID()
 const results=await Promise.all(Array.from({length:10},()=>confirm(data,id)))
 assert.equal(results.filter(x=>x.replayed===true).length,9)
 assert.equal((await db.query<any>('select count(*)::int n from public.admin_audit')).rows[0].n,1)
 await assert.rejects(confirm({...data,cumulativeTopUps:'21'},id),/operation_conflict/)
 await assert.rejects(confirm(data,id,secondScope),/operation_conflict/)
})

test('another credential scope has no funding basis and no old money attribution',async()=>{
 await observe();await confirm(await form());const current=await observe('100', '0',secondScope)
 assert.equal(current.funding.status,'unconfigured');assert.equal(current.funding.cumulativeTopUps,null);assert.equal(current.funding.usedPaid,null)
 assert.equal(current.funding.paidBalance,'100');assert.ok(!JSON.stringify(current).includes(scope))
})

test('stale captured snapshot, forged currency, numeric JSON, negative totals and impossible funding are rejected',async()=>{
 await observe();const data=await form()
 await assert.rejects(confirm({...data,balanceFetchedAt:'2026-01-01T00:00:00Z'}),/stale_provider_balance/)
 for(const bad of [{...data,currency:'CNY'},{...data,cumulativeTopUps:20},{...data,cumulativeCashRefunds:'-1'},{...data,cumulativeTopUps:'19'},{...data,scope:secondScope}])await assert.rejects(confirm(bad),/invalid_request|funding_balance_inconsistent/)
})

test('owner access only; browser roles cannot call the service RPC or private tables',async()=>{
 await observe();const data=await form()
 await db.query("insert into public.admin_roles(user_id,role) values($1,'finance')",[OTHER])
 await assert.rejects(confirm(data,randomUUID(),scope,OTHER),/admin_forbidden/)
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select public.confirm_deepseek_funding($1,$2,$3,$4,$5)',[USER,randomUUID(),'test record',data,scope]),/permission denied/)
  await assert.rejects(asRole(db,role,'select * from translator_private.provider_funding_confirmations'),/permission denied/)
 }
})

test('Worker form forbids scope injection and binds the current server credential without exposing it',async t=>{
 const data={currency:'USD',cumulativeTopUps:'20',cumulativeCashRefunds:'0',balanceFetchedAt:new Date().toISOString(),reference:'confirmed provider funding'}
 const body={operationId:randomUUID(),action:'provider.funding.confirm',target:'deepseek',reason:'owner confirmation',data}
 assert.equal(validateMutation(body).action,body.action)
 assert.throws(()=>validateMutation({...body,data:{...data,scope}}),/invalid_request/)
 assert.throws(()=>validateMutation({...body,data:{...data,cumulativeTopUps:20}}),/invalid_request/)
 let calls=0;const key='local-test-provider-secret'
 t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=>{
  calls++;assert.equal(String(input),'https://db.invalid/rest/v1/rpc/confirm_deepseek_funding');const args=JSON.parse(String(init?.body))
  assert.equal(args.p_scope,await deepSeekCredentialDigest(key));assert.equal(args.p_actor,USER);assert.deepEqual(args.p_data,data)
  return Response.json({provider:'deepseek',funding:{status:'ready'}})
 })
 const service=supabaseAdminServices({SUPABASE_URL:'https://db.invalid',SUPABASE_SECRET_KEY:'local-db',SUPABASE_PUBLISHABLE_KEY:'public',DEEPSEEK_API_KEY:key,TRANSLATION_PROVIDER:'deepseek'})
 const result=await service.rpc('admin_mutate',{p_actor:USER,p_operation:body.operationId,p_action:body.action,p_target:body.target,p_reason:body.reason,p_data:data})
 const digest=await deepSeekCredentialDigest(key);assert.ok(digest)
 assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(key));assert.ok(!JSON.stringify(result).includes(digest))
})

test('disabled provider returns an unconfigured funding state, never old spending',async()=>{
 const result=await refreshDeepSeekBalance({DEEPSEEK_API_KEY:'',SUPABASE_URL:'https://unused.invalid',SUPABASE_SECRET_KEY:'unused'})
 assert.equal(result.funding?.status,'unconfigured');assert.equal(result.funding?.usedPaid,null);assert.equal(result.funding?.cumulativeTopUps,null)
})
