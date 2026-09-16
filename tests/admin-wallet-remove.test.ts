import {after,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,rpc,USER,OTHER} from './fixture.ts'
import {validateMutation,handleAdmin,AdminError,type AdminServices} from '../server/worker/src/admin.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>{await db.close()})
beforeEach(async()=>{await db.exec('delete from public.admin_audit');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const read=async(kind:string,filter={},actor=USER)=>(await asRole<{r:any}>(db,'service_role','select public.admin_read($1,$2,$3::jsonb) r',[actor,kind,JSON.stringify(filter)])).rows[0].r
const mutate=async(action:string,data:Record<string,unknown>,op=randomUUID(),actor=USER,reason='更正重复充值')=>(await asRole<{r:any}>(db,'service_role','select public.admin_mutate($1,$2,$3,$4,$5,$6::jsonb) r',[actor,op,action,OTHER,reason,JSON.stringify(data)])).rows[0].r
const remove=(amount=25,expectedBalance=100,op=randomUUID(),actor=USER)=>mutate('wallet.remove',{amount,expectedBalance},op,actor)
const snapshot=()=>rpc(db,'account_snapshot',{p_user_id:OTHER})

test('administrative reduction updates shared balance once without inflating translation consumption',async()=>{
  const result=await remove(), state=await snapshot()
  assert.equal(result.balanceBefore,100);assert.equal(result.balanceAfter,75);assert.equal(result.characters,-25)
  assert.equal(state.wallet.balance,75);assert.equal(state.wallet.lifetime_credited,100)
  assert.equal(state.wallet.lifetime_debited,0);assert.equal(state.wallet.lifetime_adjusted_down,25)
  assert.equal(state.reconciliation.translationDebit,0);assert.equal(state.reconciliation.usageCharacters,0)
  assert.equal(state.usage.length,0);assert.equal(state.ledger.length,1);assert.equal(state.ledger[0].type,'adjustment')
  const audit=(await read('audit')).rows[0]
  assert.equal(audit.action,'wallet.remove');assert.equal(audit.reason,'更正重复充值');assert.equal(audit.actor_id,USER)
  assert.equal(state.wallet.balance,state.wallet.lifetime_credited-state.wallet.lifetime_debited-state.wallet.lifetime_adjusted_down)
})

test('duplicate clicks, transport retries and lookup retain one adjustment and one audit',async()=>{
  const op=randomUUID(),results=await Promise.all(Array.from({length:10},()=>remove(25,100,op)))
  assert.ok(results.every(r=>r.balanceAfter===75));assert.equal(results.filter(r=>r.replayed).length,9)
  assert.equal((await read('operation',{operationId:op})).result.balanceAfter,75)
  assert.equal((await snapshot()).ledger.length,1);assert.equal((await read('audit')).rows.length,1)
  await assert.rejects(remove(26,100,op),/operation_conflict/)
  await assert.rejects(mutate('wallet.add',{amount:25},op),/operation_conflict/)
})

test('removal preserves in-flight translation reservations and allows exact available amount',async()=>{
  const claim=randomUUID()
  await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:'reserved',p_payload_hash:'a'.repeat(64),p_characters:80,p_claim_token:claim,p_metadata:{}})
  await assert.rejects(remove(21),/insufficient_available/)
  await remove(20)
  const reserved=await snapshot();assert.equal(reserved.wallet.balance,80);assert.equal(reserved.wallet.reserved_characters,80)
  await rpc(db,'complete_translation',{p_user_id:OTHER,p_request_id:'reserved',p_claim_token:claim,p_translation:'test',p_model:'fixture',p_latency_ms:1})
  const done=await snapshot();assert.equal(done.wallet.balance,0);assert.equal(done.wallet.lifetime_debited,80)
  assert.equal(done.wallet.lifetime_adjusted_down,20);assert.equal(done.reconciliation.translationDebit,80)
  assert.equal(done.reconciliation.mismatchedRequests,0)
})

test('stale balances and overdrafts do not journal or change the wallet',async()=>{
  await mutate('wallet.add',{amount:1})
  await assert.rejects(remove(5,100),/stale_balance/)
  await assert.rejects(remove(102,101),/insufficient_available/)
  assert.equal((await snapshot()).wallet.balance,101);assert.equal((await snapshot()).wallet.lifetime_adjusted_down,0)
  assert.equal((await read('audit')).rows.length,1)
  await remove(101,101);assert.equal((await snapshot()).wallet.balance,0)
})

