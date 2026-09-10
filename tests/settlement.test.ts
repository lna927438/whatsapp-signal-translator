import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, reset, rpc, wallet, asRole, USER } from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
before(async()=>{ db=await database() })
beforeEach(async()=>{ await reset(db) })
after(async()=>{ await db?.close() })
function args(id:string,token=randomUUID()) { return { p_user_id:USER,p_request_id:id,p_payload_hash:'a'.repeat(64),p_characters:5,p_claim_token:token,p_metadata:{} } }
function complete(a:ReturnType<typeof args>) { return rpc(db,'complete_translation',{ p_user_id:USER,p_request_id:a.p_request_id,p_claim_token:a.p_claim_token,p_translation:'译文',p_model:'test',p_latency_ms:1 }) }

test('usage failure rolls back the debit, ledger and completion together',async()=>{
  const a=args('usage-failure')
  await rpc(db,'begin_translation',a)
  await db.exec("alter table public.translation_usage add constraint simulated_failure check (request_id <> 'usage-failure')")
  try {
    await assert.rejects(complete(a),/simulated_failure/)
    assert.deepEqual(await wallet(db),{ balance:100,reserved_characters:5,lifetime_debited:0 })
    assert.equal((await db.query('select * from public.character_ledger')).rows.length,0)
    assert.equal((await db.query<{ state:string }>('select state from translator_private.translation_requests')).rows[0].state,'processing')
  } finally { await db.exec('alter table public.translation_usage drop constraint simulated_failure') }
  assert.equal((await complete(a)).state,'completed')
  assert.equal((await wallet(db)).balance,95)
})

test('an expired abandoned reservation is released by the next request and cannot be reclaimed',async()=>{
  const a=args('abandoned')
  await rpc(db,'begin_translation',a)
  await db.exec("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second'")
  const next=args('new-request')
  assert.equal((await rpc(db,'begin_translation',next)).state,'claimed')
  assert.equal((await wallet(db)).reserved_characters,5)
  const old=await rpc(db,'begin_translation',a)
  assert.equal(old.state,'failed'); assert.equal(old.error,'translation_outcome_unknown')
})

test('the claim owner alone can settle a request and settlements are idempotent',async()=>{
  const a=args('owner')
  await rpc(db,'begin_translation',a)
  await assert.rejects(complete({ ...a,p_claim_token:randomUUID() }),/request_id_conflict/)
  assert.equal((await wallet(db)).reserved_characters,5)
  const first=await complete(a)
  const replay=await complete(a)
  assert.equal(replay.state,first.state)
  assert.deepEqual(replay.response,first.response)
  assert.equal((await wallet(db)).balance,95)
})

test('legacy RPCs cannot consume reserved funds or reuse a new request claim',async()=>{
  await rpc(db,'begin_translation',{ ...args('reserved'),p_characters:100 })
  await assert.rejects(asRole(db,'service_role',"select public.consume_characters($1,1,'legacy-new')",[USER]),/insufficient_characters/)
  await assert.rejects(asRole(db,'service_role',"select public.consume_characters($1,1,'reserved')",[USER]),/request_id_conflict/)
})

test('legacy debits cannot be replayed as a fresh translation',async()=>{
  await asRole(db,'service_role',"select public.consume_characters($1,5,'legacy-paid')",[USER])
  await assert.rejects(rpc(db,'begin_translation',args('legacy-paid')),/request_id_conflict/)
  assert.equal((await wallet(db)).balance,95)
})

test('database claims independently reject disabled users',async()=>{
  await db.query("update public.profiles set status='blocked' where id=$1",[USER])
  await assert.rejects(rpc(db,'begin_translation',args('disabled')),/account_disabled/)
  assert.equal((await wallet(db)).reserved_characters,0)
})
