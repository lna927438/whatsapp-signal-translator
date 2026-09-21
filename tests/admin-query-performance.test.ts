import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { database, reset, asRole, USER, OTHER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
before(async () => {
  db=await database(); await reset(db)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])
  const accountSource=await readFile(new URL('../supabase/migrations/20260916010000_bounded_translation_correction_billing.sql',import.meta.url),'utf8')
  await db.exec(accountSource.slice(accountSource.indexOf('CREATE OR REPLACE FUNCTION public.account_snapshot'))
    .replace('public.account_snapshot','translator_private.incident_snapshot_before'))
  // A long unrelated account must not enlarge another user's reconciliation.
  // Historical usage/debit rows intentionally have no coordinated request row.
  await db.query(`insert into public.translation_usage(user_id,request_id,provider,model,source_characters,created_at)
    select case when n<=100 then $1::uuid else $2::uuid end,'perf-history-'||n,
      case when n%5=0 then 'openai' else 'deepseek' end,'fixture',7,
      '2026-09-20T12:00:00Z'::timestamptz+n*interval '1 second' from generate_series(1,2000)n`,[USER,OTHER])
  await db.query(`insert into public.character_ledger(id,user_id,type,characters,balance_after,idempotency_key,created_at)
    select md5('perf-history-'||n)::uuid,case when n<=100 then $1::uuid else $2::uuid end,
      'translation',-7,93,'perf-history-'||n,'2026-09-20T12:00:00Z'::timestamptz+n*interval '1 second'
    from generate_series(1,2000)n where n<>99`,[USER,OTHER])
  await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,created_at)
    values($1,'translation',-9,91,'perf-orphan','2026-09-20T14:00:00Z'),
      ($1,'translation',-1,90,null,'2026-09-20T14:01:00Z'),
      ($1,'translation',-1,89,null,'2026-09-20T14:02:00Z'),
      ($2,'translation',-17,83,'perf-history-1','2026-09-20T14:03:00Z')`,[USER,OTHER])
  await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,metadata,created_at)
    values($1,'refund',3,96,jsonb_build_object('original_ledger_id',md5('perf-history-1')::uuid::text),'2026-09-20T15:00:00Z'),
      ($1,'refund',2,98,jsonb_build_object('original_ledger_id',md5('perf-history-1')::uuid::text),'2026-09-20T15:01:00Z'),
      ($2,'refund',19,102,jsonb_build_object('original_ledger_id',md5('perf-history-1')::uuid::text),'2026-09-20T15:02:00Z')`,[USER,OTHER])
  for(let n=1;n<=6;n++) {
    const user=n%2?USER:OTHER,request='perf-attempt-'+n,claim=`20000000-0000-4000-8000-00000000000${n}`
    await db.query(`insert into translator_private.translation_requests(user_id,request_id,payload_hash,source_characters,claim_token,state,created_at)
      values($1,$2,repeat('a',64),7,$3,'failed','2026-09-21T12:00:00Z')`,[user,request,claim])
    await db.query(`insert into translator_private.provider_usage(user_id,request_id,claim_token,provider,model,started_at,cost_status,cost_usd)
      values($1,$2,$3,'deepseek','fixture','2026-09-21T12:00:00Z','calculated',0.02)`,[user,request,claim])
    if(n<6) await db.query(`insert into translator_private.provider_attempt_usage
      (user_id,request_id,attempt_index,provider,model,started_at,finished_at,receipt,cost_status,cost_usd,maximum_usd,input_tokens,output_tokens,total_tokens)
      values($1,$2,1,'deepseek','fixture','2026-09-21T12:00:00Z','2026-09-21T12:00:01Z','{}',
        case when $3::integer=2 then 'missing_usage' else 'calculated' end,
        case when $3::integer=2 then null when $3::integer=3 then 0 else 0.02 end,0.2,20,4,24)`,[user,request,n])
    if(n===1) await db.query(`insert into translator_private.provider_attempt_usage
      (user_id,request_id,attempt_index,provider,model,started_at,finished_at,receipt,cost_status,cost_usd,maximum_usd)
      values($1,$2,2,'openai','fixture','2026-09-21T12:00:02Z','2026-09-21T12:00:03Z','{}','calculated',0.03,0.2)`,[user,request])
  }
  await db.exec('analyze public.translation_usage; analyze public.character_ledger; analyze translator_private.translation_requests; analyze translator_private.provider_attempt_usage; analyze translator_private.provider_usage')
})
after(async()=>{await db?.close()})

test('account reconciliation remains exact for orphans, null IDs, cross-account IDs and disabled accounts',async context=>{
  for(const user of [USER,OTHER]) {
    const before=await db.query<{result:unknown}>("select translator_private.incident_snapshot_before($1)-'snapshotAt' result",[user])
    const start=performance.now()
    const after=await db.query<{result:unknown}>("select public.account_snapshot($1)-'snapshotAt' result",[user])
    assert.deepEqual(after.rows,before.rows)
    context.diagnostic(JSON.stringify({function:'account_snapshot',user:user===USER?'small':'large',rows:2000,afterMs:performance.now()-start,contractEqual:true}))
  }
  await db.query("update public.profiles set status='disabled' where id=$1",[OTHER])
  assert.equal((await db.query<{result:unknown}>('select public.account_snapshot($1) result',[OTHER])).rows[0].result,null)
  await db.query("update public.profiles set status='active' where id=$1",[OTHER])
})