test('independent reductions based on the same displayed balance cannot both apply',async()=>{
  const results=await Promise.allSettled([remove(60),remove(60)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult
  assert.match(String(rejected.reason),/stale_balance/)
  const state=await snapshot();assert.equal(state.wallet.balance,40);assert.equal(state.wallet.lifetime_adjusted_down,60)
  assert.equal((await read('audit')).rows.length,1)
})

test('both add and remove are server-authorized; public callers and revoked roles cannot mutate',async()=>{
  for(const role of ['anon','authenticated'] as const)await assert.rejects(asRole(db,role,"select public.admin_mutate($1,$2,'wallet.remove',$3,'测试扣减','{\"amount\":1,\"expectedBalance\":100}')",[USER,randomUUID(),OTHER]),/permission denied/)
  await assert.rejects(remove(1,100,randomUUID(),OTHER),/admin_forbidden/)
  await db.query("insert into public.admin_roles(user_id,role) values($1,'support')",[OTHER])
  await assert.rejects(remove(1,100,randomUUID(),OTHER),/admin_forbidden/)
  await assert.rejects(mutate('wallet.add',{amount:1},randomUUID(),OTHER),/admin_forbidden/)
  await db.query("update public.profiles set status='blocked' where id=$1",[USER])
  await assert.rejects(remove(),/admin_forbidden/)
  assert.equal((await snapshot()).wallet.balance,100)
})

test('API and SQL reject malformed reductions, unexpected fields and missing reasons',async()=>{
  const body={operationId:randomUUID(),action:'wallet.remove',target:OTHER,reason:'更正重复充值',data:{amount:25,expectedBalance:100}}
  assert.equal(validateMutation(body).action,'wallet.remove')
  for(const data of [{amount:-1,expectedBalance:100},{amount:0,expectedBalance:100},{amount:1.5,expectedBalance:100},{amount:'1',expectedBalance:100},{amount:1},{amount:1,expectedBalance:-1},{amount:1,expectedBalance:100,actor:USER},{amount:1000000001,expectedBalance:100}]){
    assert.throws(()=>validateMutation({...body,data}),/invalid_request/)
    await assert.rejects(mutate('wallet.remove',data),/invalid_request/)
  }
  await assert.rejects(mutate('wallet.remove',body.data,randomUUID(),USER,'  '),/invalid_request/)
  assert.equal((await read('audit')).rows.length,0)
})

test('preexisting additions and signed adjustment operations keep idempotency and correct counters',async()=>{
  const op=randomUUID();await mutate('wallet.add',{amount:30},op);await mutate('wallet.add',{amount:30},op)
  await mutate('wallet.adjust',{amount:-10,expectedBalance:130})
  await mutate('wallet.adjust',{amount:5,expectedBalance:120})
  const state=await snapshot();assert.equal(state.wallet.balance,125);assert.equal(state.wallet.lifetime_credited,135)
  assert.equal(state.wallet.lifetime_debited,0);assert.equal(state.wallet.lifetime_adjusted_down,10)
  assert.equal(state.ledger.length,3)
})

test('old recorded addition result can still be replayed after migration without a second credit',async()=>{
  const op=randomUUID(),data={amount:30},input={action:'wallet.add',target:OTHER,reason:'更正重复充值',data}
  await db.query('insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result) values($1,$2,$3,$4,$5,$6,$7,$8)',[op,USER,'owner','wallet.add',OTHER,input.reason,JSON.stringify(input),JSON.stringify({userId:OTHER,characters:30,balanceAfter:130})])
  const result=await mutate('wallet.add',data,op)
  assert.equal(result.replayed,true);assert.equal(result.balanceAfter,130);assert.equal((await snapshot()).wallet.balance,100)
  assert.equal((await snapshot()).ledger.length,0)
})

test('failed audit write rolls back the adjustment and ledger atomically',async()=>{
  await db.exec("create function translator_private.test_reject_remove() returns trigger language plpgsql as $$ begin if new.action='wallet.remove' then raise exception 'fixture_audit_failure';end if;return new;end $$; create trigger test_reject_remove before insert on public.admin_audit for each row execute function translator_private.test_reject_remove()")
  try{await assert.rejects(remove(),/fixture_audit_failure/);assert.equal((await snapshot()).wallet.balance,100);assert.equal((await snapshot()).ledger.length,0)}
  finally{await db.exec('drop trigger test_reject_remove on public.admin_audit; drop function translator_private.test_reject_remove()')}
})

test('gateway enforces recent MFA and approved origin before allowing a reduction',async()=>{
  const body={operationId:randomUUID(),action:'wallet.remove',target:OTHER,reason:'更正重复充值',data:{amount:25,expectedBalance:100}}
  let mfaAt=Date.now()/1000-1000,calls=0
  const services:AdminServices={origins:['https://admin.hellodog.net'],authenticate:async()=>({id:USER,aal:'aal2',mfaAt,enrolled:true,sessionId:randomUUID()}),rpc:async(name,args)=>{
    calls++;if(name!=='admin_mutate')throw new Error('unexpected');return mutate(String(args.p_action),args.p_data as Record<string,unknown>,String(args.p_operation) as ReturnType<typeof randomUUID>)
  }}
  const request=(origin='https://admin.hellodog.net')=>new Request('https://api.hellodog.net/api/admin/mutate',{method:'POST',headers:{Origin:origin,Authorization:'Bearer fixture', 'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await handleAdmin(request(),services)).status,403);assert.equal(calls,0)
  mfaAt=Date.now()/1000;assert.equal((await handleAdmin(request('https://other.invalid'),services)).status,403);assert.equal(calls,0)
  assert.equal((await handleAdmin(request(),services)).status,200);assert.equal(calls,1);assert.equal((await snapshot()).wallet.balance,75)
})
