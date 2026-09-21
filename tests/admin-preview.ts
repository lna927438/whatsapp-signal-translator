// Local demonstration host only. Never imported into the production Worker or website.
// Real admin RPCs and PostgreSQL execute here; only the identity service is a fixture.
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname, relative } from 'node:path'
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { database, asRole, rpc } from './fixture.ts'
import { handleAdmin, AdminError, type AdminServices } from '../server/worker/src/admin.ts'

const repo=fileURLToPath(new URL('../',import.meta.url))
const port=Number(process.env.HELLODOG_ADMIN_PREVIEW_PORT||5174)
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port')
const origin=`http://127.0.0.1:${port}`
const directory=resolve(repo,'verification',process.env.HELLODOG_ADMIN_PREVIEW_DATA||'admin-preview','data')
if(!directory.startsWith(resolve(repo,'verification')+'\\') && !directory.startsWith(resolve(repo,'verification')+'/'))throw new Error('Test database must stay inside verification')
await mkdir(directory,{recursive:true})
const db=await database(directory)
const actors:Record<string,string>={owner:'20000000-0000-4000-8000-000000000001',admin:'20000000-0000-4000-8000-000000000002',support:'20000000-0000-4000-8000-000000000003',finance:'20000000-0000-4000-8000-000000000004',editor:'20000000-0000-4000-8000-000000000005',user:'20000000-0000-4000-8000-000000000006'}
const seeded=(await db.query<{n:number}>('select count(*)::integer n from auth.users')).rows[0].n
if(!seeded){
  const names=['owner','admin','support','finance','editor','user']
  await db.transaction(async tx=>{
    for(const role of names){await tx.query('insert into auth.users(id,email) values($1,$2)',[actors[role],`${role}@example.invalid`]);if(role!=='user')await tx.query('insert into public.admin_roles(user_id,role) values($1,$2)',[actors[role],role])}
    for(let i=1;i<=38;i++){
      const id=`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`
      await tx.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,`customer${String(i).padStart(2,'0')}@example.invalid`,JSON.stringify({username:`测试用户 ${String(i).padStart(2,'0')}`})])
      await tx.query("update public.profiles set plan_code=$2,status=$3,created_at=now()-$4*interval '1 hour' where id=$1",[id,i%3===0?'pro':'starter',i%9===0?'blocked':'active',i])
      const balance=50000+i*1700
      await tx.query('update public.wallets set balance=$2,lifetime_credited=$2 where user_id=$1',[id,balance])
      await tx.query("insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,source) values($1,'bonus',$2,$2,'local-initial','local-preview')",[id,balance])
      if(i%2)await tx.query("insert into public.devices(user_id,device_fingerprint,device_name,platform,app_version,last_seen_at) values($1,$2,$3,'Windows','0.5.2-beta.8',now()-$4*interval '1 hour')",[id,`local-${i}`,`Windows 测试设备 ${i}`,i%5])
    }
    await tx.exec("update public.plans set price_cents=case when code='starter' then 990 when code='pro' then 4990 else 0 end")
  })
  for(let i=1;i<=32;i++){
    const user=`30000000-0000-4000-8000-${String(i%8+1).padStart(12,'0')}`,id=`local-example-${String(i).padStart(3,'0')}`,claim=randomUUID()
    await rpc(db,'begin_translation',{p_user_id:user,p_request_id:id,p_payload_hash:'b'.repeat(64),p_characters:10+i*3,p_claim_token:claim,p_metadata:{source_language:'zh-CN',target_language:'en',provider:'fixture'}})
    if(i%7===0)await rpc(db,'fail_translation',{p_user_id:user,p_request_id:id,p_claim_token:claim,p_error_code:'provider_timeout'})
    else if(i%11!==0)await rpc(db,'complete_translation',{p_user_id:user,p_request_id:id,p_claim_token:claim,p_translation:'Local sample. Not a real chat.',p_model:'local-sample',p_latency_ms:90+i*12})
  }
  // A deliberately inconsistent example demonstrates detection, clearly local only.
  await db.exec("update public.translation_usage set source_characters=source_characters+2 where request_id='local-example-003'")
  await db.query("insert into public.orders(user_id,provider,plan_code,amount_cents,currency,characters) values($1,'manual','starter',990,'USD',100000),($2,'manual','pro',4990,'USD',1000000)",['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'])
  await db.exec("insert into public.app_versions(version,channel,release_notes,active) values('0.5.2-beta.8','beta','修复 Signal 输入和 WhatsApp 翻译显示。本地测试记录。',false),('0.5.1','stable','稳定版记录示例。',false)")
  await db.exec("insert into public.announcements(title,body,active) values('欢迎使用 HelloDog 管理后台','这是一条本地样例公告，可编辑和保存。',false)")
}
// Explicit opt-in fixture: these factors and endpoints never exist in production.
const testMfa=process.env.HELLODOG_ADMIN_TEST_MFA==='1'
if (testMfa) await db.exec('update translator_private.security_policy set user_daily_usd=5,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60')
const testSecret='JBSWY3DPEHPK3PXP'
let testEnrolled=false
const tokens=new Map<string,{actor:string;expires:number;mfaAt:number;attempts:number;attemptWindow:number}>()
function validTestCode(code:string){
  if(!/^\d{6}$/.test(code))return false
  const key=Buffer.from('48656c6c6f21deadbeef','hex')
  const tick=Math.floor(Date.now()/30000)
  return [-1,0,1].some(delta=>{const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(tick+delta));const hash=createHmac('sha1',key).update(counter).digest();const offset=hash[19]&15;const expected=String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');return timingSafeEqual(Buffer.from(code),Buffer.from(expected))})
}
const signatures={admin_read:['p_actor','p_kind','p_filter'],admin_mutate:['p_actor','p_operation','p_action','p_target','p_reason','p_data'],admin_security_overview:['p_actor'],admin_overview:['p_actor']}
const services:AdminServices={
  origins:[origin],
  async authenticate(token){const session=tokens.get(token);if(!session||session.expires<Date.now())throw new AdminError('unauthorized');return {id:session.actor,aal:!testMfa||session.mfaAt?'aal2':'aal1',mfaAt:testMfa?session.mfaAt:Date.now()/1000,enrolled:!testMfa||testEnrolled,sessionId:token.slice(0,36)}},
  async rpc(name,args){
    try{const params=signatures[name];const result=await asRole<{r:unknown}>(db,'service_role',`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) r`,params.map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]));return result.rows[0].r}
    catch(e){const error=e as {code?:string;message?:string};throw new AdminError(error.code==='23505'?'duplicate_reference':error.message||'unavailable')}
  }
}
const publicDir=resolve(repo,'website/dist-admin-local')
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'}
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}` || req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return}
    const url=new URL(req.url||'/',origin)
    if(url.pathname==='/__local/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'hellodog-admin-local',sampleData:true}));return}
    const chunks:Buffer[]=[];let bytes=0
    for await(const raw of req){const chunk=Buffer.from(raw);bytes+=chunk.length;if(bytes>24576){res.writeHead(413);res.end();return}chunks.push(chunk)}
    const body=Buffer.concat(chunks)
    if(url.pathname==='/__local/login' && req.method==='POST'){
      if(req.headers.origin!==origin){res.writeHead(403);res.end();return}
      const role=JSON.parse(body.toString()).role as string
      if(!actors[role]){res.writeHead(400);res.end();return}
      for(const [key,s] of tokens)if(s.expires<Date.now())tokens.delete(key)
      const token=randomUUID()+randomUUID();tokens.set(token,{actor:actors[role],expires:Date.now()+8*3600000,mfaAt:0,attempts:0,attemptWindow:Date.now()});res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({token}));return
    }
    if(testMfa && url.pathname.startsWith('/__local/mfa/') && req.method==='POST'){
      const session=tokens.get(String(req.headers.authorization||'').replace(/^Bearer /,''))
      if(req.headers.origin!==origin||!session||session.expires<Date.now()||session.actor!==actors.owner){res.writeHead(403);res.end('{}');return}
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
      if(url.pathname==='/__local/mfa/enroll'){
        if(testEnrolled){res.writeHead(409);res.end('{}');return}
        const qr=await createRequire(resolve(repo,'package.json'))('qrcode').toDataURL(`otpauth://totp/HelloDog%20LOCAL:owner%40example.invalid?secret=${testSecret}&issuer=HelloDog%20LOCAL`)
        res.end(JSON.stringify({factorId:'local-only',qr,secret:testSecret}));return
      }
      if(url.pathname==='/__local/mfa/verify'){
        if(Date.now()-session.attemptWindow>60000){session.attempts=0;session.attemptWindow=Date.now()}
        if(++session.attempts>5){res.writeHead(429);res.end('{}');return}
        if(!validTestCode(String(JSON.parse(body.toString()).code||''))){res.writeHead(400);res.end('{}');return}
        testEnrolled=true;session.mfaAt=Date.now()/1000;res.end('{}');return
      }
      if(url.pathname==='/__local/mfa/expire'){session.mfaAt=Date.now()/1000-660;res.end('{}');return}
      res.writeHead(404);res.end('{}');return
    }
    if(url.pathname==='/__local/logout' && req.method==='POST'){tokens.delete(String(req.headers.authorization||'').replace(/^Bearer /,''));res.end('{}');return}
    if(url.pathname.startsWith('/api/admin/')){
      const headers=new Headers();for(const [key,v] of Object.entries(req.headers))if(v)headers.set(key,Array.isArray(v)?v.join(','):v)
      const request=new Request(url,{method:req.method,headers,...(body.length?{body}: {})})
      const response=await handleAdmin(request,services);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return
    }
    if(req.method!=='GET'){res.writeHead(405);res.end();return}
    const path=resolve(publicDir,'.'+decodeURIComponent(url.pathname));const rel=relative(publicDir,path)
    if(rel.startsWith('..') || rel.includes(':')){res.writeHead(403);res.end();return}
    let content:Buffer,extension=extname(path)
    try{content=await readFile(path)}catch{if(extension){res.writeHead(404);res.end();return}content=await readFile(resolve(publicDir,'index.html'));extension='.html'}
    res.setHeader('Content-Type',mime[extension]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    res.end(content)
  }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'local_preview_error',message:'本地服务发生错误，请重新打开测试后台。'}))}
})
server.listen(port,'127.0.0.1',()=>console.log(`HelloDog local admin ready: ${origin}/admin`))
async function shutdown(){server.close();await db.close();process.exit(0)}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown())
