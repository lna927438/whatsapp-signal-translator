import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,reset,asRole,rpc,USER,OTHER} from './fixture.ts'
import {validateMutation} from '../server/worker/src/admin.ts'
import {noticeReceiptBody} from '../server/worker/src/clientNotices.ts'
import worker,{type Env} from '../server/worker/src/index.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>{await db.close()})
beforeEach(async()=>{await db.exec('delete from public.admin_audit;delete from public.announcements');await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])})
const data=(patch={})=>({title:'服务通知',body:'您的客户端消息中心已启用。',level:'info',active:true,starts_at:new Date(Date.now()-10000).toISOString(),ends_at:'',popup:true,audience:'all',recipient:'',action:'none',expectedRevision:0,...patch})
const save=async(d:any,id=randomUUID(),op=randomUUID(),actor=USER)=>(await asRole<{r:any}>(db,'service_role',"select public.admin_mutate($1,$2,'notice.save',$3,'发送客户端通知',$4::jsonb) r",[actor,op,id,JSON.stringify(d)])).rows[0].r
const feed=async(user=USER)=> (await rpc(db,'client_notices',{p_user_id:user})).notices as any[]
const receipt=async(id:string,state='displayed',revision=1,user=USER)=>rpc(db,'client_notice_receipt',{p_user_id:user,p_notice_id:id,p_revision:revision,p_state:state})
const list=async()=> (await asRole<{r:any}>(db,'service_role',"select public.admin_read($1,'announcements','{}') r",[USER])).rows[0].r.rows as any[]

