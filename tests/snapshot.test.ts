import { before,beforeEach,after,test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database,reset,rpc,wallet,asRole,USER,OTHER } from './fixture.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()})
beforeEach(async()=>{await reset(db)})
after(async()=>{await db?.close()})
const args=(id:string)=>({p_user_id:USER,p_request_id:id,p_payload_hash:'b'.repeat(64),p_characters:5,p_claim_token:randomUUID(),p_metadata:{}})
test('status queries release an expired reservation once and never debit or reclaim it',async()=>{
 const a=args('expired-query');await rpc(db,'begin_translation',a)
 assert.equal((await rpc(db,'translation_status',{p_user_id:USER,p_request_id:a.p_request_id})).state,'processing')
 await db.exec("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second'")
 for(let i=0;i<3;i++)assert.equal((await rpc(db,'translation_status',{p_user_id:USER,p_request_id:a.p_request_id})).state,'failed')
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0})
 assert.equal((await db.query('select * from public.character_ledger')).rows.length,0)
})
test('snapshot contains matching wallet, usage, debit and original receipt after repeated settlements',async()=>{
 const a=args('once-only');await rpc(db,'begin_translation',a)
 const completion={p_user_id:USER,p_request_id:a.p_request_id,p_claim_token:a.p_claim_token,p_translation:'译文',p_model:'test',p_latency_ms:12}
 for(let i=0;i<5;i++)await rpc(db,'complete_translation',completion)
 const state=await rpc(db,'account_snapshot',{p_user_id:USER})
 assert.equal(state.wallet.balance,95);assert.equal(state.usage.length,1);assert.equal(state.ledger.length,1)
 assert.equal(state.usage[0].request_id,'once-only');assert.equal(state.ledger[0].request_id,'once-only')
 assert.deepEqual(state.reconciliation,{translationDebit:5,usageCharacters:5,duplicateDebits:0,mismatchedRequests:0})
 const status=await rpc(db,'translation_status',{p_user_id:USER,p_request_id:'once-only'})
 assert.equal(status.state,'completed');assert.equal(status.response.balanceAfter,95)
 assert.equal((await rpc(db,'translation_status',{p_user_id:OTHER,p_request_id:'once-only'})).state,'not_found')
})
test('anonymous and signed-in roles cannot bypass server authorization for snapshots or private translation text',async()=>{
 for(const role of ['anon','authenticated'] as const){
  await assert.rejects(asRole(db,role,'select public.account_snapshot($1)',[USER]))
  await assert.rejects(asRole(db,role,"select public.translation_status($1,'test')",[USER]))
 }
 await db.query("update public.profiles set status='blocked' where id=$1",[USER])
 await assert.rejects(rpc(db,'translation_status',{p_user_id:USER,p_request_id:'test'}),/account_disabled/)
})

test('matching totals cannot conceal mismatched individual request debits',async()=>{
 for(const id of ['a','b']){
  const a=args(id);await rpc(db,'begin_translation',a)
  await rpc(db,'complete_translation',{p_user_id:USER,p_request_id:id,p_claim_token:a.p_claim_token,p_translation:'译文',p_model:'test',p_latency_ms:1})
 }
 await db.exec("update public.translation_usage set source_characters=case when request_id='a' then 6 else 4 end")
 const state=await rpc(db,'account_snapshot',{p_user_id:USER})
 assert.equal(state.reconciliation.translationDebit,state.reconciliation.usageCharacters)
 assert.equal(state.reconciliation.mismatchedRequests,2)
})
