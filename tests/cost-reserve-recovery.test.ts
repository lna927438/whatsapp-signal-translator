import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {database,reset,rpc,USER,OTHER,wallet,asRole} from './fixture.ts'
let db:Awaited<ReturnType<typeof database>>
const metadata={metering_version:'1',provider:'deepseek',requested_model:'deepseek-flash',security_input_token_bound:5000,security_output_token_bound:1024}
const start=(id:string,user=USER,meta=metadata)=>rpc(db,'begin_translation',{p_user_id:user,p_request_id:id,p_payload_hash:'a'.repeat(64),p_characters:1,p_claim_token:randomUUID(),p_metadata:meta})
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await reset(db);await db.exec('update translator_private.security_policy set user_daily_usd=5,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60,enabled=true')})

test('model-specific reservations remain positive and use the full uncached peak bound',async()=>{
 for(const [model,provider,expected] of [['deepseek-flash','deepseek',0.0027288],['deepseek-v4-pro','deepseek',0.01065504],['unknown','deepseek',0.09096],['deepseek-flash','openai',0.09096]]){
  const value=await db.query<{cost:string}>('select translator_private.translation_cost_bound($1,1,10,40,now()) cost',[{...metadata,requested_model:model,provider}]);
  assert.equal(Number(value.rows[0].cost),expected)
 }
 for(const role of ['anon','authenticated'] as const)await assert.rejects(asRole(db,role,'select translator_private.translation_cost_bound($1,1,10,40,now())',[metadata]),/permission denied/)
})

test('a series of unknown results retains cost protection without charging characters or trapping new messages',async()=>{
 await db.exec('update translator_private.security_policy set user_requests_per_minute=120')
 for(let i=0;i<60;i++){
  const id='outage-'+i;await start(id);await db.query("update translator_private.translation_requests set expires_at=now()-interval '1 minute' where request_id=$1",[id]);
  assert.equal((await rpc(db,'translation_status',{p_user_id:USER,p_request_id:id}) as any).state,'failed')
 }
 assert.equal((await wallet(db)).balance,100);assert.equal((await wallet(db)).lifetime_debited,0)
 assert.equal((await start('after-outage') as any).state,'claimed')
 const value=await db.query<{cost:string}>('select sum(maximum_usd) cost from translator_private.cost_reservations');assert.ok(Number(value.rows[0].cost)>0.16);assert.ok(Number(value.rows[0].cost)<0.17)
})

test('backfill corrects only eligible estimates and never changes provider evidence or wallets',async()=>{
 await start('old');await start('unknown',OTHER,{...metadata,requested_model:'future-model'})
 await db.exec("update translator_private.cost_reservations set maximum_usd=1 where request_id='old'")
 const before=await wallet(db),usage=(await db.query('select * from translator_private.provider_usage order by request_id')).rows
 const migration=await readFile(new URL('../supabase/migrations/20260915114000_provider_cost_reserve_bounds.sql',import.meta.url),'utf8')
 await db.transaction(tx=>tx.exec(migration.replace('create function translator_private.translation_cost_bound','create or replace function translator_private.translation_cost_bound')))
 assert.deepEqual(await wallet(db),before);assert.deepEqual((await db.query('select * from translator_private.provider_usage order by request_id')).rows,usage)
 const costs=(await db.query<{request_id:string;maximum_usd:string}>('select request_id,maximum_usd from translator_private.cost_reservations order by request_id')).rows
 assert.equal(Number(costs.find(x=>x.request_id==='old')!.maximum_usd),0.0027288);assert.equal(Number(costs.find(x=>x.request_id==='unknown')!.maximum_usd),0.09096)
})

test('per-user and global caps still reject new reservations atomically',async()=>{
 await db.exec('update translator_private.security_policy set user_daily_usd=0.004,global_daily_usd=0.004')
 const results=await Promise.allSettled([start('one'),start('two'),start('three',OTHER)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 for(const r of results)if(r.status==='rejected')assert.match(r.reason.message,/cost_limit/)
 assert.equal((await db.query<{n:number}>('select count(*)::int n from translator_private.cost_reservations')).rows[0].n,1)
})
