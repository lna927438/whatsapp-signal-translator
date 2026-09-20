import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,rpc,asRole,USER,OTHER,wallet} from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
const model='deepseek-v4-pro',hash='a'.repeat(64),characters=4
const metadata={metering_version:'2',provider:'deepseek',requested_model:model,
  provider_plan:[{provider:'deepseek',model}],provider_correction:{provider:'deepseek',model,maxAttempts:1},
  account_id:'fixture-account',conversation_id:'fixture-conversation',source_language:'en-US',target_language:'zh-CN',
  security_input_token_bound:5000,security_output_token_bound:1024}
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await reset(db);await db.exec('update translator_private.security_policy set enabled=true,user_daily_usd=10,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60')})
const job=(user=USER)=>({p_user_id:user,p_request_id:randomUUID(),p_claim_token:randomUUID()})
function attempt(errorCode:string|null=null,correction=false,unknown=false){
  const at=new Date().toISOString()
  return {provider:'deepseek',model,startedAt:at,finishedAt:at,errorCode,...(correction?{correction:true}:{}),
    receipt:{model,httpStatus:unknown?null:200,inputTokens:unknown?null:100,cachedTokens:unknown?null:0,cacheWriteTokens:unknown?null:0,
      outputTokens:unknown?null:50,totalTokens:unknown?null:150,reasoningTokens:unknown?null:0,serviceTier:'default',createdAt:unknown?null:at}}
}
const receipt=(attempts:any[]=[attempt()],selectedProvider:string|null='deepseek')=>({version:2,selectedProvider,attempts})
const complete=(args:any,r=receipt(),text='合成修复译文')=>rpc(db,'complete_translation_metered',{
  ...args,p_translation:text,p_model:model,p_latency_ms:100,p_receipt:r})
const fail=(args:any,r=receipt([],null))=>rpc(db,'fail_translation_metered',{...args,p_error_code:'provider_not_translation',p_receipt:r})
async function start(user=USER,chars=characters){const args=job(user);await rpc(db,'begin_translation',{...args,p_payload_hash:hash,p_characters:chars,p_metadata:metadata});return args}
async function paid(user=USER){const original=await start(user);await complete(original,receipt(),'合成旧错误译文');return original}
function repairArgs(original:any,patch:Record<string,unknown>={}){return {...job(original.p_user_id),p_original_request_id:original.p_request_id,
  p_payload_hash:hash,p_characters:characters,p_metadata:metadata,...patch}}
const begin=(args:any)=>rpc(db,'begin_translation_repair',args)
const status=(original:any)=>rpc(db,'translation_repair_status',{p_user_id:original.p_user_id,p_original_request_id:original.p_request_id})
async function originalEvidence(id:string){return (await db.query<any>(`select to_jsonb(r) as request,
  (select to_jsonb(l) from public.character_ledger l where l.user_id=r.user_id and l.idempotency_key=r.request_id) as ledger,
  (select to_jsonb(u) from public.translation_usage u where u.user_id=r.user_id and u.request_id=r.request_id) as usage,
  (select to_jsonb(p) from translator_private.provider_usage p where p.user_id=r.user_id and p.request_id=r.request_id) as provider
  from translator_private.translation_requests r where r.user_id=$1 and r.request_id=$2`,[USER,id])).rows[0]}

test('paid semantic repair reserves provider costs at zero wallet balance, never customer characters or an extra usage debit',async()=>{
  const original=await paid(),before=await originalEvidence(original.p_request_id),repair=repairArgs(original)
  await db.exec('update public.wallets set balance=0 where user_id=\''+USER+'\'')
  assert.equal((await begin(repair)).state,'claimed')
  assert.deepEqual(await wallet(db),{balance:0,reserved_characters:0,lifetime_debited:4})
  const record=(await db.query<any>('select source_characters,billable_characters from translator_private.translation_requests where request_id=$1',[repair.p_request_id])).rows[0]
  assert.deepEqual(record,{source_characters:4,billable_characters:0})
  const budget=(await db.query<any>('select maximum_usd from translator_private.cost_reservations where request_id=$1',[repair.p_request_id])).rows[0]
  assert.ok(Number(budget.maximum_usd)>0)
  const result=await complete(repair)
  assert.equal(result.state,'completed');assert.equal(result.response.requestId,original.p_request_id)
  assert.equal(result.response.repairRequestId,repair.p_request_id);assert.equal(result.response.repairOf,original.p_request_id)
  assert.equal(result.response.sourceCharacters,4);assert.equal(result.response.chargedCharacters,0);assert.equal(result.response.balanceAfter,0)
  assert.deepEqual(await originalEvidence(original.p_request_id),before)
  assert.deepEqual(await wallet(db),{balance:0,reserved_characters:0,lifetime_debited:4})
  assert.equal((await db.query<any>('select count(*)::int n from public.translation_usage')).rows[0].n,1)
  assert.equal((await db.query<any>("select count(*)::int n from public.character_ledger where type='translation'")).rows[0].n,1)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.provider_attempt_usage')).rows[0].n,2)
  const rows=(await db.query<any>('select request_id,reconciliation,charged from translator_private.admin_translation_rows order by created_at')).rows
  assert.deepEqual(rows.map(r=>r.reconciliation),['matched','free']);assert.deepEqual(rows.map(r=>Number(r.charged)),[4,0])
  const snapshot=await rpc(db,'account_snapshot',{p_user_id:USER})
  assert.equal(snapshot.reconciliation.mismatchedRequests,0);assert.equal(snapshot.reconciliation.translationDebit,4)
  assert.equal(snapshot.reconciliation.usageCharacters,4)
})