test('recipient targeting applies to feeds, direct RLS reads and receipt writes',async()=>{
 const all=await save(data()),own=await save(data({audience:'user',recipient:' FIRST@EXAMPLE.INVALID '}))
 assert.equal((await feed()).length,2);assert.deepEqual((await feed(OTHER)).map(n=>n.id),[all.announcement])
 const direct=await asRole<any>(db,'authenticated','select id from public.announcements',[],OTHER)
 assert.deepEqual(direct.rows.map(n=>n.id),[all.announcement]);assert.equal((await receipt(own.announcement,'displayed',1,OTHER)).accepted,false)
 for(const role of ['anon','authenticated'] as const){await assert.rejects(asRole(db,role,'select public.client_notices($1)',[USER]),/permission denied/);await assert.rejects(asRole(db,role,'select * from translator_private.announcement_receipts'),/permission denied/)}
 await assert.rejects(save(data(),randomUUID(),randomUUID(),OTHER),/admin_forbidden/)
})
test('scheduled, expired, paused and blocked-user notices are not delivered',async()=>{
 await save(data({starts_at:new Date(Date.now()+3600000).toISOString()}));await save(data({ends_at:new Date(Date.now()-5000).toISOString()}));await save(data({active:false}));assert.equal((await feed()).length,0)
 const n=await save(data());assert.equal((await feed()).length,1)
 await db.query("update public.profiles set status='blocked' where id=$1",[USER]);await assert.rejects(feed(),/account_disabled/);await assert.rejects(receipt(n.announcement),/account_disabled/)
})
test('retrieval does not fabricate display counts; duplicate display/dismiss receipts are idempotent',async()=>{
 const n=await save(data());await feed();assert.equal((await list())[0].displayed_count,0)
 await receipt(n.announcement,'dismissed');assert.equal((await list())[0].displayed_count,0);assert.equal((await list())[0].dismissed_count,1)
 await Promise.all(Array.from({length:5},()=>receipt(n.announcement)));await receipt(n.announcement,'dismissed')
 const rows=await list();assert.equal(rows[0].displayed_count,1);assert.equal(rows[0].dismissed_count,1)
 const f=(await feed())[0];assert.equal(f.displayed,true);assert.equal(f.dismissed,true)
 assert.equal((await db.query<{n:number}>('select count(*)::int n from translator_private.announcement_receipts')).rows[0].n,1)
})
test('save retries, edits and revocation preserve revision boundaries',async()=>{
 const id=randomUUID(),op=randomUUID(),d=data();const values=await Promise.all(Array.from({length:4},()=>save(d,id,op)))
 assert.ok(values.every(v=>v.revision===1));assert.equal((await db.query<{n:number}>('select count(*)::int n from public.admin_audit')).rows[0].n,1)
 await assert.rejects(save({...d,title:'different'},id,op),/operation_conflict/);await assert.rejects(save(d,id),/stale_notice/)
 await receipt(id);await save({...d,title:'edited',expectedRevision:1},id);assert.equal((await feed())[0].displayed,false)
 assert.equal((await receipt(id,'displayed',1)).accepted,false);assert.equal((await list())[0].displayed_count,0)
 await save({...d,active:false,expectedRevision:2},id);assert.equal((await feed()).length,0);assert.equal((await receipt(id,'displayed',3)).accepted,false)
})
test('new API validation rejects forged recipients, arbitrary actions, oversized input and invalid dates',async()=>{
 const body={operationId:randomUUID(),action:'notice.save',target:randomUUID(),reason:'发送客户端通知',data:data()};validateMutation(body)
 for(const patch of [{recipient:'unknown',audience:'user'},{action:'https://evil.invalid'},{body:'x'.repeat(3001)},{popup:'yes'},{expectedRevision:-1},{starts_at:'bad'},{ends_at:'2020-01-01'}])assert.throws(()=>validateMutation({...body,data:data(patch)}))
 await assert.rejects(save(data({audience:'user',recipient:'missing@example.invalid'})),/invalid_recipient/)
 await assert.rejects(save(data({body:'x'.repeat(3001)})),/invalid_request/)
 await save(data({body:'<script>alert(1)</script>'}));assert.equal((await feed())[0].body,'<script>alert(1)</script>')
 const valid={id:randomUUID(),revision:1,state:'displayed'},req=(v:any)=>new Request('https://fixture.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)})
 assert.deepEqual(await noticeReceiptBody(req(valid)),valid)
 for(const v of [{...valid,user:OTHER},{...valid,state:'sent'}, {...valid,revision:0},{...valid,id:'x'},{...valid,padding:'x'.repeat(2000)},null])assert.equal(await noticeReceiptBody(req(v)),null)
})
test('worker binds every feed and receipt to the authenticated user, ignoring query impersonation',async()=>{
 const all=await save(data()),own=await save(data({audience:'user',recipient:'first@example.invalid'})),original=globalThis.fetch
 const env:Env={API_RATE_LIMITER:{limit:async()=>({success:true})},SUPABASE_URL:'https://db.invalid',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SECRET_KEY:'service',OPENAI_MODEL:'fixture'}
 const reply=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}})
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,env.SUPABASE_URL)
  if(url.pathname==='/auth/v1/user'){const token=new Headers(init?.headers).get('Authorization');return token==='Bearer other'?reply({id:OTHER}):reply({},401)}
  if(url.pathname==='/rest/v1/profiles')return reply((await asRole(db,'service_role','select * from public.profiles where id=$1',[url.searchParams.get('id')!.slice(3)])).rows)
  if(url.pathname.startsWith('/rest/v1/rpc/'))return reply(await rpc(db,url.pathname.split('/').at(-1)!,JSON.parse(String(init?.body))))
  throw new Error('Unexpected network')
 }
 try{
  const request=(path:string,body?:any,auth=true)=>worker.fetch(new Request('https://worker.invalid'+path,{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer other'}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env)
  const got=await request('/api/notices?userId='+USER);assert.equal(got.status,200);assert.deepEqual((await got.json() as any).notices.map((n:any)=>n.id),[all.announcement])
  assert.equal((await request('/api/notices',undefined,false)).status,401)
  assert.equal((await request('/api/notices/receipt',{id:own.announcement,revision:1,state:'displayed'}).then(r=>r.json()) as any).accepted,false)
  assert.equal((await request('/api/notices/receipt',{id:all.announcement,revision:1,state:'displayed',userId:USER})).status,400)
 }finally{globalThis.fetch=original}
})
