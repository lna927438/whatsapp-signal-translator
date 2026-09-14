import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto'
import {updateSigningBytes} from '../src/shared/updateSignature.ts'
import {PGlite} from '@electric-sql/pglite'
import {database,reset,wallet,rpc,USER,OTHER,asRole} from './fixture.ts'
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {mainHarness} from './main-harness.ts'
const require=createRequire(import.meta.url)
const {encryptBackup,decryptBackup}=require('../src/shared/backupEncryption.ts')
test('encrypted database recovery restores wallet, financial ledger and request identifiers exactly',async()=>{
 const db=await database();let restored:PGlite|undefined
 try{
  await reset(db);await rpc(db,'begin_translation',{p_user_id:USER,p_request_id:'restore-proof',p_payload_hash:'c'.repeat(64),p_characters:15,p_claim_token:'20000000-0000-4000-8000-000000000099',p_metadata:{}})
  const sql='select user_id::text,type,characters,balance_after,idempotency_key from public.character_ledger order by created_at,id'
  const before={wallet:await wallet(db),ledger:(await db.query(sql)).rows,requests:(await db.query('select user_id::text,request_id,state from translator_private.translation_requests order by request_id')).rows}
  const dump=Buffer.from(await (await db.dumpDataDir('gzip')).arrayBuffer()),secret=randomBytes(32),encrypted=encryptBackup(dump,secret)
  assert.equal(encrypted.includes(Buffer.from('restore-proof')),false)
  assert.throws(()=>decryptBackup(encrypted,randomBytes(32)),/authentication failed/)
  const tampered=Buffer.from(encrypted);tampered[tampered.length-1]^=1;assert.throws(()=>decryptBackup(tampered,secret),/authentication failed/)
  const bytes=decryptBackup(encrypted,secret);restored=new PGlite({loadDataDir:new Blob([bytes])});await restored.waitReady
  const after={wallet:await wallet(restored),ledger:(await restored.query(sql)).rows,requests:(await restored.query('select user_id::text,request_id,state from translator_private.translation_requests order by request_id')).rows}
  assert.deepEqual(after,before);secret.fill(0);bytes.fill(0);dump.fill(0)
 }finally{await restored?.close();await db.close()}
})
test('installer verification requires a valid timestamp and exact authorized publisher',()=>{
 const h=mainHarness();const {validWindowsSignature}=h.load('src/main/updateTrust.ts'),trust={keys:{},windowsPublisherSubjects:['CN=HelloDog Test']}
 assert.equal(validWindowsSignature({status:'Valid',timestamped:true,subject:'CN=HelloDog Test'},trust),true)
 for(const result of [{status:'NotSigned',timestamped:true,subject:'CN=HelloDog Test'},{status:'Valid',timestamped:false,subject:'CN=HelloDog Test'},{status:'Valid',timestamped:true,subject:'CN=HelloDog Test Attacker'},null])assert.equal(validWindowsSignature(result,trust),false)
})

test('packaged update trust is read from the application archive rather than adjacent resources', async()=>{
 let appPath=''
 const h=mainHarness({app:{isPackaged:true,getAppPath:()=>appPath}})
 appPath=h.directory+'/app.asar'
 mkdirSync(appPath+'/resources/security',{recursive:true})
 mkdirSync(h.directory+'/security',{recursive:true})
 const included={keys:{included:'fixture-public-key'},windowsPublisherSubjects:['CN=Expected Publisher']}
 writeFileSync(appPath+'/resources/security/update-trust.json',JSON.stringify(included))
 writeFileSync(h.directory+'/security/update-trust.json',JSON.stringify({keys:{adjacent:'untrusted'},windowsPublisherSubjects:['CN=Wrong Publisher']}))
 assert.deepEqual(JSON.parse(JSON.stringify(await h.load('src/main/updateTrust.ts').loadUpdateTrust())),included)
})

