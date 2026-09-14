import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {asRole,database,reset,rpc,USER,OTHER,wallet} from './fixture.ts'

let db:Awaited<ReturnType<typeof database>>
type Claim={p_user_id:string;p_request_id:string;p_claim_token:string}
type Lease={allowed:boolean;generation:number;probeToken:string|null;retryAfterMs:number}
const primary={provider:'openai',model:'gpt-5.6-luna'}
const backup={provider:'deepseek',model:'deepseek-v4-pro'}
const meta={metering_version:'2',provider:primary.provider,requested_model:primary.model,
  security_input_token_bound:5000,security_output_token_bound:1024,provider_plan:[primary,backup]}
before(async()=>{db=await database()})
after(async()=>{await db.close()})
beforeEach(async()=>{await reset(db);await db.exec('delete from translator_private.provider_circuits')})
async function begin(id:string,user=USER,metadata:any=meta):Promise<Claim>{
  const claim={p_user_id:user,p_request_id:id,p_claim_token:randomUUID()}
  await rpc(db,'begin_translation',{...claim,p_payload_hash:'a'.repeat(64),p_characters:1,p_metadata:metadata})
  return claim
}
async function acquire(claim:Claim,route=primary):Promise<Lease>{
  return (await asRole<{result:Lease}>(db,'service_role','select public.provider_route_acquire($1,$2,$3,$4,$5) result',
    [claim.p_user_id,claim.p_request_id,claim.p_claim_token,route.provider,route.model])).rows[0].result
}
async function outcome(claim:Claim,lease:Lease,success:boolean,error:string|null=null,route=primary){
  return (await asRole<{result:{recorded:boolean;applied:boolean}}>(db,'service_role',
    'select public.provider_route_outcome($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
    [claim.p_user_id,claim.p_request_id,claim.p_claim_token,route.provider,route.model,lease.generation,lease.probeToken,success,error])).rows[0].result
}
async function circuit(route=primary){
  return (await db.query<any>('select *,greatest(0,extract(epoch from(open_until-clock_timestamp())))::float8 seconds_left from translator_private.provider_circuits where provider=$1 and model=$2',[route.provider,route.model])).rows[0]
}
async function cooldownElapsed(route=primary){
  await db.query("update translator_private.provider_circuits set open_until=now()-interval '1 second' where provider=$1 and model=$2",[route.provider,route.model])
}
async function trip(){
  const claim=await begin('hard-failure'),lease=await acquire(claim)
  await outcome(claim,lease,false,'provider_auth')
}

test('route RPCs require service role, the exact claimed request and its server-authored provider plan',async()=>{
  const claim=await begin('permission'),before=await wallet(db)
  for(const role of ['anon','authenticated'] as const){
    await assert.rejects(asRole(db,role,'select * from translator_private.provider_circuits'),/permission denied/)
    await assert.rejects(asRole(db,role,'select * from translator_private.provider_route_leases'),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.provider_route_acquire($1,$2,$3,$4,$5)',[USER,claim.p_request_id,claim.p_claim_token,primary.provider,primary.model]),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.provider_route_outcome($1,$2,$3,$4,$5,0,null,true,null)',[USER,claim.p_request_id,claim.p_claim_token,primary.provider,primary.model]),/permission denied/)
  }
  await assert.rejects(acquire({...claim,p_claim_token:randomUUID()}),/request_id_conflict/)
  await assert.rejects(acquire({...claim,p_user_id:OTHER}),/request_not_found/)
  await assert.rejects(acquire(claim,{provider:'openai',model:'unplanned-model'}),/invalid_request/)
  await assert.rejects(acquire(await begin('old',USER,{...meta,metering_version:'1'})),/invalid_request/)
  await rpc(db,'fail_translation',{...claim,p_error_code:'provider_timeout'})
  await assert.rejects(acquire(claim),/request_not_processing/)
  assert.equal((await wallet(db)).balance,before.balance)
})

