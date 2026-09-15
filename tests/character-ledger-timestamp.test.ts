import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {database,reset,USER} from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const migration=new URL('../supabase/migrations/20260915190000_character_ledger_recording_timestamp.sql',import.meta.url)
before(async()=>{db=await database()});after(async()=>db.close())
beforeEach(async()=>{await reset(db)})

test('ledger records the time a delayed completion inserts its debit, not when the transaction started',async()=>{
 const claim=randomUUID()
 await db.transaction(async tx=>{
  await tx.query('select public.begin_translation($1,$2,$3,$4,$5,$6)',[USER,'ledger-time-delayed','a'.repeat(64),9,claim,{provider:'openai'}])
  // A delay after the transaction and wallet lock begin models the elapsed
  // time that caused the production ordering issue. PGlite has one connection,
  // so this asserts PostgreSQL timestamp semantics, not a multi-session load test.
  await new Promise(resolve=>setTimeout(resolve,30))
  await tx.query('select public.complete_translation($1,$2,$3,$4,$5,$6)',[USER,'ledger-time-delayed',claim,'Hello','test-model',30])
  const {rows}=await tx.query<any>(`select created_at>transaction_timestamp()+interval '15 milliseconds' as after_transaction_start,
   created_at<=clock_timestamp() as not_future,characters,balance_after from public.character_ledger where user_id=$1 and idempotency_key=$2`,[USER,'ledger-time-delayed'])
  assert.equal(rows[0].after_transaction_start,true);assert.equal(rows[0].not_future,true)
  assert.equal(Number(rows[0].characters),-9);assert.equal(Number(rows[0].balance_after),91)
 })
})

test('multiple debits within one transaction retain their actual insertion sequence and balances',async()=>{
 await db.transaction(async tx=>{
  for(const [index,characters] of [5,7].entries()){
   const request='ledger-time-order-'+index,claim=randomUUID()
   await tx.query('select public.begin_translation($1,$2,$3,$4,$5,$6)',[USER,request,(index?'b':'a').repeat(64),characters,claim,{provider:'openai'}])
   await new Promise(resolve=>setTimeout(resolve,20))
   await tx.query('select public.complete_translation($1,$2,$3,$4,$5,$6)',[USER,request,claim,'Hello','test-model',20])
  }
  const {rows}=await tx.query<any>(`select idempotency_key,characters,balance_after,created_at,
   created_at>lag(created_at) over(order by created_at) as strictly_after_previous from public.character_ledger where user_id=$1 order by created_at`,[USER])
  assert.deepEqual(rows.map(r=>r.idempotency_key),['ledger-time-order-0','ledger-time-order-1'])
  assert.deepEqual(rows.map(r=>Number(r.balance_after)),[95,88]);assert.equal(rows[1].strictly_after_previous,true)
 })
})

test('changing the default preserves every historical ledger field and explicit import timestamps',async()=>{
 await db.exec('alter table public.character_ledger alter column created_at set default now()')
 await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,source,created_at)
  values($1,'adjustment',1,101,'historical-time-fixture','test','2026-09-01T01:02:03.456Z')`,[USER])
 const beforeRows=await db.query('select * from public.character_ledger order by id')
 await db.exec(await readFile(migration,'utf8'))
 assert.deepEqual((await db.query('select * from public.character_ledger order by id')).rows,beforeRows.rows)
 const {rows}=await db.query<{column_default:string}>(`select column_default from information_schema.columns where table_schema='public' and table_name='character_ledger' and column_name='created_at'`)
 assert.equal(rows[0].column_default,'clock_timestamp()')
})