test('one immutable mapping admits one provider owner and completion replay cannot rewrite financial receipts',async()=>{
  const original=await paid(),repair=repairArgs(original)
  const claims=await Promise.all([begin(repair),begin({...repair,p_claim_token:randomUUID()})])
  assert.deepEqual(claims.map(x=>x.state),['claimed','processing'])
  await assert.rejects(begin({...repair,p_request_id:randomUUID()}),/request_id_conflict/)
  const r=receipt([attempt('provider_not_translation'),attempt(null,true)])
  const results=await Promise.all([complete(repair,r),complete(repair,r)])
  assert.deepEqual(results[0].response,results[1].response);assert.equal(results[1].state,'completed')
  assert.equal((await status(original)).response.translation,'合成修复译文')
  assert.equal((await begin({...repair,p_claim_token:randomUUID()})).state,'completed')
  await assert.rejects(complete(repair,receipt()),/operation_conflict/)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n,1)
  assert.equal((await wallet(db)).lifetime_debited,4)
  await assert.rejects(asRole(db,'service_role','update translator_private.translation_repairs set repair_request_id=$1',[randomUUID()]),/permission denied/)
  await assert.rejects(asRole(db,'service_role','delete from translator_private.translation_repairs'),/permission denied/)
})

test('original ownership, exact payload, source length, language and conversation cannot be substituted',async()=>{
  const original=await paid(),repair=repairArgs(original)
  for(const patch of [
    {p_user_id:OTHER},{p_original_request_id:randomUUID()},{p_payload_hash:'b'.repeat(64)},
    {p_characters:3},{p_request_id:original.p_request_id},
    {p_metadata:{...metadata,account_id:'another'}},{p_metadata:{...metadata,conversation_id:'another'}},
    {p_metadata:{...metadata,source_language:'zh-CN'}},{p_metadata:{...metadata,target_language:'en-US'}}
  ])await assert.rejects(begin({...repair,...patch}),/request_not_found|request_id_conflict|invalid_request/)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n,0)
  assert.equal((await status({...original,p_user_id:OTHER})).state,'none')
  assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4})
})

test('pending, failed, already-free or ledgerless original results cannot acquire a free repair',async()=>{
  const pending=await start();await assert.rejects(begin(repairArgs(pending)),/request_id_conflict/)
  await fail(pending);await assert.rejects(begin(repairArgs(pending)),/request_id_conflict/)
  const original=await paid(),repair=repairArgs(original);await begin(repair);await complete(repair)
  await assert.rejects(begin(repairArgs(repair)),/request_id_conflict/)
  const other=await paid();await db.query('delete from public.character_ledger where idempotency_key=$1',[other.p_request_id])
  await assert.rejects(begin(repairArgs(other)),/request_id_conflict/)
})

test('forged metadata and zero-character insert cannot obtain the repair billing treatment',async()=>{
  const ordinary=await start()
  assert.equal((await db.query<any>('select billable_characters from translator_private.translation_requests where request_id=$1',[ordinary.p_request_id])).rows[0].billable_characters,4)
  await assert.rejects(asRole(db,'service_role',`insert into translator_private.translation_requests
    (user_id,request_id,payload_hash,source_characters,billable_characters,claim_token,metadata) values($1,$2,$3,4,0,$4,$5)`,
    [USER,randomUUID(),hash,randomUUID(),{...metadata,repair_of:ordinary.p_request_id}]),/invalid_request/)
  await assert.rejects(asRole(db,'service_role','update translator_private.translation_requests set billable_characters=0 where request_id=$1',[ordinary.p_request_id]),/request_id_conflict/)
  await assert.rejects(asRole(db,'service_role','update translator_private.translation_requests set source_characters=5,billable_characters=5 where request_id=$1',[ordinary.p_request_id]),/request_id_conflict/)
  await assert.rejects(asRole(db,'service_role','update translator_private.translation_requests set payload_hash=$1 where request_id=$2',['b'.repeat(64),ordinary.p_request_id]),/request_id_conflict/)
  await fail(ordinary)
})

