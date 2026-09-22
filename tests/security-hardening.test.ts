import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { authenticatedClaims, mfaRequired } from '../server/worker/src/adminSecurity.ts'
import { handleAdmin, supabaseAdminServices } from '../server/worker/src/admin.ts'
import { boundedJson } from '../server/worker/src/requestSecurity.ts'
import { updateSigningBytes, verifyUpdateSignature, type SignedUpdate } from '../src/shared/updateSignature.ts'
import { database, reset, rpc, asRole, USER, OTHER, wallet } from './fixture.ts'
import { mainHarness } from './main-harness.ts'

const now=Date.now()/1000
const claims=(patch:Record<string,unknown>={})=>({sub:USER,iss:'https://test.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',aal:'aal2',amr:[{method:'totp',timestamp:now}],session_id:randomUUID(),iat:now-5,exp:now+3600,...patch})
const jwt=(value:unknown)=>Buffer.from('{"alg":"RS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(value)).toString('base64url')+'.test-signature'
const verifiedUser={id:USER,factors:[{factor_type:'totp',status:'verified'}]}
test('admin MFA uses verified root claims and recent TOTP, never user_metadata or refresh time',()=>{
  const good=authenticatedClaims(jwt(claims()),verifiedUser,'https://test.supabase.co',now)
  assert.equal(mfaRequired(good,true,now),false)
  for(const patch of [{aal:'aal1',user_metadata:{aal:'aal2'}},{amr:[{method:'recovery',timestamp:now}]},{amr:[{method:'totp',timestamp:now-601},{method:'token_refresh',timestamp:now}]}]){
    assert.equal(mfaRequired(authenticatedClaims(jwt(claims(patch)),verifiedUser,'https://test.supabase.co',now),true,now),true)
  }
  for(const patch of [{sub:OTHER},{iss:'https://evil.invalid/auth/v1'},{exp:now-1},{role:'service_role'},{is_anonymous:true}])assert.throws(()=>authenticatedClaims(jwt(claims(patch)),verifiedUser,'https://test.supabase.co',now))
})
test('every admin host and write endpoint rejects missing or stale MFA before a mutation',async()=>{
  for(const host of ['admin.hellodog.net','api.hellodog.net','realtime-translator-api.lna927438.workers.dev']){
    for(const age of [null,now-601]){
      let calls=0
      const response=await handleAdmin(new Request('https://'+host+'/api/admin/mutate',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{}'}),{
        origins:[],authenticate:async()=>({id:USER,aal:age?'aal2':'aal1',mfaAt:age,enrolled:true,sessionId:randomUUID()}),rpc:async()=>{calls++;return {}}
      })
      assert.equal(response.status,403);assert.equal(calls,0)
    }
  }
})
test('revoked administrator sessions fail even while a JWT remains unexpired',async()=>{
  const original=globalThis.fetch;let databaseCalls=0
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-public',SUPABASE_SECRET_KEY:'fixture-service'}
  try{
    globalThis.fetch=async(url)=>{const path=new URL(String(url)).pathname;if(path==='/auth/v1/user')return Response.json(verifiedUser);databaseCalls++;assert.equal(path,'/rest/v1/rpc/admin_session_active');return Response.json(false)}
    await assert.rejects(supabaseAdminServices(env).authenticate(jwt(claims())),/unauthorized/);assert.equal(databaseCalls,1)
    globalThis.fetch=async()=>new Response('{}',{status:401})
    await assert.rejects(supabaseAdminServices(env).authenticate(jwt(claims())),/unauthorized/)
  }finally{globalThis.fetch=original}
})
test('oversized and malformed translation streams are rejected before parsing',async()=>{
  for(const value of ['x'.repeat(70000),'{invalid'])await assert.rejects(boundedJson(new Request('https://local.invalid',{method:'POST',headers:{'content-type':'application/json'},body:value})),/invalid_request/)
  await assert.rejects(boundedJson(new Request('https://local.invalid',{method:'POST',body:'{}'})),/invalid_request/)
  assert.deepEqual(await boundedJson(new Request('https://local.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{"text":"hello"}'})),{text:'hello'})
})
test('release signatures bind every field and reject expiration, tampering and unknown keys',()=>{
  const keys=generateKeyPairSync('ed25519'),issued=Date.now()
  const value={schemaVersion:1 as const,version:'0.5.8',versionKey:'windows/v0.5.8/Setup.exe',sha256:'a'.repeat(64),size:1234,channel:'stable' as const,notes:'HelloDog security',issuedAt:new Date(issued).toISOString(),expiresAt:new Date(issued+86400000).toISOString()}
  const signature={algorithm:'Ed25519' as const,keyId:'local-test-only',value:sign(null,updateSigningBytes(value),keys.privateKey).toString('base64')}
  const trust={keys:{'local-test-only':keys.publicKey.export({type:'spki',format:'pem'}).toString()},windowsPublisherSubjects:[]}
  const signed:SignedUpdate={...value,signature}
  assert.equal(verifyUpdateSignature(signed,trust,issued).version,'0.5.8')
  for(const change of [{version:'0.5.9'},{sha256:'b'.repeat(64)},{size:1235},{channel:'beta'},{versionKey:'windows/v0.5.8/evil.exe'},{notes:'edited'}])assert.throws(()=>verifyUpdateSignature({...signed,...change},trust,issued))
  assert.throws(()=>verifyUpdateSignature(value,trust,issued));assert.throws(()=>verifyUpdateSignature(signed,{keys:{},windowsPublisherSubjects:[]},issued));assert.throws(()=>verifyUpdateSignature(signed,trust,issued+86400001))
})
test('IPC rejects other accounts, navigated main windows and subframes, while allowing the correct chat',()=>{
  const handlers=new Map<string,Function>(),frame={url:new URL('../src/renderer/index.html',import.meta.url).href},sender={id:1,mainFrame:frame}
  const h=mainHarness({app:{isPackaged:true}}),api=h.load('src/main/secureIpc.ts').createSecureIpc({handle:(k:string,fn:Function)=>handlers.set(k,fn),on:()=>{}},{webContents:sender},{ownsSender:(account:string,id:number)=>account==='owned'&&id===2})
  api.handle('settings:get',()=>42);api.handle('translator:translate-incoming',()=>43)
  assert.equal(handlers.get('settings:get')!({sender,senderFrame:frame}),42)
  assert.throws(()=>handlers.get('settings:get')!({sender,senderFrame:{url:frame.url}}))
  const old=frame.url;frame.url='https://evil.invalid';assert.throws(()=>handlers.get('settings:get')!({sender,senderFrame:frame}));frame.url=old
  const waFrame={url:'https://web.whatsapp.com/'},wa={id:2,mainFrame:waFrame},event={sender:wa,senderFrame:waFrame}
  assert.equal(handlers.get('translator:translate-incoming')!(event,'owned',{}),43)
  assert.throws(()=>handlers.get('translator:translate-incoming')!(event,'another',{}));assert.throws(()=>handlers.get('settings:get')!(event))
  const policy=h.load('src/main/securityPolicy.ts')
  for(const url of ['file:///C:/Windows/a.exe','javascript:alert(1)','ms-msdt:/id','https://user:password@hello.invalid','mailto:a@b.invalid?attach=C:/secret'])assert.equal(policy.externalUrl(url),null)
  assert.equal(policy.externalUrl('https://hellodog.net/download'),'https://hellodog.net/download')
})
test('settings migrate secrets away from preferences, redact them, and fail closed without encryption',async()=>{
  let encryption=true
  const h=mainHarness({safeStorage:{isEncryptionAvailable:()=>encryption,encryptString:(text:string)=>Buffer.from(text),decryptString:(value:Buffer)=>value.toString()}})
  const {SettingsStore}=h.load('src/main/storage/settingsStore.ts'),store=new SettingsStore()
  writeFileSync(h.directory+'/settings.sec','plain:'+Buffer.from(JSON.stringify({provider:'deepl',deeplApiKey:'local-fixture-key',closeBehaviorVersion:1})).toString('base64'))
  await store.migrateLegacySecrets()
  const settings=readFileSync(h.directory+'/settings.sec','utf8');assert.ok(settings.startsWith('enc:'));assert.ok(!Buffer.from(settings.slice(4),'base64').toString().includes('local-fixture-key'))
  assert.equal((await store.publicSettings()).deeplApiKey,undefined);assert.equal((await store.get()).provider,'openai')
  await store.save(await store.publicSettings());assert.equal((await store.get()).deeplApiKey,undefined)
  encryption=false;await assert.rejects(store.save({provider:'deepl',deeplApiKey:'should-not-write'}),/加密/)
  assert.equal((await store.publicSettings()).deeplApiKey,undefined)
})
test('remembered login migrates only after encrypted persistence succeeds and never falls back to localStorage',async()=>{
  const {SecureAuthStorage}=mainHarness().load('src/renderer/src/lib/secureAuthStorage.ts')
  const values=new Map<string,string>(),temporary=new Map<string,string>(),secure=new Map<string,string>()
  const wrap=(map:Map<string,string>)=>({getItem:(key:string)=>map.get(key)??null,setItem:(key:string,v:string)=>{map.set(key,v)},removeItem:(key:string)=>{map.delete(key)}})
  let fail=true;const key='sb-fixture-auth-token';values.set(key,'private-session')
  const store=new SecureAuthStorage(wrap(values),wrap(temporary),{authStorageGet:async(k:string)=>secure.get(k)??null,authStorageSet:async(k:string,v:string|null)=>{if(fail)throw new Error('encryption unavailable');if(v===null)secure.delete(k);else secure.set(k,v)}})
  await assert.rejects(store.getItem(key));assert.equal(values.get(key),'private-session')
  fail=false;assert.equal(await store.getItem(key),'private-session');assert.equal(values.has(key),false);assert.equal(secure.get(key),'private-session')
  store.setRemember(false);await store.setItem(key,'temporary');assert.equal(secure.has(key),false);assert.equal(temporary.get(key),'temporary')
  await store.clearSession();assert.equal(await store.getItem(key),null)
})

