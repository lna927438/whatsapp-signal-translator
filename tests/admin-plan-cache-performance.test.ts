import {test} from 'node:test'
import assert from 'node:assert/strict'
import {database,reset,USER,asRole} from './fixture.ts'

test('compare custom and generic admin cost plans on an isolated 30-account historical fixture',async context=>{
  const db=await database();
  try {
    await reset(db)
    const attributes=await db.query<{proconfig:string[];prosecdef:boolean;proacl:string[]}>(`select proconfig,prosecdef,proacl::text[] from pg_proc where oid='translator_private.admin_cost_summary(jsonb)'::regprocedure`)
    assert.ok(attributes.rows[0].proconfig.includes('plan_cache_mode=force_custom_plan'))
    assert.ok(attributes.rows[0].proconfig.some(value=>value.startsWith('search_path=')))
    assert.equal(attributes.rows[0].prosecdef,false)
    for(const role of ['anon','authenticated'] as const)
      await assert.rejects(asRole(db,role,"select translator_private.admin_cost_summary('{}')"),/permission denied/)
    await db.exec(`insert into auth.users(id,email) select md5('perf-account-'||n)::uuid,'synthetic-'||n||'@example.invalid' from generate_series(1,28)n`)
    await db.exec('alter table translator_private.translation_requests disable trigger user')
    try {
      await db.exec(`insert into translator_private.translation_requests(user_id,request_id,payload_hash,source_characters,billable_characters,claim_token,state,created_at,metadata,response)
        select id,'cache-plan-'||n,repeat('c',64),71,71,md5('claim-'||id::text||n)::uuid,
          case when n%17=0 then 'failed' else 'completed' end,'2026-09-01'::timestamptz+n*interval '1 hour',
          '{"provider":"deepseek","requested_model":"fixture"}',jsonb_build_object('translation',repeat('synthetic translation ',12))
        from public.profiles cross join generate_series(1,300)n`)
    } finally {await db.exec('alter table translator_private.translation_requests enable trigger user')}
    await db.exec(`insert into public.translation_usage(user_id,request_id,source_characters,provider,model,created_at)
      select user_id,request_id,source_characters,'deepseek','fixture',created_at from translator_private.translation_requests where state='completed'`)
    await db.exec(`insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,created_at)
      select user_id,'translation',-source_characters,100,request_id,created_at from translator_private.translation_requests where state='completed'`)
    await db.exec(`insert into translator_private.provider_usage(user_id,request_id,claim_token,provider,model,started_at,cost_status,cost_usd)
      select user_id,request_id,claim_token,'deepseek','fixture',created_at,'calculated',0.0001 from translator_private.translation_requests`)
    await db.exec(`insert into translator_private.provider_attempt_usage
      (user_id,request_id,attempt_index,provider,model,started_at,finished_at,receipt,cost_status,cost_usd,maximum_usd,input_tokens,output_tokens,total_tokens)
      select user_id,request_id,1,'deepseek','fixture',created_at,created_at+interval '1 second','{}','calculated',0.0001,0.1,170,30,200
      from translator_private.translation_requests where request_id<>'cache-plan-1'`)
    await db.exec('analyze public.profiles; analyze public.translation_usage; analyze public.character_ledger; analyze translator_private.translation_requests; analyze translator_private.provider_usage; analyze translator_private.provider_attempt_usage')
    const filters=[{from:'2026-09-01',to:'2026-09-22',timezone:'UTC'},
      {from:'2026-09-01',to:'2026-09-22',timezone:'UTC',provider:'deepseek'},
      {from:'2026-09-01',to:'2026-09-22',timezone:'UTC',userId:USER},
      {from:'2026-09-01',to:'2026-09-22',timezone:'UTC',provider:'openai'},
      {from:'2026-09-01',to:'2026-09-22',timezone:'Asia/Shanghai'},
      {from:'2026-09-02',to:'2026-09-02',timezone:'UTC'},
      {from:'2026-08-01',to:'2026-08-22',timezone:'UTC'}]
    for(const filter of filters) {
      const output: Record<string,unknown>={filter},results:unknown[]=[]
      for(const plan of ['force_generic_plan','force_custom_plan']) {
        await db.exec(`alter function translator_private.admin_cost_summary(jsonb) set plan_cache_mode='${plan}'`)
        const start=performance.now()
        const data=await asRole<{result:unknown}>(db,'service_role',"select translator_private.admin_cost_summary($1::jsonb)-'snapshotAt' result",[JSON.stringify(filter)])
        output[plan]=performance.now()-start; results.push(data.rows)
      }
      assert.deepEqual(results[0],results[1])
      context.diagnostic(JSON.stringify(output))
    }
    const finalAttributes=await db.query<{proacl:string[];prosecdef:boolean}>(`select proacl::text[],prosecdef from pg_proc where oid='translator_private.admin_cost_summary(jsonb)'::regprocedure`)
    assert.deepEqual(finalAttributes.rows[0].proacl,attributes.rows[0].proacl)
    assert.equal(finalAttributes.rows[0].prosecdef,false)
  } finally {await db.close()}
})