test('healthy concurrent leases keep their generation and outcome replay is immutable',async()=>{
  const a=await begin('healthy-a'),b=await begin('healthy-b',OTHER)
  const [la,lb]=await Promise.all([acquire(a),acquire(b)])
  assert.equal(la.allowed,true);assert.equal(la.probeToken,null);assert.equal(la.generation,lb.generation)
  assert.deepEqual(await acquire(a),la)
  const first=await outcome(a,la,true)
  assert.deepEqual(await outcome(a,la,true),first)
  await assert.rejects(outcome(a,la,false,'provider_timeout'),/operation_conflict/)
  assert.equal((await acquire(a)).allowed,false)
  assert.equal((await outcome(b,lb,true)).applied,true)
  assert.equal((await circuit()).generation,la.generation)
  assert.equal((await circuit()).failures,0)
})

test('two transient failures open a 30-second circuit and old successes cannot close it',async()=>{
  const first=await begin('failure-a'),second=await begin('failure-b'),old=await begin('old-success',OTHER)
  const a=await acquire(first),b=await acquire(second),late=await acquire(old)
  await outcome(first,a,false,'provider_timeout')
  assert.equal((await circuit()).open_until,null)
  await outcome(second,b,false,'provider_unavailable')
  const opened=await circuit();assert.ok(opened.seconds_left>28&&opened.seconds_left<=30)
  assert.equal((await acquire(old)).allowed,false)
  assert.equal((await outcome(old,late,true)).applied,false)
  assert.equal((await circuit()).generation,opened.generation)
  const denied=await acquire(await begin('cooldown'))
  assert.equal(denied.allowed,false);assert.ok(denied.retryAfterMs>27000)
  assert.deepEqual(await outcome(first,a,false,'provider_timeout'),{recorded:true,applied:true})
  assert.equal((await circuit()).generation,opened.generation)
})

test('half-open recovery permits only one request globally and a valid success restores primary',async()=>{
  await trip();await cooldownElapsed()
  const claims=await Promise.all([begin('probe-a'),begin('probe-b',OTHER),begin('probe-c')])
  const leases=await Promise.all(claims.map(c=>acquire(c)))
  assert.equal(leases.filter(l=>l.allowed).length,1)
  const i=leases.findIndex(l=>l.allowed),probe=leases[i]
  assert.ok(probe.probeToken)
  assert.equal((await outcome(claims[i],probe,true)).applied,true)
  const next=await acquire(await begin('recovered'))
  assert.equal(next.allowed,true);assert.equal(next.probeToken,null)
  assert.ok(next.generation>probe.generation)
  assert.equal((await circuit()).backoff_level,0)
})

test('abandoned probes expire and their late outcome cannot close a newer probe or circuit',async()=>{
  await trip();await cooldownElapsed()
  const old=await begin('expired-probe'),oldLease=await acquire(old)
  await db.exec("update translator_private.provider_circuits set probe_until=now()-interval '1 second'")
  assert.equal((await outcome(old,oldLease,true)).applied,false)
  const current=await begin('current-probe'),currentLease=await acquire(current)
  assert.equal(currentLease.allowed,true);assert.notEqual(currentLease.probeToken,oldLease.probeToken)
  assert.ok(currentLease.generation>oldLease.generation)
  await outcome(current,currentLease,false,'provider_timeout')
  const after=await circuit()
  assert.deepEqual(await outcome(old,oldLease,true),{recorded:true,applied:false})
  assert.equal((await circuit()).generation,after.generation)
  assert.ok(after.seconds_left>58&&after.seconds_left<=60)
})

test('persistent provider failures back off at most five minutes and are isolated by provider and model',async()=>{
  const initial=await begin('initial'),lease=await acquire(initial)
  await outcome(initial,lease,false,'provider_quota')
  assert.ok((await circuit()).seconds_left>298)
  for(const [i,seconds] of [60,120,240,300,300].entries()){
    await cooldownElapsed()
    const claim=await begin('backoff-'+i),probe=await acquire(claim)
    await outcome(claim,probe,false,'provider_rate_limit')
    const row=await circuit();assert.ok(row.seconds_left>seconds-2&&row.seconds_left<=seconds)
  }
  assert.equal((await acquire(await begin('backup'),backup)).allowed,true)
  const alternative={provider:'openai',model:'other-configured-model'}
  const other=await begin('other-model',OTHER,{...meta,requested_model:alternative.model,provider_plan:[alternative,backup]})
  assert.equal((await acquire(other,alternative)).allowed,true)
})