test('repair failure retains original paid result and both provider costs with no automatic second repair',async()=>{
  const original=await paid(),before=await originalEvidence(original.p_request_id),repair=repairArgs(original)
  await begin(repair)
  const r=receipt([attempt('provider_not_translation'),attempt('provider_not_translation',true)],null)
  const result=await fail(repair,r);assert.equal(result.state,'failed');assert.equal(result.error,'provider_not_translation')
  assert.equal((await status(original)).state,'failed');assert.equal((await begin(repair)).state,'failed')
  await assert.rejects(begin({...repair,p_request_id:randomUUID()}),/request_id_conflict/)
  await fail(repair,r)
  assert.deepEqual(await originalEvidence(original.p_request_id),before)
  assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4})
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.provider_attempt_usage where request_id=$1',[repair.p_request_id])).rows[0].n,2)
})

for(const path of ['status','normal-begin','completion','failure'] as const)test(`expired repair via ${path} never releases another request's customer reservation`,async()=>{
  const original=await paid(),repair=repairArgs(original);await begin(repair)
  const pending=await start(USER,7)
  await db.query("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second' where request_id=$1",[repair.p_request_id])
  if(path==='status')assert.equal((await status(original)).state,'failed')
  if(path==='normal-begin'){const next=await start(USER,3);await fail(next)}
  if(path==='completion')assert.equal((await complete(repair)).state,'failed')
  if(path==='failure')assert.equal((await fail(repair)).state,'failed')
  assert.deepEqual(await wallet(db),{balance:96,reserved_characters:7,lifetime_debited:4})
  assert.equal((await begin(repair)).state,'failed');await fail(pending)
  assert.equal((await wallet(db)).reserved_characters,0)
})

test('normal expired reservations still release their original source count alongside zero-reservation repairs',async()=>{
  const original=await paid(),repair=repairArgs(original);await begin(repair)
  const pending=await start(USER,7)
  await db.query("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second' where request_id=any($1)",[[repair.p_request_id,pending.p_request_id]])
  const next=await start(USER,2)
  assert.deepEqual(await wallet(db),{balance:96,reserved_characters:2,lifetime_debited:4})
  await complete(next);assert.deepEqual(await wallet(db),{balance:94,reserved_characters:0,lifetime_debited:6})
})

test('provider budget, concurrency, account pause and malformed requests still fail closed before a repair admission',async()=>{
  const original=await paid(),repair=repairArgs(original)
  for(const patch of [{p_payload_hash:'bad'},{p_characters:0},{p_claim_token:null},{p_metadata:null},{p_metadata:{...metadata,metering_version:'1'}}])
    await assert.rejects(begin({...repair,...patch}),/invalid_request/)
  await db.exec('update translator_private.security_policy set user_daily_usd=0.0001,global_daily_usd=0.0001')
  await assert.rejects(begin(repair),/cost_limit/)
  await db.exec('update translator_private.security_policy set user_daily_usd=10,global_daily_usd=50,user_concurrency=1')
  const pending=await start();await assert.rejects(begin(repair),/rate_limited/);await fail(pending)
  await db.exec('update translator_private.security_policy set enabled=false');await assert.rejects(begin(repair),/security_paused/)
  await db.exec('update translator_private.security_policy set enabled=true')
  await db.query("update public.profiles set status='disabled' where id=$1",[USER]);await assert.rejects(begin(repair),/account_disabled/)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n,0)
})

test('content erasure prevents a new repair but does not erase immutable completed repair status/financial evidence',async()=>{
  const original=await paid(),repair=repairArgs(original)
  await db.query("update translator_private.translation_requests set response=response-'translation' where request_id=$1",[original.p_request_id])
  await assert.rejects(begin(repair),/translation_content_unavailable/)
  const fresh=await paid(),done=repairArgs(fresh);await begin(done);await complete(done)
  await db.exec("update translator_private.translation_requests set updated_at=clock_timestamp()-interval '100 days'")
  await rpc(db,'security_housekeeping',{})
  assert.equal((await status(fresh)).state,'completed');assert.equal((await status(fresh)).response.contentExpired,true)
  assert.equal((await begin(done)).state,'completed');assert.equal((await wallet(db)).lifetime_debited,8)
})

