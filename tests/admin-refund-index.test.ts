import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { database, reset, asRole, USER, OTHER } from './fixture.ts'

const indexName = 'character_ledger_refund_original_idx'
let db: Awaited<ReturnType<typeof database>>
let migration: string

before(async () => {
  const directory = new URL('../supabase/migrations/', import.meta.url)
  const filename = (await readdir(directory)).find(name => name.endsWith('_admin_refund_lookup_index.sql'))
  assert.ok(filename, 'The refund lookup index must have a CLI-generated migration')
  migration = await readFile(new URL(filename, directory), 'utf8')
  db = await database()
  await reset(db)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')", [USER])
  // Many ordinary debits, few refunds: the production failure grows with each
  // account's debit history rather than with the number of refunds.
  await db.query(`insert into public.character_ledger(id,user_id,type,characters,balance_after,idempotency_key,created_at)
    select md5(u::text||':debit:'||n)::uuid,u,'translation',-7,93,'index-fixture-'||n,'2026-09-19T12:00:00Z'
    from unnest(array[$1::uuid,$2::uuid]) u cross join generate_series(1,1000) n`, [USER, OTHER])
  await db.query(`insert into public.translation_usage(user_id,request_id,provider,model,source_characters,created_at)
    select u,'index-fixture-'||n,'deepseek','fixture',7,'2026-09-19T12:00:00Z'
    from unnest(array[$1::uuid,$2::uuid]) u cross join generate_series(1,1000) n`, [USER, OTHER])
  await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,metadata,created_at) values
    ($1,'refund',3,96,jsonb_build_object('original_ledger_id',md5($1::uuid::text||':debit:1')),'2026-09-19T12:01:00Z'),
    ($1,'refund',2,98,jsonb_build_object('original_ledger_id',md5($1::uuid::text||':debit:1')::uuid::text),'2026-09-19T12:01:00Z'),
    ($2,'refund',7,100,jsonb_build_object('original_ledger_id',md5($2::uuid::text||':debit:1')::uuid::text),'2026-09-19T12:01:00Z'),
    ($2,'refund',101,201,jsonb_build_object('original_ledger_id',md5($1::uuid::text||':debit:1')::uuid::text),'2026-09-19T12:01:00Z'),
    ($1,'refund',102,202,'{}','2026-09-19T12:01:00Z'),
    ($1,'refund',103,203,'{"original_ledger_id":"not-a-uuid"}','2026-09-19T12:01:00Z'),
    ($1,'adjustment',104,204,jsonb_build_object('original_ledger_id',md5($1::uuid::text||':debit:1')::uuid::text),'2026-09-19T12:01:00Z')`, [USER, OTHER])
  // This is a second matching refund, while the first row deliberately lacks
  // UUID dashes: the index must preserve exact text equality, without a cast.
  await db.query(`insert into public.character_ledger(user_id,type,characters,balance_after,metadata,created_at)
    values($1,'refund',4,100,jsonb_build_object('original_ledger_id',md5($1::uuid::text||':debit:1')::uuid::text),'2026-09-19T12:01:00Z')`, [USER])
  await db.exec('analyze public.character_ledger; analyze public.translation_usage')
})
after(async () => { await db?.close() })

test('refund index preserves complete summaries, exact text matches and per-user refund sums in one snapshot', async context => {
  await db.transaction(async tx => {
    await tx.exec(`drop index public.${indexName}`)
    const query = `select (translator_private.admin_cost_summary('{"from":"2026-09-01","to":"2026-09-20","timezone":"UTC"}') - 'snapshotAt') as summary`
    const beforeStarted = performance.now()
    const before = (await tx.query(query)).rows[0]
    const beforeMs = performance.now() - beforeStarted
    const ledgerBefore = (await tx.query('select count(*)::int as rows,sum(characters)::text as characters from public.character_ledger')).rows[0]
    await tx.exec(migration)
    const afterStarted = performance.now()
    const after = (await tx.query(query)).rows[0]
    const afterMs = performance.now() - afterStarted
    assert.deepEqual(after, before)
    assert.deepEqual((await tx.query('select count(*)::int as rows,sum(characters)::text as characters from public.character_ledger')).rows[0], ledgerBefore)
    const refunds = await tx.query<{user_id:string;refunded:string}>(`select user_id,refunded::text from translator_private.admin_translation_rows where request_id='index-fixture-1' order by user_id`)
    assert.deepEqual(refunds.rows, [{user_id:USER,refunded:'6'},{user_id:OTHER,refunded:'7'}])
    context.diagnostic(JSON.stringify({environment:'PGlite synthetic fixture',debits:2000,beforeMs,afterMs,summaryEqual:true,ledgerUnchanged:true}))
  })
})

test('normal planner uses bounded refund index probes instead of scanning each account debit history', async () => {
  const result = await db.query<{ 'QUERY PLAN': unknown }>(`explain (format json) select coalesce(sum(l.characters),0)
    from public.character_ledger l where l.user_id=$1 and l.type='refund'
      and l.metadata->>'original_ledger_id'=md5($1::uuid::text||':debit:1')::uuid::text`, [USER])
  const plan = JSON.stringify(result.rows)
  assert.ok(plan.includes(indexName), plan)
  assert.ok(!plan.includes('character_ledger_user_created_idx'), plan)
  const metadata = await db.query<{indisvalid:boolean;indisunique:boolean;predicate:string;columns:string}>(`select i.indisvalid,i.indisunique,pg_get_expr(i.indpred,i.indrelid) as predicate,pg_get_indexdef(i.indexrelid) as columns
    from pg_index i where i.indexrelid='public.${indexName}'::regclass`)
  assert.equal(metadata.rows[0].indisvalid, true)
  assert.equal(metadata.rows[0].indisunique, false)
  assert.match(metadata.rows[0].predicate, /refund/)
  assert.match(metadata.rows[0].columns, /INCLUDE \(characters\)/)
})

test('refund index grants no new table or administrator access', async () => {
  for (const role of ['anon', 'authenticated'] as const) {
    await assert.rejects(asRole(db,role,"select public.admin_read($1,'overview','{}')",[USER]), /permission denied/)
    await assert.rejects(asRole(db,role,'select * from translator_private.admin_translation_rows'), /permission denied/)
  }
  const result = await asRole<{rows:number}>(db,'authenticated','select count(*)::int as rows from public.character_ledger where user_id=$1',[OTHER],USER)
  assert.equal(result.rows[0].rows,0)
  const owner = await asRole<{result:{totals:{refunded_characters:number}}}>(db,'service_role',`select public.admin_read($1,'costs','{"from":"2026-09-01","to":"2026-09-20","timezone":"UTC"}') as result`,[USER])
  assert.equal(owner.rows[0].result.totals.refunded_characters,13)
})
