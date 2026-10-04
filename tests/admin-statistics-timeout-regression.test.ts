// Isolated synthetic PostgreSQL fixture. Never reads a URL, secret or live database.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { database, reset, USER, OTHER, asRole } from './fixture.ts'

test('admin statistics migration preserves all fields across 90 billing boundaries and isolates report memory settings', async context => {
const migrations = new URL('../supabase/migrations/', import.meta.url)
const migration = await readFile(new URL('20260924012152_optimize_admin_statistics_reads.sql',migrations),'utf8')
assert.ok(migration.trim(), 'The statistics migration must not be an empty placeholder')
const historicalView = (await readFile(new URL('20260920170944_paid_translation_semantic_repair.sql',migrations),'utf8'))
  .match(/create or replace view translator_private\.admin_translation_rows[\s\S]*?from rows join public\.profiles p on p\.id=rows\.user_id;/)?.[0]
const historicalCost = (await readFile(new URL('20260915160000_provider_billing_reconciliation.sql',migrations),'utf8'))
  .match(/create or replace function translator_private\.admin_cost_summary\(p_filter jsonb\)[\s\S]*?end;\$\$;/)?.[0]
const historicalOverview = (await readFile(new URL('20260921212309_lightweight_admin_overview.sql',migrations),'utf8'))
  .match(/create function public\.admin_overview\(p_actor uuid\)[\s\S]*?end;\$\$;/)?.[0].replace('create function','create or replace function')
assert.ok(historicalView); assert.ok(historicalCost); assert.ok(historicalOverview)
const db = await database()
const claim = '30000000-0000-4000-8000-000000000001'
const hash = 'a'.repeat(64)
const at = '2026-09-15T12:00:00Z'
const beforeAt = '2026-08-31T23:59:59Z'
const boundaryAt = '2026-09-01T00:00:00Z'
const checks: string[] = []
const comparisons: unknown[] = []
async function request(key: string, user = USER, created = at, state = 'completed', chars = 7) {
  await db.query(`insert into translator_private.translation_requests
    (user_id,request_id,payload_hash,source_characters,claim_token,state,created_at,updated_at,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$7,'2026-12-01')`, [user,key,hash,chars,claim,state,created])
}
async function usage(key: string, user = USER, created = at, chars = 7, provider = 'deepseek', cache = false) {
  await db.query(`insert into public.translation_usage
    (user_id,request_id,provider,model,source_language,target_language,source_characters,cache_hit,latency_ms,created_at)
    values($1,$2,$3,'fixture-model','en-US','zh-CN',$4,$5,123,$6)`, [user,key,provider,chars,cache,created])
}
async function debit(key: string | null, user = USER, created = at, chars = 7) {
  const id = randomUUID()
  await db.query(`insert into public.character_ledger(id,user_id,type,characters,balance_after,idempotency_key,created_at)
    values($1,$2,'translation',$3,93,$4,$5)`, [id,user,-chars,key,created])
  return id
}
async function refund(id: string, user = USER, chars = 2, type = 'refund') {
  await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,metadata,created_at)
    values($1,$2,$3,95,jsonb_build_object('original_ledger_id',$4::text),'2026-10-01')`, [user,type,chars,id])
}
async function parent(key: string, user = USER, provider = 'deepseek', start = at, cost: string | null = '0.000123456789', status = 'priced') {
  await db.query(`insert into translator_private.provider_usage
    (user_id,request_id,claim_token,provider,model,started_at,recorded_at,input_tokens,cached_tokens,output_tokens,total_tokens,cost_status,cost_usd,budget_cost_usd)
    values($1,$2,$3,$4,'fixture-model',$5,$5,10,2,3,13,$6,$7,0.001)`, [user,key,claim,provider,start,status,cost])
}
async function attempt(key: string, index: number, provider: string, start = at, cost: string | null = '0.000123456789', user = USER, status = 'priced', correction = false) {
  await db.query(`insert into translator_private.provider_attempt_usage
    (user_id,request_id,attempt_index,provider,model,started_at,finished_at,receipt,input_tokens,cached_tokens,cache_write_tokens,output_tokens,total_tokens,cost_status,cost_usd,maximum_usd,correction)
    values($1,$2,$3,$4,'fixture-model',$5,$5,'{}',10,2,1,3,13,$6,$7,0.001,$8)`, [user,key,index,provider,start,status,cost,correction])
}
async function snapshot() {
  return (await db.query(`select
    (select coalesce(jsonb_agg(to_jsonb(r) order by user_id,request_id nulls first),'[]') from translator_private.admin_translation_rows r) as rows,
    (select coalesce(jsonb_agg(to_jsonb(i) order by user_id,request_id nulls first,attempt_index),'[]') from translator_private.provider_cost_items i) as items,
    (select coalesce(jsonb_agg(to_jsonb(l) order by id),'[]') from public.character_ledger l) as ledger,
    (select coalesce(jsonb_agg(to_jsonb(w) order by user_id),'[]') from public.wallets w) as wallets,
    (select coalesce(jsonb_agg(to_jsonb(u) order by user_id,request_id),'[]') from public.translation_usage u) as usage,
    (select coalesce(jsonb_agg(to_jsonb(c) order by user_id,request_id),'[]') from translator_private.cost_reservations c) as reservations`)).rows[0]
}
try {
  // database() includes the new migration. Restore historical definitions first;
  // otherwise both baseline and candidate would silently read the optimized view.
  await db.exec(historicalView)
  await db.exec(historicalCost)
  await db.exec(historicalOverview)
  await db.exec(`alter function translator_private.admin_cost_summary(jsonb) set plan_cache_mode='force_custom_plan';
    alter function translator_private.admin_cost_summary(jsonb) reset work_mem;
    alter function public.admin_overview(uuid) reset work_mem;
    alter function public.admin_overview(uuid) reset plan_cache_mode`)
  await reset(db)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')", [USER])
  // Both users reuse a request ID. Joins and refunds must remain composite-key scoped.
  for (const user of [USER, OTHER]) {
    await request('same-id',user); await usage('same-id',user,at,user===USER?7:11)
    const id=await debit('same-id',user,at,user===USER?7:11)
    await refund(id,user,user===USER?2:3)
    if(user===USER) { await refund(id,OTHER,91); await refund(id.replaceAll('-',''),USER,92); await refund(id,USER,93,'adjustment') }
    await parent('same-id',user,user===USER?'deepseek':'openai')
    await attempt('same-id',1,user===USER?'deepseek':'openai',at,user===USER?'0.01':'0.02',user)
  }
  // created_at precedence is request, then usage, then max(debits), never min/all sources.
  await request('request-before-usage',USER,beforeAt); await usage('request-before-usage',USER,boundaryAt); await debit('request-before-usage',USER,'2026-09-02'); await parent('request-before-usage',USER,'deepseek',boundaryAt)
  await request('request-after-usage',USER,boundaryAt); await usage('request-after-usage',USER,beforeAt); await debit('request-after-usage',USER,beforeAt); await parent('request-after-usage',USER,'deepseek',beforeAt)
  await usage('usage-before-debit',USER,beforeAt); await debit('usage-before-debit',USER,boundaryAt)
  await usage('usage-after-debit',USER,boundaryAt); await debit('usage-after-debit',USER,beforeAt)
  await debit('ledger-only',USER,boundaryAt,9)
  const nullEarly=await debit(null,USER,beforeAt,5), nullLate=await debit(null,USER,'2026-09-02',8)
  await refund([nullEarly,nullLate].sort()[0],USER,4)
  await debit(null,OTHER,beforeAt,17)
  // Exact UTC / GMT+8 boundaries and empty periods.
  for (const [i,created] of ['2026-08-31T15:59:59Z','2026-08-31T16:00:00Z','2026-09-30T15:59:59Z','2026-09-30T16:00:00Z','2026-10-01T00:00:00Z'].entries()) {
    const key=`boundary-${i}`; await request(key,USER,created); await usage(key,USER,created); await debit(key,USER,created)
  }
  // Requests with no usage/debit, cache, zero usage, mismatch, and sanitized errors.
  await request('pending',USER,at,'processing'); await request('failed-no-charge',USER,at,'failed')
  await db.query(`update translator_private.translation_requests set error_code='not safe error' where request_id='failed-no-charge'`)
  await request('failed-charged',USER,at,'failed'); await debit('failed-charged')
  await usage('cached',USER,at,7,'deepseek',true); await usage('zero',USER,at,0)
  await request('mismatch'); await usage('mismatch',USER,at,8); await debit('mismatch')
  // Attempts are counted by started_at independently from request date. Parent receipt must not double count.
  await request('multi-attempt',USER,beforeAt); await usage('multi-attempt',USER,boundaryAt); await debit('multi-attempt',USER,boundaryAt)
  await parent('multi-attempt',USER,'deepseek',beforeAt,'0.9')
  await attempt('multi-attempt',1,'openai',beforeAt,'0.001')
  await attempt('multi-attempt',2,'deepseek',boundaryAt,'0.002')
  await attempt('multi-attempt',3,'deepseek','2026-10-01','0.003',USER,'priced',true)
  // Same key in another user's legacy row must not be suppressed by attempts above.
  await usage('multi-attempt',OTHER,at,5,'openai'); await debit('multi-attempt',OTHER,at,5); await parent('multi-attempt',OTHER,'openai',at,'0.004')
  await parent('orphan-provider-no-admin-row'); await parent('orphan-attempt-no-request'); await attempt('orphan-attempt-no-request',1,'deepseek')
  for(const status of ['not_attempted','pending','unknown_response','historical_unavailable','missing_usage','unknown_price','unknown_time','unknown_service_tier','missing_cache','missing_cache_write']) {
    const key=`status-${status}`; await request(key); await usage(key); await parent(key,USER,'deepseek',at,status==='not_attempted'?'0':null,status)
  }
  await usage('legacy-only',USER,at,4); await debit('legacy-only',USER,at,4)
  // The removed budget-only join must not remove legacy rows or affect any totals.
  for(const key of ['legacy-reserved-no-receipt','legacy-reserved-with-receipt']) {
    await usage(key,USER,at,6); await debit(key,USER,at,6)
    await db.query(`insert into translator_private.cost_reservations(user_id,request_id,maximum_usd,created_at) values($1,$2,0.75,$3)`,[USER,key,at])
  }
  await parent('legacy-reserved-with-receipt',USER,'deepseek',at,'0.000007')
  await db.query(`update translator_private.provider_usage set budget_cost_usd=null where request_id='legacy-reserved-with-receipt'`)
  // A legacy parent in September is still suppressed by its only attempt in August.
  await request('only-outside-attempt'); await usage('only-outside-attempt'); await debit('only-outside-attempt')
  await parent('only-outside-attempt',USER,'deepseek',at,'0.99'); await attempt('only-outside-attempt',1,'deepseek',beforeAt,'0.008')
  // A paid-cache repair has API cost but no second customer charge.
  await request('paid-original'); await usage('paid-original'); await debit('paid-original')
  await db.transaction(async tx=> {
    await tx.query(`insert into translator_private.translation_repairs(user_id,original_request_id,repair_request_id,payload_hash,source_characters,created_at)
      values($1,'paid-original','repair-fixture',$2,7,$3)`,[USER,hash,at])
    await tx.query(`insert into translator_private.translation_requests(user_id,request_id,payload_hash,source_characters,claim_token,state,created_at)
      values($1,'repair-fixture',$2,7,$3,'completed',$4)`,[USER,hash,claim,at])
  })
  await usage('repair-fixture'); await parent('repair-fixture'); await attempt('repair-fixture',1,'deepseek',at,'0.005')
  // Auxiliary outputs must also remain byte-equivalent, even when absent/matched/filter-hidden.
  await db.query(`insert into translator_private.provider_balance_snapshots(id,provider,available,balances,fetched_at)
    values($1,'deepseek',true,'[{"currency":"USD","total":"17.34","paid":"17.34","granted":"0"}]',$2)`,[randomUUID(),at])
  for(const provider of ['openai','deepseek']) await db.query(`insert into translator_private.provider_bill_snapshots
    (id,provider,period_from,period_to,timezone,source,scope,official_usd,reference,fetched_at,actor_id)
    values($1,$2,'2026-09-01','2026-10-01','UTC','manual_statement','{}',$3,'synthetic statement',$4,$5)`,[randomUUID(),provider,provider==='openai'?'0.05':'2.66',at,USER])
  await db.exec('analyze')
  const untouched=await snapshot() as any
  const byKey=(key:string|null,user=USER)=>untouched.rows.find((r:any)=>r.request_id===key&&r.user_id===user)
  assert.equal(new Date(byKey('request-before-usage').created_at).toISOString(),'2026-08-31T23:59:59.000Z')
  assert.equal(new Date(byKey('request-after-usage').created_at).toISOString(),'2026-09-01T00:00:00.000Z')
  assert.equal(new Date(byKey('usage-before-debit').created_at).toISOString(),'2026-08-31T23:59:59.000Z')
  assert.equal(byKey(null).charged,13); assert.equal(byKey(null).debit_count,2); assert.equal(byKey(null).refunded,4)
  assert.equal(byKey('same-id').refunded,2); assert.equal(byKey('same-id',OTHER).refunded,3)
  assert.equal(byKey('failed-no-charge').error_code,null); assert.equal(byKey('repair-fixture').reconciliation,'free')
  assert.equal(untouched.items.filter((i:any)=>i.request_id==='multi-attempt'&&i.user_id===USER).length,3)
  assert.equal(untouched.items.filter((i:any)=>i.request_id==='multi-attempt'&&i.user_id===OTHER).length,1)
  assert.equal(untouched.items.some((i:any)=>i.request_id?.startsWith('orphan-')),false)
  for(const key of ['legacy-reserved-no-receipt','legacy-reserved-with-receipt']) {
    const item=untouched.items.find((i:any)=>i.request_id===key)
    assert.equal(item.maximum_usd,0.75); assert.equal(item.attempt_index,0)
  }
  assert.equal(untouched.items.filter((i:any)=>i.request_id==='only-outside-attempt').length,1)
  assert.equal(untouched.items.find((i:any)=>i.request_id==='only-outside-attempt').cost_usd,0.008)
  checks.push('Synthetic boundary invariants independently checked before differential execution')
  const definition=(await db.query<{definition:string}>(`select pg_get_functiondef('translator_private.admin_cost_summary(jsonb)'::regprocedure) definition`)).rows[0].definition
  await db.exec(definition.replace('translator_private.admin_cost_summary(', 'translator_private.admin_cost_summary_before_candidate('))
  const security=()=>db.query<{prosecdef:boolean;provolatile:string;proconfig:string[];proacl:string}>(`select prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid='translator_private.admin_cost_summary(jsonb)'::regprocedure`)
  const beforeSecurity=(await security()).rows
  const overviewMetadata=()=>db.query<{prosrc:string;prosecdef:boolean;provolatile:string;proconfig:string[];proacl:string}>(`select prosrc,prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid='public.admin_overview(uuid)'::regprocedure`)
  const beforeOverviewMetadata=(await overviewMetadata()).rows
  const viewMetadata=()=>db.query(`select reloptions,relacl::text from pg_class where oid='translator_private.admin_translation_rows'::regclass`)
  const beforeViewMetadata=(await viewMetadata()).rows
  const beforeOverview=(await db.query(`select public.admin_overview($1) - 'snapshotAt' result`,[USER])).rows
  const sessionConfig=()=>db.query(`select current_setting('work_mem') as memory,current_setting('plan_cache_mode') as plan`)
  const beforeSessionConfig=(await sessionConfig()).rows
  const periods=[['2026-08-31','2026-08-31'],['2026-09-01','2026-09-30'],['2026-09-01','2026-09-01'],['2026-09-30','2026-10-01'],['2026-11-01','2026-11-02']]
  const cached: Array<{filter:any;before:any;beforeMs:number}> = []
  for(const timezone of ['UTC','Asia/Shanghai']) for(const [from,to] of periods) for(const provider of ['', 'deepseek','openai']) for(const userId of ['',USER,OTHER]) {
    const filter={from,to,timezone,provider,userId}
    const t=performance.now()
    const before=(await db.query(`select translator_private.admin_cost_summary_before_candidate($1) - 'snapshotAt' result`,[JSON.stringify(filter)])).rows[0]
    cached.push({filter,before,beforeMs:performance.now()-t})
  }
  // Cache full results BEFORE changing the shared view; cloning the function alone
  // would otherwise compare both versions against the same rewritten view.
  await db.transaction(async tx=>{await tx.exec(migration)})
  const afterSecurity=(await security()).rows
  for(const s of afterSecurity) {
    assert.deepEqual(s.proconfig.filter(v=>!beforeSecurity[0].proconfig.includes(v)),['work_mem=8MB'])
    s.proconfig=s.proconfig.filter((v:string)=>v!=='work_mem=8MB')
  }
  assert.deepEqual(afterSecurity,beforeSecurity)
  const afterOverviewMetadata=(await overviewMetadata()).rows
  assert.deepEqual(afterOverviewMetadata[0].proconfig.filter(v=>!beforeOverviewMetadata[0].proconfig.includes(v)).sort(),['plan_cache_mode=force_custom_plan','work_mem=8MB'])
  afterOverviewMetadata[0].proconfig=afterOverviewMetadata[0].proconfig.filter(v=>v!=='work_mem=8MB'&&v!=='plan_cache_mode=force_custom_plan')
  assert.deepEqual(afterOverviewMetadata,beforeOverviewMetadata,'Overview SQL body, ACL and security must not change')
  assert.deepEqual((await viewMetadata()).rows,beforeViewMetadata)
  assert.deepEqual((await db.query(`select public.admin_overview($1) - 'snapshotAt' result`,[USER])).rows,beforeOverview)
  assert.deepEqual(await snapshot(),untouched)
  checks.push('Refund view plus cost summary combination retains original debit grouping, all admin rows, provider items, wallets, ledger and usage plus function security/config/grants')
  for(const {filter,before,beforeMs} of cached) {
    const t=performance.now()
    const after=(await db.query(`select translator_private.admin_cost_summary($1) - 'snapshotAt' result`,[JSON.stringify(filter)])).rows[0]
    assert.deepEqual(after,before,JSON.stringify(filter))
    if (!filter.userId) {
      const {userId: _unused, ...headlineFilter} = filter
      const headline=(await db.query<{result:any}>(`select public.admin_billing_summary($1,$2) result`,[USER,JSON.stringify(headlineFilter)])).rows[0].result
      assert.deepEqual(headline.totals,{
        charged_characters: before.result.totals.charged_characters,
        refunded_characters: before.result.totals.refunded_characters,
      },'Lightweight headline must exactly match the full report, including cross-provider attempts and orphan/refund boundaries')
      for(const field of ['from','toExclusive','timezone']) assert.equal(headline[field],before.result[field])
      assert.deepEqual(headline.officialBills,[],'Only a marker; the gateway supplies account-scoped official bills')
      assert.equal('users' in headline,false)
      assert.equal('providers' in headline,false)
    }
    comparisons.push({filter,beforeMs,afterMs:performance.now()-t})
  }
  checks.push('All fields match for 90 native timezone/date/provider/user filter combinations, including empty periods')
  for(const role of ['anon','authenticated'] as const) {
    await assert.rejects(asRole(db,role,`select translator_private.admin_cost_summary('{}')`),/permission denied/)
    await assert.rejects(asRole(db,role,`select * from translator_private.admin_translation_rows`),/permission denied/)
    await assert.rejects(asRole(db,role,`select public.admin_overview($1)`,[USER]),/permission denied/)
    await assert.rejects(asRole(db,role,`select public.admin_billing_summary($1)`,[USER]),/permission denied/)
  }
  await asRole(db,'service_role',`select translator_private.admin_cost_summary('{"from":"2026-09-01","to":"2026-09-30"}')`)
  await asRole(db,'service_role',`select public.admin_overview($1)`,[USER])
  await asRole(db,'service_role',`select public.admin_billing_summary($1)`,[USER])
  await assert.rejects(asRole(db,'service_role',`select public.admin_billing_summary($1)`,[OTHER]),/admin_forbidden/)
  for(const invalid of [null,[],{userId:''},{userId:OTHER},{timezone:'Europe/London'},{provider:'unknown'},{from:'2026-09-30',to:'2026-09-01'}]) {
    await assert.rejects(asRole(db,'service_role',`select public.admin_billing_summary($1,$2)`,[USER,JSON.stringify(invalid)]),/invalid_request/)
  }
  assert.deepEqual((await sessionConfig()).rows,beforeSessionConfig,'Report-specific settings must not leak into the caller session')
  assert.deepEqual(await snapshot(),untouched)
  checks.push('Public roles remain denied; service role remains usable; repeated reads never mutate stored data')
  context.diagnostic(JSON.stringify({syntheticOnly:true,productionAccess:false,migrationSha256:createHash('sha256').update(migration).digest('hex'),rows:untouched.rows.length,items:untouched.items.length,checks,comparisons:comparisons.length}))
} finally { await db.close() }
})