function operational(result:Record<string,unknown>) {
  return {...Object.fromEntries(['users','activeUsers','recentClients','todayCharacters','pendingOrders','pendingTranslations']
    .map(key=>[key,result[key]])),mismatches:(result.costs as Record<string,unknown>).mismatches}
}

test('light overview preserves all displayed counts while leaving ledger and full billing API intact',async context=>{
  const beforeLedger=(await db.query('select count(*),sum(characters) from public.character_ledger')).rows
  let start=performance.now()
  const before=await db.query<{result:Record<string,unknown>}>("select public.admin_read($1,'overview','{}') result",[USER])
  const beforeMs=performance.now()-start; start=performance.now()
  const after=await db.query<{result:Record<string,unknown>}>("select public.admin_overview($1) result",[USER])
  const afterMs=performance.now()-start
  assert.deepEqual(operational(after.rows[0].result),operational(before.rows[0].result))
  assert.equal(typeof after.rows[0].result.snapshotAt,'string')
  assert.deepEqual(Object.keys(after.rows[0].result.costs as object),['mismatches'])
  assert.ok('provider_requests' in (before.rows[0].result.costs as object),'Old billing-rich overview contract remains available')
  assert.deepEqual((await db.query('select count(*),sum(characters) from public.character_ledger')).rows,beforeLedger)
  context.diagnostic(JSON.stringify({environment:'isolated PGlite',rows:2000,beforeMs,afterMs,displayedCountsEqual:true,ledgerUnchanged:true}))
})

test('query replacements preserve invoker permissions and admin authorization',async()=>{
  for(const role of ['anon','authenticated'] as const) {
    await assert.rejects(asRole(db,role,'select public.account_snapshot($1)',[USER]),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.admin_overview($1)',[USER]),/permission denied/)
    await assert.rejects(asRole(db,role,"select public.admin_read($1,'costs','{}')",[USER]),/permission denied/)
  }
  await assert.rejects(asRole(db,'service_role','select public.admin_overview($1)',[OTHER]),/admin_forbidden/)
  for(const role of ['support','finance','editor']) {
    await db.query('insert into public.admin_roles(user_id,role) values($1,$2) on conflict(user_id) do update set role=excluded.role',[OTHER,role])
    const before=await asRole<{result:Record<string,unknown>}>(db,'service_role',"select public.admin_read($1,'overview','{}') result",[OTHER])
    const after=await asRole<{result:Record<string,unknown>}>(db,'service_role','select public.admin_overview($1) result',[OTHER])
    assert.deepEqual(operational(after.rows[0].result),operational(before.rows[0].result))
  }
  await db.query("update public.profiles set status='disabled' where id=$1",[OTHER])
  await assert.rejects(asRole(db,'service_role','select public.admin_overview($1)',[OTHER]),/admin_forbidden/)
  await db.query("update public.profiles set status='active' where id=$1",[OTHER])
  const flags=await db.query<{proname:string;prosecdef:boolean}>(`select proname,prosecdef from pg_proc where oid in
    ('public.account_snapshot(uuid)'::regprocedure,'public.admin_overview(uuid)'::regprocedure)`)
  assert.equal(flags.rows.length,2); assert.ok(flags.rows.every(row=>row.prosecdef===false))
})

test('light overview excludes unrelated provider-cost computation during a provider-only attempt burst',async context=>{
  // Isolated fixture insertion bypasses the runtime trigger only while constructing
  // historical rows; no production connection or setting is used by this test.
  await db.exec('alter table translator_private.translation_requests disable trigger user')
  try {
    await db.query(`insert into translator_private.translation_requests
      (user_id,request_id,payload_hash,source_characters,billable_characters,claim_token,state,created_at)
      select $1,'perf-burst-'||n,repeat('b',64),7,7,md5('perf-burst-'||n)::uuid,'failed','2026-09-22T00:00:00Z'
      from generate_series(1,1500)n`,[OTHER])
  } finally {await db.exec('alter table translator_private.translation_requests enable trigger user')}
  await db.query(`insert into translator_private.provider_usage(user_id,request_id,claim_token,provider,model,started_at)
    select $1,'perf-burst-'||n,md5('perf-burst-'||n)::uuid,'deepseek','fixture','2026-09-22T00:00:00Z'
    from generate_series(1,1500)n`,[OTHER])
  await db.query(`insert into translator_private.provider_attempt_usage
    (user_id,request_id,attempt_index,provider,model,started_at,finished_at,receipt,cost_status,cost_usd,maximum_usd)
    select $1,'perf-burst-'||n,1,'deepseek','fixture','2026-09-22T00:00:00Z','2026-09-22T00:00:01Z','{}',
      case when n%7=0 then 'missing_usage' else 'calculated' end,
      case when n%7=0 then null when n%11=0 then 0 else 0.02 end,0.2 from generate_series(1,1500)n`,[OTHER])
  await db.exec('analyze translator_private.translation_requests; analyze translator_private.provider_usage; analyze translator_private.provider_attempt_usage')
  const start=performance.now()
  const before=await db.query<{result:Record<string,unknown>}>("select public.admin_read($1,'overview','{}') result",[USER])
  const beforeMs=performance.now()-start,next=performance.now()
  const after=await db.query<{result:Record<string,unknown>}>('select public.admin_overview($1) result',[USER])
  const afterMs=performance.now()-next
  assert.deepEqual(operational(after.rows[0].result),operational(before.rows[0].result))
  context.diagnostic(JSON.stringify({environment:'isolated PGlite',providerOnlyRows:1500,beforeMs,afterMs,displayedCountsEqual:true}))
})
