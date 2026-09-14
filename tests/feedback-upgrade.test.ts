import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {generateKeyPairSync,sign} from 'node:crypto'
import {updateSigningBytes,verifyUpdateSignature} from '../src/shared/updateSignature.ts'
import {mainHarness} from './main-harness.ts'
import {captureProviderReceipt,providerReceipt} from '../server/worker/src/providerUsage.ts'
const manifest={version:'0.5.4',versionKey:'windows/v0.5.4/setup.exe',sha256:'a'.repeat(64),size:1234,notes:'new'}
test('version order handles stable, beta and RC without recommending downgrades',()=>{
 const h=mainHarness();try{const {compareVersions, supportsProtectedRecords}=h.load('src/main/updates.ts');for(const [a,b,expected] of [['0.5.4','0.5.3',1],['0.5.4','0.5.4-beta.2',1],['0.5.4-beta.10','0.5.4-beta.2',1],['0.5.4-beta.2','0.5.4-rc.1',-1],['0.5.3','0.5.4-beta.2',-1],['v0.5.4','0.5.4',0],['unknown','0.5.4',undefined]])assert.equal(compareVersions(a,b),expected);assert.equal(supportsProtectedRecords('0.5.3-rc.2'),true)}finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('automatic update notices coalesce, remember snooze across restart, and retain verified downloads',async()=>{
 const pair=generateKeyPairSync('ed25519'),trust={keys:{fixture:pair.publicKey.export({type:'spki',format:'pem'}).toString()},windowsPublisherSubjects:[]}
 const input={...manifest,schemaVersion:1 as const,channel:'stable' as const,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}
 const signed={...input,signature:{algorithm:'Ed25519' as const,keyId:'fixture',value:sign(null,updateSigningBytes(input),pair.privateKey).toString('base64')}}
 let calls=0,dir='';const h=mainHarness({app:{getPath:()=>dir,getVersion:()=> '0.5.3'}},async()=>{calls++;await new Promise(r=>setTimeout(r,5));return new Response(JSON.stringify(signed))},{'./updateTrust':{trustedUpdate:async(v:unknown)=>verifyUpdateSignature(v,trust)}});dir=h.directory;try{
 h.load('src/main/updates.ts');const {UpdateManager}=h.load('src/main/updates.ts');const u=new UpdateManager();
 // Harness app identity is an explicit fixture, never an installed user profile.
 const {JsonStore}=h.load('src/main/storage/jsonStore.ts');await new JsonStore('update-state.json',{}).write({manifest:signed,phase:'verified'});
 const notices=await Promise.all([u.notice(),u.notice(),u.notice()]);assert.ok(notices.every(n=>n.show));assert.equal(calls,1)
 await u.snooze('0.5.4');assert.equal((await new UpdateManager().notice()).show,false);assert.equal(calls,1);assert.equal((await u.info()).phase,'verified')
 assert.equal((await u.check('stable')).version,'0.5.4');assert.equal((await u.info()).phase,'verified')
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('account notes survive storage round trips without changing account identity',async()=>{
 const h=mainHarness();try{const {AccountManager}=h.load('src/main/accounts/accountManager.ts');const m=new AccountManager();const a=await m.add('whatsapp','Main');await m.update(a.id,{note:'Family'});const saved=(await new AccountManager().list())[0];assert.equal(saved.label,'Main');assert.equal(saved.note,'Family');assert.equal(saved.id,a.id);await assert.rejects(m.update(a.id,{note:'x'.repeat(81)}));await m.update(a.id,{note:''});assert.equal((await m.list())[0].note,'')}finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('history keeps its frozen context and only an explicit new request changes translation options',async()=>{
 const h=mainHarness();try{const {MessageRequests}=h.load('src/main/translation/messageRequests.ts');const m=new MessageRequests();const r={cacheUserId:'owner',accountId:'a',messageId:'peer-message',text:'hello',targetLanguage:'zh-CN'};
 const original=await m.prepare(r),restored=await m.prepare({...r,quality:{tone:'business'}});assert.equal(original.requestId,restored.requestId);
 const manual=await new MessageRequests().prepare({...r,requestId:'manual-explicit-new',quality:{tone:'business'}});assert.notEqual(manual.requestId,original.requestId);assert.equal(manual.quality.tone,'business');
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('API counters use the actual Responses or Chat Completions fields, never character estimates',()=>{
 const now=Date.now(),r=providerReceipt('deepseek-flash');captureProviderReceipt(r,{created:Math.floor(now/1000),usage:{prompt_tokens:100,prompt_cache_hit_tokens:40,completion_tokens:20,total_tokens:120}},new Response('{}'),now,now);assert.equal(r.inputTokens,100);assert.equal(r.cachedTokens,40);assert.equal(r.outputTokens,20);assert.equal(r.totalTokens,120);assert.ok(r.createdAt)
 const broken=providerReceipt('x');captureProviderReceipt(broken,{usage:{input_tokens:10,output_tokens:2,total_tokens:999,input_tokens_details:{cached_tokens:1}}},new Response('{}'),now,now);assert.equal(broken.inputTokens,null);assert.equal(broken.cachedTokens,null)
})
