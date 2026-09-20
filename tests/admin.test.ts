import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, reset, asRole, rpc, USER, OTHER } from './fixture.ts'
import { AdminError, handleAdmin, validateMutation } from '../server/worker/src/admin.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()})
after(async()=>{await db?.close()})
beforeEach(async()=>{await db.exec('delete from public.admin_audit');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
async function read(kind:string,filter:Record<string,unknown>={},actor=USER){
  return (await asRole<{r:any}>(db,'service_role','select public.admin_read($1,$2,$3::jsonb) r',[actor,kind,JSON.stringify(filter)])).rows[0].r
}
async function mutate(action:string,target=OTHER,data:Record<string,unknown>={},op=randomUUID(),actor=USER){
  return (await asRole<{r:any}>(db,'service_role','select public.admin_mutate($1,$2,$3,$4,$5,$6::jsonb) r',[actor,op,action,target,'本地回归测试',JSON.stringify(data)])).rows[0].r
}
async function charge(id='original'){
  const claim=randomUUID()
  await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:id,p_payload_hash:'a'.repeat(64),p_characters:7,p_claim_token:claim,p_metadata:{}})
  await rpc(db,'complete_translation',{p_user_id:OTHER,p_request_id:id,p_claim_token:claim,p_translation:'private translated body',p_model:'fixture',p_latency_ms:4})
  return (await read('translations')).rows.find((row:any)=>row.request_id===id)
}
test('unprivileged database clients cannot call admin RPCs, even with a real owner ID',async()=>{
  for(const role of ['anon','authenticated'] as const){
    await assert.rejects(asRole(db,role,"select public.admin_read($1,'users','{}')",[USER]),/permission denied/)
    await assert.rejects(asRole(db,role,"select public.admin_mutate($1,$2,'wallet.adjust',$3,'test','{}')",[USER,randomUUID(),OTHER]),/permission denied/)
    await assert.rejects(asRole(db,role,'select * from public.admin_audit'),/permission denied/)
  }
})
test('ordinary accounts and revoked admins fail closed; user metadata cannot grant admin',async()=>{
  await db.query(`update auth.users set raw_user_meta_data='{"role":"owner"}' where id=$1`,[OTHER])
  await assert.rejects(read('users',{},OTHER),/admin_forbidden/)
  await db.query("update public.profiles set status='blocked' where id=$1",[USER])
  await assert.rejects(read('overview'),/admin_forbidden/)
})
test('roles restrict money and content operations on the server',async()=>{
  await db.query("insert into public.admin_roles(user_id,role) values($1,'support')",[OTHER])
  assert.equal((await read('users',{},OTHER)).rows.length,2)
  await assert.rejects(mutate('wallet.adjust',USER,{amount:5,expectedBalance:100},randomUUID(),OTHER),/admin_forbidden/)
  await assert.rejects(read('roles',{},OTHER),/admin_forbidden/)
})
test('repeated and concurrent adjustment clicks create exactly one debit and audit record',async()=>{
  const id=randomUUID(), args={amount:50,expectedBalance:100}
  const result=await Promise.all(Array.from({length:12},()=>mutate('wallet.adjust',OTHER,args,id)))
  assert.ok(result.every(r=>r.balanceAfter===150))
  assert.equal((await read('user',{userId:OTHER})).wallet.balance,150)
  assert.equal((await db.query('select * from public.admin_audit')).rows.length,1)
  assert.equal((await db.query('select * from public.character_ledger')).rows.length,1)
  await assert.rejects(mutate('wallet.adjust',OTHER,{amount:60,expectedBalance:100},id),/operation_conflict/)
})
test('stale displayed balance and reserved money cannot be overwritten',async()=>{
  await mutate('wallet.adjust',OTHER,{amount:1,expectedBalance:100})
  await assert.rejects(mutate('wallet.adjust',OTHER,{amount:1,expectedBalance:100}),/stale_balance/)
  await db.query('update public.wallets set reserved_characters=90 where user_id=$1',[OTHER])
  await assert.rejects(mutate('wallet.adjust',OTHER,{amount:-12,expectedBalance:101}),/insufficient_available/)
  assert.equal((await read('user',{userId:OTHER})).wallet.balance,101)
})
test('refund references one original debit and cannot happen twice with different operation IDs',async()=>{
  const row=await charge()
  assert.equal(row.reconciliation,'matched');assert.equal(row.charged,7)
  await mutate('translation.refund',row.ledger_id)
  await assert.rejects(mutate('translation.refund',row.ledger_id),/already_refunded/)
  const updated=(await read('translations')).rows[0]
  assert.equal(updated.refunded,7);assert.equal(updated.charged,7)
  assert.equal((await read('user',{userId:OTHER})).wallet.balance,100)
  assert.ok(!JSON.stringify(updated).includes('private translated body'))
})
test('request reconciliation detects equal totals with mismatched individual requests',async()=>{
  await charge('first');await charge('second')
  await db.exec("update public.translation_usage set source_characters=case when request_id='first' then 8 else 6 end")
  assert.equal((await read('translations',{status:'mismatch'})).rows.length,2)
})
test('pending/failed requests with a debit and mismatched original character counts are flagged',async()=>{
  await charge('changed-source')
  // Manufacture legacy corruption in this isolated database. Normal service-role
  // writes now reject changes to the immutable source/billable contract.
  await db.transaction(async tx=>{
    await tx.exec('alter table translator_private.translation_requests disable trigger a_repair_character_contract')
    await tx.exec("update translator_private.translation_requests set source_characters=8,billable_characters=8 where request_id='changed-source'")
    await tx.exec('alter table translator_private.translation_requests enable trigger a_repair_character_contract')
  })
  assert.equal((await read('translations')).rows[0].reconciliation,'mismatch')
  await db.transaction(async tx=>{
    await tx.exec('alter table translator_private.translation_requests disable trigger a_repair_character_contract')
    await tx.exec("update translator_private.translation_requests set source_characters=7,billable_characters=7,state='processing' where request_id='changed-source'")
    await tx.exec('alter table translator_private.translation_requests enable trigger a_repair_character_contract')
  })
  assert.equal((await read('translations')).rows[0].reconciliation,'mismatch')
})
test('manual orders snapshot the plan; confirm payment once and keep failed changes atomic',async()=>{
  const order=await mutate('order.create',OTHER,{plan_code:'starter'})
  await db.exec("update public.plans set included_characters=250000 where code='starter'")
  const id=randomUUID()
  const first=await mutate('order.settle',order.orderId,{reference:'fixture-receipt'},id)
  assert.equal(first.characters,100000)
  assert.equal((await mutate('order.settle',order.orderId,{reference:'fixture-receipt'},id)).replayed,true)
  await assert.rejects(mutate('order.settle',order.orderId,{reference:'second-receipt'}),/order_final/)
  const order2=await mutate('order.create',OTHER,{plan_code:'starter'})
  await assert.rejects(mutate('order.settle',order2.orderId,{reference:'fixture-receipt'}),/duplicate key/)
  assert.equal((await db.query<{s:string}>('select status as s from public.orders where id=$1',[order2.orderId])).rows[0].s,'pending')
})
test('cancelling pending orders does not credit characters and third party orders stay protected',async()=>{
  const order=await mutate('order.create',OTHER,{plan_code:'starter'})
  await mutate('order.cancel',order.orderId)
  assert.equal((await read('user',{userId:OTHER})).wallet.balance,100)
  const order2=await mutate('order.create',OTHER,{plan_code:'starter'})
  await db.query("update public.orders set provider='stripe' where id=$1",[order2.orderId])
  await assert.rejects(mutate('order.settle',order2.orderId,{reference:'thirdparty'}),/external_order/)
})
test('last owner cannot be removed, self disabled, or modified by another admin',async()=>{
  await assert.rejects(mutate('role.set',USER,{role:'none'}),/last_owner/)
  await assert.rejects(mutate('user.update',USER,{status:'blocked',plan_code:'free'}),/self_disable/)
  await mutate('role.set',OTHER,{role:'admin'})
  await assert.rejects(mutate('role.set',USER,{role:'none'},randomUUID(),OTHER),/admin_forbidden/)
  await assert.rejects(mutate('user.update',USER,{status:'blocked',plan_code:'free'},randomUUID(),OTHER),/admin_forbidden/)
})
test('disabling an account is enforced by existing translation RPCs',async()=>{
  await mutate('user.update',OTHER,{status:'blocked',plan_code:'starter'})
  await assert.rejects(rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:'blocked-send',p_payload_hash:'a'.repeat(64),p_characters:5,p_claim_token:randomUUID(),p_metadata:{}}),/account_disabled/)
})
test('search handles punctuation literally and pagination is deterministic',async()=>{
  assert.equal((await read('users',{q:"') or true --"})).rows.length,0)
  for(let i=0;i<30;i++)await db.query('insert into auth.users(id,email) values($1,$2)',[randomUUID(),`page-${i}@example.invalid`])
  const a=await read('users'),b=await read('users',{offset:25})
  assert.equal(a.rows.length,25);assert.equal(a.hasMore,true);assert.equal(b.rows.length,7)
  assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,32)
})
test('audit records cannot be changed by the service role',async()=>{
  await mutate('wallet.adjust',OTHER,{amount:1,expectedBalance:100})
  await assert.rejects(asRole(db,'service_role',"update public.admin_audit set reason='changed'"),/permission denied/)
  await assert.rejects(asRole(db,'service_role','delete from public.admin_audit'),/permission denied/)
})
test('lost responses can be queried by operation ID without repeating the write',async()=>{
  const id=randomUUID();const result=await mutate('wallet.adjust',OTHER,{amount:10,expectedBalance:100},id)
  const status=await read('operation',{operationId:id})
  assert.equal(status.found,true);assert.deepEqual(status.result,result)
  assert.equal((await read('operation',{operationId:randomUUID()})).found,false)
  await mutate('role.set',OTHER,{role:'admin'})
  assert.equal((await read('operation',{operationId:id},OTHER)).found,false)
  assert.equal((await read('user',{userId:OTHER})).wallet.balance,110)
})
test('versions and announcements store drafts with safe publication validation',async()=>{
  await mutate('version.save','1.2.3-beta.1',{channel:'beta',url:'',sha256:'',notes:'test draft',active:false})
  assert.equal((await read('versions')).rows[0].active,false)
  await assert.rejects(mutate('version.save','1.2.3-beta.2',{channel:'beta',url:'',sha256:'',notes:'',active:true}),/invalid_release/)
  const id=randomUUID()
  await mutate('announcement.save',id,{title:'Test',body:'Plain text',level:'info',active:false,starts_at:new Date().toISOString(),ends_at:''})
  assert.equal((await read('announcements')).rows[0].title,'Test')
  await assert.rejects(mutate('announcement.save',id,{title:'Test',body:'Plain text',level:'info',active:false,starts_at:'2026-09-10T00:00:00Z',ends_at:'2026-09-09T00:00:00Z'}),/invalid_request/)
})
test('editor can change content, but cannot read wallets or change a financial plan',async()=>{
  await mutate('role.set',OTHER,{role:'editor'})
  await mutate('version.save','1.2.4-beta.1',{channel:'beta',url:'',sha256:'',notes:'draft',active:false},randomUUID(),OTHER)
  await assert.rejects(read('users',{},OTHER),/admin_forbidden/)
  await assert.rejects(mutate('plan.save','special',{name:'Special',characters:100,price:99,currency:'USD',active:true},randomUUID(),OTHER),/admin_forbidden/)
})
test('mutation API rejects malformed, unsafe or unbounded input before SQL',()=>{
  const b={operationId:randomUUID(),action:'wallet.adjust',target:OTHER,reason:'测试调整',data:{amount:5,expectedBalance:100}}
  assert.equal(validateMutation(b).data.amount,5)
  for(const data of [{amount:1.1,expectedBalance:100},{amount:0,expectedBalance:100},{amount:5},{amount:5,expectedBalance:100,actor:USER}])
    assert.throws(()=>validateMutation({...b,data}),/invalid_request/)
  assert.throws(()=>validateMutation({...b,action:'version.save',target:'0.5.2-beta.8',data:{channel:'stable',active:false,url:'',sha256:'',notes:''}}))
  assert.throws(()=>validateMutation({...b,action:'version.save',target:'1.0.0',data:{channel:'stable',active:true,url:'javascript:alert(1)',sha256:'a'.repeat(64),notes:''}}))
})
test('API checks authentication, cross-origin requests, and never reflects raw database failures',async()=>{
  const services={origins:['http://localhost:5174'],authenticate:async(t:string)=>{if(t!=='test')throw new AdminError('unauthorized');return {id:USER,aal:'aal2' as const,mfaAt:Date.now()/1000,enrolled:true,sessionId:randomUUID()}},rpc:async()=>{throw new Error('SECRET server details')}}
  const call=(headers:Record<string,string>)=>handleAdmin(new Request('http://localhost/api/admin/users',{headers}),services)
  assert.equal((await call({})).status,401)
  assert.equal((await call({Authorization:'Bearer test',Origin:'https://attacker.invalid'})).status,403)
  const r=await call({Authorization:'Bearer test',Origin:'http://localhost:5174'})
  assert.equal(r.status,503);assert.ok(!(await r.text()).includes('SECRET'));assert.equal(r.headers.get('Cache-Control'),'no-store')
})