test('unknown repair provider cost remains conservatively reserved and no client role can invoke repair RPCs',async()=>{
  const original=await paid(),repair=repairArgs(original);await begin(repair)
  await fail(repair,receipt([attempt('provider_timeout',false,true)],null))
  const usage=(await db.query<any>('select cost_usd,budget_cost_usd from translator_private.provider_usage where request_id=$1',[repair.p_request_id])).rows[0]
  assert.equal(usage.cost_usd,null);assert.ok(Number(usage.budget_cost_usd)>0)
  assert.deepEqual(await wallet(db),{balance:96,reserved_characters:0,lifetime_debited:4})
  for(const role of ['anon','authenticated'] as const){
    await assert.rejects(asRole(db,role,'select public.translation_repair_status($1,$2)',[USER,original.p_request_id]),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.begin_translation_repair($1,$2,$3,$4,$5,$6,$7)',
      [USER,original.p_request_id,hash,characters,randomUUID(),randomUUID(),metadata]),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.verify_original_translation($1,$2,$3,$4)',
      [USER,original.p_request_id,JSON.stringify([hash]),characters]),/permission denied/)
    await assert.rejects(asRole(db,role,'select * from translator_private.translation_repairs'),/permission denied/)
  }
})

test('replacement of legacy settlement functions preserves service-only execution grants',async()=>{
  const signatures=[
    'public.begin_translation(uuid,text,text,integer,uuid,jsonb)',
    'public.complete_translation(uuid,text,uuid,text,text,integer)',
    'public.fail_translation(uuid,text,uuid,text)',
    'public.translation_status(uuid,text)',
    'public.begin_translation_repair(uuid,text,text,integer,text,uuid,jsonb)',
    'public.translation_repair_status(uuid,text)',
    'public.verify_original_translation(uuid,text,jsonb,integer)'
  ]
  for(const signature of signatures){
    const result=(await db.query<any>(`select has_function_privilege('service_role',$1,'execute') service,
      has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') authenticated`,[signature])).rows[0]
    assert.deepEqual(result,{service:true,anon:false,authenticated:false},signature)
  }
})

test('original verification checks every immutable fingerprint without starting, expiring or charging a job',async()=>{
  const original=await paid(),pending=await start(USER,7)
  await db.query("update translator_private.translation_requests set expires_at=clock_timestamp()-interval '1 second' where request_id=$1",[pending.p_request_id])
  const before=await originalEvidence(original.p_request_id),walletBefore=await wallet(db)
  const args={p_user_id:USER,p_request_id:original.p_request_id,p_payload_hashes:['b'.repeat(64),hash],p_characters:characters}
  const result=await rpc(db,'verify_original_translation',args)
  assert.equal(result.state,'completed');assert.equal(result.response.translation,'合成旧错误译文')
  assert.equal('payloadHash' in result,false,'the fingerprint remains server-side')
  for(const patch of [{p_payload_hashes:['b'.repeat(64)]},{p_characters:characters+1}])
    await assert.rejects(rpc(db,'verify_original_translation',{...args,...patch}),/request_id_conflict/)
  await assert.rejects(rpc(db,'verify_original_translation',{...args,p_user_id:OTHER}),/request_not_found/)
  await assert.rejects(rpc(db,'verify_original_translation',{...args,p_request_id:randomUUID()}),/request_not_found/)
  assert.deepEqual(await originalEvidence(original.p_request_id),before);assert.deepEqual(await wallet(db),walletBefore)
  assert.equal((await db.query<any>('select state from translator_private.translation_requests where request_id=$1',[pending.p_request_id])).rows[0].state,'processing')
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_requests')).rows[0].n,2)
  assert.equal((await db.query<any>('select count(*)::int n from translator_private.translation_repairs')).rows[0].n,0)
  assert.equal((await db.query<any>("select provolatile from pg_proc where oid='public.verify_original_translation(uuid,text,jsonb,integer)'::regprocedure")).rows[0].provolatile,'s')
})

test('original verification rejects malformed hash lists and inactive accounts without mutating retained receipts',async()=>{
  const original=await paid(),before=await originalEvidence(original.p_request_id)
  const args={p_user_id:USER,p_request_id:original.p_request_id,p_payload_hashes:[hash],p_characters:characters}
  for(const value of [null,{},hash,[],[null],[123],[{}],['not-a-hash'],Array(9).fill(hash)])
    await assert.rejects(asRole(db,'service_role','select public.verify_original_translation($1,$2,$3,$4)',
      [USER,original.p_request_id,JSON.stringify(value),characters]),/invalid_request/)
  await db.query("update public.profiles set status='disabled' where id=$1",[USER])
  await assert.rejects(rpc(db,'verify_original_translation',args),/account_disabled/)
  assert.deepEqual(await originalEvidence(original.p_request_id),before)
})