let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()});after(async()=>db?.close())
beforeEach(async()=>{await reset(db);await db.exec('update translator_private.security_policy set user_daily_usd=5,global_daily_usd=50,user_concurrency=8,user_requests_per_minute=60,enabled=true')})
const start=(id:string,user=USER,metadata:Record<string,unknown>={})=>rpc(db,'begin_translation',{p_user_id:user,p_request_id:id,p_payload_hash:'a'.repeat(64),p_characters:1,p_claim_token:randomUUID(),p_metadata:metadata})
test('desktop CAPTCHA callbacks require the official origin, main flow nonce and bounded token',()=>{
 const {captchaCallback}=mainHarness().load('src/main/authChallenge.ts'),nonce='a'.repeat(32)
 const url='https://hellodog.net/security-check#'+new URLSearchParams({nonce,token:'fixture-token'})
 assert.equal(captchaCallback(url,nonce),'fixture-token')
 for(const invalid of [url.replace('hellodog.net','evil.invalid'),url.replace('/security-check','/login'),url.replace('nonce='+nonce,'nonce=wrong'),url.replace('fixture-token','x'.repeat(4097)),url.replace('https:','http:')])assert.equal(captchaCallback(invalid,nonce),null)
})
test('global and per-user budgets reject new costs atomically, preserve wallets and replay existing IDs',async()=>{
  await db.exec('update translator_private.security_policy set global_daily_usd=1')
  await start('first');const before=await wallet(db)
  await assert.rejects(start('second',OTHER),/cost_limit/);assert.deepEqual(await wallet(db),before)
  assert.equal((await start('first') as {state:string}).state,'processing')
  assert.equal((await db.query<{n:number}>('select count(*)::int n from translator_private.cost_reservations')).rows[0].n,1)
})
test('concurrent new requests obey limits and rejected requests do not reserve characters',async()=>{
  await db.exec('update translator_private.security_policy set user_concurrency=2')
  const results=await Promise.allSettled([start('a'),start('b'),start('c'),start('d')])
  assert.equal(results.filter(v=>v.status==='fulfilled').length,2)
  assert.equal((await wallet(db)).reserved_characters,2);assert.equal((await wallet(db)).lifetime_debited,0)
})
test('security tables and session RPCs are inaccessible to ordinary authenticated users',async()=>{
  for(const role of ['anon','authenticated'] as const){
    for(const table of ['security_policy','security_events','api_rate_windows','cost_reservations'])await assert.rejects(asRole(db,role,'select * from translator_private.'+table),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.admin_session_active($1,$2)',[USER,randomUUID()]),/permission denied/)
    await assert.rejects(asRole(db,role,'select public.security_housekeeping()'),/permission denied/)
  }
})
test('auth session revocation and disabled owners invalidate administration immediately',async()=>{
  const sid=randomUUID();await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[sid,USER])
  const valid=async()=>(await asRole<{valid:boolean}>(db,'service_role','select public.admin_session_active($1,$2) valid',[USER,sid])).rows[0].valid
  assert.equal(await valid(),true);await db.query("update public.profiles set status='blocked' where id=$1",[USER]);assert.equal(await valid(),false)
  await db.query("update public.profiles set status='active' where id=$1",[USER]);await db.query('delete from auth.sessions where id=$1',[sid]);assert.equal(await valid(),false)
})
