import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,rpc,USER,OTHER} from './fixture.ts'
import {validateMutation} from '../server/worker/src/admin.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>{await db.close()})
beforeEach(async()=>{await db.exec('delete from public.admin_audit');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const read=async(kind:string,filter={},actor=USER)=>(await asRole<{r:any}>(db,'service_role','select public.admin_read($1,$2,$3::jsonb) r',[actor,kind,JSON.stringify(filter)])).rows[0].r
const note=async(text:string,revision=0,op=randomUUID(),actor=USER)=>(await asRole<{r:any}>(db,'service_role',"select public.admin_mutate($1,$2,'user.note',$3,'更新用户备注',$4::jsonb) r",[actor,op,OTHER,JSON.stringify({note:text,expectedRevision:revision})])).rows[0].r
test('notes are searchable, persist in detail, and never alter profile or wallet',async()=>{
 const before=await read('user',{userId:OTHER});await note('早期测试用户\n需要跟进');
 const after=await read('user',{userId:OTHER});assert.equal(after.profile.admin_note,'早期测试用户\n需要跟进');assert.equal(after.profile.note_revision,1)
 assert.equal(after.profile.username,before.profile.username);assert.deepEqual(after.wallet,before.wallet)
 const result=await read('users',{q:'需要跟进'});assert.equal(result.rows.length,1);assert.equal(result.rows[0].id,OTHER)
 assert.equal(JSON.stringify(await rpc(db,'account_snapshot',{p_user_id:OTHER})).includes('需要跟进'),false)
 assert.equal((await db.query('select * from public.character_ledger')).rows.length,0)
})
test('duplicate saves and lost-response retries produce one revision and audit',async()=>{
 const op=randomUUID();const results=await Promise.all(Array.from({length:6},()=>note('same',0,op)));assert.ok(results.every(r=>r.revision===1))
 assert.equal((await db.query('select * from public.admin_audit')).rows.length,1)
 await assert.rejects(note('different',0,op),/operation_conflict/)
 await assert.rejects(note('stale',0),/stale_note/);assert.equal((await read('user',{userId:OTHER})).profile.admin_note,'same')
 await note('',1);assert.equal((await read('user',{userId:OTHER})).profile.admin_note,'');assert.equal((await read('user',{userId:OTHER})).profile.note_revision,2)
})
test('ordinary users cannot read or edit notes, and no public profile field exposes them',async()=>{
 await note('private');for(const role of ['anon','authenticated'] as const){await assert.rejects(asRole(db,role,'select * from translator_private.user_notes'),/permission denied/);await assert.rejects(asRole(db,role,"select public.admin_read($1,'users','{}')",[USER]),/permission denied/)}
 await assert.rejects(read('users',{},OTHER),/admin_forbidden/);await assert.rejects(note('forged',1,randomUUID(),OTHER),/admin_forbidden/)
 await db.query("insert into public.admin_roles(user_id,role) values($1,'support')",[OTHER]);await assert.rejects(note('support edit',1,randomUUID(),OTHER),/admin_forbidden/)
})
test('both API and database reject oversized notes and unexpected fields',async()=>{
 const body={operationId:randomUUID(),action:'user.note',target:OTHER,reason:'更新用户备注',data:{note:'',expectedRevision:0}}
 assert.equal(validateMutation(body).action,'user.note');assert.throws(()=>validateMutation({...body,data:{...body.data,note:'x'.repeat(1001)}}));assert.throws(()=>validateMutation({...body,data:{...body.data,balance:1000}}))
 await assert.rejects(note('x'.repeat(1001)),/invalid_request/)
 await note('<img src=x onerror=alert(1)>');assert.equal((await read('user',{userId:OTHER})).profile.admin_note,'<img src=x onerror=alert(1)>')
})