test('account, budget and local safety errors never degrade provider health',async()=>{
  for(const [i,error] of ['account_disabled','insufficient_characters','cost_limit','security_paused','invalid_request','send_blocked'].entries()){
    const claim=await begin('local-'+i),lease=await acquire(claim)
    assert.equal((await outcome(claim,lease,false,error)).applied,false)
  }
  const healthy=await circuit();assert.equal(healthy.failures,0);assert.equal(healthy.open_until,null)
  const claim=await begin('no-lease')
  await assert.rejects(outcome(claim,{allowed:true,generation:0,probeToken:null,retryAfterMs:0},true),/route_not_acquired/)
})

test('forged probe tokens and outcome generations are rejected without altering the circuit',async()=>{
  await trip();await cooldownElapsed()
  const claim=await begin('probe-identity'),lease=await acquire(claim),before=await circuit()
  await assert.rejects(outcome(claim,{...lease,generation:lease.generation+1},true),/request_id_conflict/)
  await assert.rejects(outcome(claim,{...lease,probeToken:randomUUID()},true),/request_id_conflict/)
  await assert.rejects(outcome({...claim,p_claim_token:randomUUID()},lease,true),/request_id_conflict/)
  assert.equal((await circuit()).generation,before.generation)
  assert.equal((await outcome(claim,lease,true)).applied,true)
})

test('message-specific output and generic request failures do not trip a shared circuit and safely release a half-open probe',async()=>{
  for(const [i,error] of ['provider_wrong_language','protected_literal_mismatch','provider_empty','provider_request'].entries()){
    const claim=await begin('content-failure-'+i),lease=await acquire(claim)
    assert.equal((await outcome(claim,lease,false,error)).applied,false)
  }
  const healthy=await circuit();assert.equal(healthy.failures,0);assert.equal(healthy.open_until,null)
  await trip();await cooldownElapsed()
  const probeClaim=await begin('content-probe'),probe=await acquire(probeClaim)
  const before=await circuit()
  assert.equal((await outcome(probeClaim,probe,false,'provider_wrong_language')).applied,false)
  const released=await circuit()
  assert.equal(released.failures,before.failures);assert.equal(released.backoff_level,before.backoff_level)
  assert.equal(released.probe_token,null);assert.equal(released.probe_until,null)
  const next=await acquire(await begin('next-content-probe',OTHER))
  assert.equal(next.allowed,true);assert.ok(next.probeToken);assert.ok(next.generation>probe.generation)
  assert.equal((await outcome(probeClaim,probe,false,'provider_wrong_language')).applied,false)
  assert.equal((await circuit()).probe_token,next.probeToken)
})

test('normal lease outcomes after request expiry remain immutable but cannot reset or worsen provider health',async()=>{
  const lateSuccess=await begin('late-success'),lateFailure=await begin('late-failure'),current=await begin('current-failure',OTHER)
  const successLease=await acquire(lateSuccess),failureLease=await acquire(lateFailure),currentLease=await acquire(current)
  await outcome(current,currentLease,false,'provider_timeout')
  const before=await circuit();assert.equal(before.failures,1);assert.equal(before.open_until,null)
  await db.exec("update translator_private.translation_requests set expires_at=now()-interval '1 second' where request_id in ('late-success','late-failure')")
  assert.deepEqual(await outcome(lateSuccess,successLease,true),{recorded:true,applied:false})
  assert.deepEqual(await outcome(lateFailure,failureLease,false,'provider_auth'),{recorded:true,applied:false})
  const after=await circuit()
  assert.equal(after.generation,before.generation);assert.equal(after.failures,1);assert.equal(after.open_until,null)
  assert.deepEqual(await outcome(lateSuccess,successLease,true),{recorded:true,applied:false})
  assert.deepEqual(await outcome(lateFailure,failureLease,false,'provider_auth'),{recorded:true,applied:false})
  await assert.rejects(outcome(lateFailure,failureLease,true),/operation_conflict/)
  const records=(await db.query<{outcome_applied:boolean}>('select outcome_applied from translator_private.provider_route_leases where request_id in ($1,$2)',['late-success','late-failure'])).rows
  assert.equal(records.length,2);assert.ok(records.every(row=>row.outcome_applied===false))
})