test('owner-authorized unsigned installers still require a trusted manifest and exact file bytes',async()=>{
 let appPath=''
 const h=mainHarness({app:{isPackaged:true,getAppPath:()=>appPath}})
 appPath=h.directory+'/app.asar'
 mkdirSync(appPath+'/resources/security',{recursive:true})
 const pair=generateKeyPairSync('ed25519'),bytes=Buffer.from('unsigned installer fixture'),file=h.directory+'/installer.exe'
 const trust={keys:{release:pair.publicKey.export({type:'spki',format:'pem'}).toString()},windowsPublisherSubjects:[],windowsInstallerPolicy:'signed-manifest'}
 writeFileSync(appPath+'/resources/security/update-trust.json',JSON.stringify(trust));writeFileSync(file,bytes)
 const value={schemaVersion:1 as const,version:'0.5.8',versionKey:'windows/v0.5.8/HelloDog-Setup-v0.5.8.exe',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,channel:'stable' as const,notes:'Security and Signal improvements',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}
 const signed={...value,signature:{algorithm:'Ed25519' as const,keyId:'release',value:sign(null,updateSigningBytes(value),pair.privateKey).toString('base64')}}
 const {verifyWindowsInstaller}=h.load('src/main/updateTrust.ts')
 await verifyWindowsInstaller(file,signed)
 await assert.rejects(verifyWindowsInstaller(file))
 await assert.rejects(verifyWindowsInstaller(file,{...signed,notes:'tampered'}))
 await assert.rejects(verifyWindowsInstaller(file,{...signed,signature:{...signed.signature,keyId:'unknown'}}))
 writeFileSync(file,Buffer.from('tampered installer fixture'))
 await assert.rejects(verifyWindowsInstaller(file,signed),/不匹配/)
 writeFileSync(file,bytes)
 writeFileSync(appPath+'/resources/security/update-trust.json',JSON.stringify({...trust,windowsInstallerPolicy:'authenticode'}))
 await assert.rejects(verifyWindowsInstaller(file,signed),/发行者尚未配置/)
 writeFileSync(appPath+'/resources/security/update-trust.json',JSON.stringify({...trust,windowsInstallerPolicy:'invalid'}))
 await assert.rejects(verifyWindowsInstaller(file,signed),/策略无效/)
})

test('cloud content erasure requires ownership, preserves billing and cannot be replayed as a different operation',async()=>{
 const db=await database()
 try{
  await reset(db);await db.query("insert into public.admin_roles(user_id,role) values($1,'owner')",[USER])
  const claim=randomUUID(),operation=randomUUID()
  await rpc(db,'begin_translation',{p_user_id:OTHER,p_request_id:'erase-test',p_payload_hash:'a'.repeat(64),p_characters:5,p_claim_token:claim,p_metadata:{}})
  const erase=(actor=USER,reason='用户申请清理')=>asRole<{r:any}>(db,'service_role',"select public.admin_mutate($1,$2,'user.clear-content',$3,$4,'{}') r",[actor,operation,OTHER,reason])
  await assert.rejects(erase(),/content_pending/)
  await rpc(db,'complete_translation',{p_user_id:OTHER,p_request_id:'erase-test',p_claim_token:claim,p_translation:'private fixture content',p_model:'test',p_latency_ms:1})
  const before=(await db.query('select * from public.wallets order by user_id')).rows,ledger=(await db.query('select * from public.character_ledger order by id')).rows
  await assert.rejects(erase(OTHER),/admin_forbidden/)
  assert.equal((await erase()).rows[0].r.clearedResponses,1);assert.equal((await erase()).rows[0].r.replayed,true)
  await assert.rejects(erase(USER,'不同操作原因'),/operation_conflict/)
  const result=await db.query<{response:any}>('select response from translator_private.translation_requests where request_id=$1',['erase-test'])
  assert.equal(result.rows[0].response.contentExpired,true);assert.equal(result.rows[0].response.translation,undefined)
  assert.deepEqual((await db.query('select * from public.wallets order by user_id')).rows,before);assert.deepEqual((await db.query('select * from public.character_ledger order by id')).rows,ledger)
 }finally{await db.close()}
})

test('legacy private records are encrypted on read without losing concurrent writes',async()=>{
 const h=mainHarness(),{JsonStore}=h.load('src/main/storage/jsonStore.ts'),path=h.directory+'/translation-cache.json'
 writeFileSync(path,JSON.stringify({old:true}));const store=new JsonStore('translation-cache.json',{})
 assert.deepEqual(JSON.parse(JSON.stringify(await store.read())),{old:true});assert.ok(readFileSync(path,'utf8').startsWith('hellodog-encrypted-v1:'))
 writeFileSync(path,JSON.stringify({old:true}));await Promise.all([store.read(),store.write({new:true})]);assert.deepEqual(JSON.parse(JSON.stringify(await store.read())),{new:true})
})
