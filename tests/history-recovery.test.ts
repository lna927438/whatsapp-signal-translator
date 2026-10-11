import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {mainHarness} from './main-harness.ts'

const request={text:'Thought about bitcoin at $1.00 😬😬😬',accountId:'wa',conversationId:'peer',messageId:'false_peer@c.us_one',sourceLanguage:'auto',targetLanguage:'zh-CN'}
function fixture(){
 const h=mainHarness(),{TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),{TranslationOutcomeError}=h.load('src/main/translation/providers/cloudflare.ts')
 let calls=0,failures=0;const ids:string[]=[]
 const create=()=>{const e=new TranslationEngine();e.setOnlineSession('owner','fixture');e.settings.get=async()=>({provider:'openai'});e.createProvider=()=>({translate:async(r:any)=>{
  calls++;ids.push(r.requestId);await new Promise(resolve=>setTimeout(resolve,5));
  if(failures-->0)throw new TranslationOutcomeError('云端已确认未扣费。',true);
  await e.receipts.update('owner',r.requestId,{state:'charged',translated:'当时考虑过一美元的比特币 😬😬😬',chargedCharacters:Array.from(r.text).length,balanceAfter:900});return '当时考虑过一美元的比特币 😬😬😬';
 }});return e;};
 return {...h,create,ids,get calls(){return calls},setFailures:(value:number)=>{failures=value}};
}
test('confirmed uncharged history failure recovers once across concurrent scans and stays cached after restart',async()=>{
 const h=fixture();try{
  h.setFailures(1);const e=h.create();await assert.rejects(e.translateIncoming(request),/未扣费/);
  const results=await Promise.all(Array.from({length:10},()=>e.translateIncoming(request)));
  assert.equal(new Set(results).size,1);assert.equal(h.calls,2);assert.equal(new Set(h.ids).size,2);
  const records=await e.history();assert.equal(records.filter((r:any)=>r.state==='charged').length,1);assert.equal(records.filter((r:any)=>r.state==='failed')[0].chargedCharacters,0);
  const reopened=h.create();await reopened.translateIncoming({...request,conversationId:'renamed',context:[]});await reopened.clearCache();await reopened.translateIncoming(request);assert.equal(h.calls,2);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('history recovery limits each burst and manual Retry remains usable without retrying completed work',async()=>{
 const h=fixture();try{
  h.setFailures(10);let e=h.create();
  for(let i=0;i<6;i++){await assert.rejects(e.translateIncoming(request));if(i===2)e=h.create();}
  assert.equal(h.calls,3);h.setFailures(0);await e.translateIncoming(request,true);assert.equal(h.calls,4);
  await e.translateIncoming(request,true);assert.equal(h.calls,4);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('exhausted automatic history retries recover after cooldown across restart with one charge',async()=>{
 const h=fixture(),realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
  h.setFailures(3);let e=h.create();
  for(let i=0;i<6;i++)await assert.rejects(e.translateIncoming(request));
  assert.equal(h.calls,3);await e.flush();e=h.create();clock+=299999;
  await assert.rejects(e.translateIncoming(request));assert.equal(h.calls,3);
  clock+=1;const results=await Promise.all(Array.from({length:10},()=>e.translateIncoming(request)));
  assert.equal(h.calls,4);assert.equal(new Set(results).size,1);
  assert.equal((await e.history()).filter((r:any)=>r.state==='charged').length,1);
  await e.flush();await h.create().translateIncoming(request);assert.equal(h.calls,4);
 }finally{Date.now=realNow;rmSync(h.directory,{recursive:true,force:true})}
})

test('an old lifetime-capped receipt is eligible again without clearing history or changing its content',async()=>{
 const h=fixture(),realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
  const e=h.create(),old={...request,requestId:'message-retry-old',historyRetryCount:2,cacheUserId:'owner'};
  await e.receipts.prepare('owner','openai',old);await e.receipts.update('owner',old.requestId,{state:'failed',chargedCharacters:0});
  await assert.rejects(e.translateIncoming(old));assert.equal(h.calls,0);
  clock+=300001;await e.translateIncoming(old);assert.equal(h.calls,1);
  await e.translateIncoming(old);assert.equal(h.calls,1);
 }finally{Date.now=realNow;rmSync(h.directory,{recursive:true,force:true})}
})

test('only an authoritative not-found result may reopen an exhausted missing-request window',async()=>{
 const h=fixture(),realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
  let e=h.create();const prepared=await e.messageRequests.prepare({...request,cacheUserId:'owner'});
  await e.receipts.prepare('owner','openai',prepared);await e.receipts.update('owner',prepared.requestId,{state:'pending'});
  for(let i=0;i<3;i++){
   e.cloudProvider=()=>({status:async()=>({state:'not_found'})});e.createProvider=()=>({translate:async()=>{throw Error('reply lost')}});
   await assert.rejects(e.translateIncoming(request));
  }
  assert.equal((await e.receipts.get('owner',prepared.requestId)).missingRetries,2);
  await e.flush();e=h.create();clock+=300001;e.cloudProvider=()=>({status:async()=>({state:'processing'})});
  await assert.rejects(e.translateIncoming(request));assert.equal(h.calls,0);
  e.cloudProvider=()=>({status:async()=>({state:'not_found'})});await e.translateIncoming(request);
  assert.equal(h.calls,1);assert.equal(h.ids[0],prepared.requestId);
 }finally{Date.now=realNow;rmSync(h.directory,{recursive:true,force:true})}
})
test('an unknown history outcome or an outgoing failure cannot create a replacement API request',async()=>{
 const h=fixture();try{
  const e=h.create(),prepared=await e.messageRequests.prepare({...request,cacheUserId:'owner'});
  await e.receipts.prepare('owner','openai',prepared);await e.receipts.update('owner',prepared.requestId,{state:'pending'});e.reconcilePending=async()=>{};
  await assert.rejects(e.translateIncoming(request),/待确认/);assert.equal(h.calls,0);
  const send={...request,messageId:'out',requestId:'send-original'};await e.receipts.prepare('owner','openai',{...send,cacheUserId:'owner'});await e.receipts.update('owner',send.requestId,{state:'failed',chargedCharacters:0});
  await assert.rejects(e.translateIncoming(send,true));assert.equal(h.calls,0);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('upgrading image emoji extraction reuses a completed message instead of charging for the added emoji',async()=>{
 const h=fixture();try{
  const e=h.create();await e.translateIncoming({...request,text:'Thought about bitcoin at $1.00'});assert.equal(h.calls,1);
  const reopened=h.create();assert.ok(await reopened.cached(request));await reopened.translateIncoming(request);assert.equal(h.calls,1);
  await reopened.translateIncoming({...request,messageId:'different-message'});assert.equal(h.calls,2);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('after login recovery a confirmed missing request resumes with the exact original ID',async()=>{
 const h=fixture();try{
  const e=h.create(),prepared=await e.messageRequests.prepare({...request,cacheUserId:'owner'});
  await e.receipts.prepare('owner','openai',prepared);await e.receipts.update('owner',prepared.requestId,{state:'pending'});
  e.cloudProvider=()=>({status:async()=>({state:'not_found'})});
  await e.translateIncoming(request);assert.equal(h.calls,1);assert.equal(h.ids[0],prepared.requestId);
  await e.translateIncoming(request);assert.equal(h.calls,1);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('a transient request-index write failure cannot poison future cache lookups',async()=>{
 const h=fixture();try{
  const e=h.create();await e.translateIncoming(request);assert.equal(h.calls,1);
  const requests=e.messageRequests,write=requests.store.write.bind(requests.store);let fail=true;
  requests.store.write=async(value:any)=>{if(fail){fail=false;throw Error('temporary disk failure')}return write(value)};
  await assert.rejects(requests.prepare({...request,messageId:'other',cacheUserId:'owner'}),/disk/);
  assert.ok(await e.cached(request));await e.translateIncoming(request);assert.equal(h.calls,1);
  // Damage the actual durable index: unchanged files may now reuse an immutable
  // snapshot, so replacing read() would not model a real disk change anymore.
  writeFileSync(join(h.directory,'message-requests-v1.json'),'damaged ledger');
  await assert.rejects(e.cached(request),/无法读取/);
  await assert.rejects(e.translateIncoming(request),/无法读取/);assert.equal(h.calls,1);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('missing-request recovery is bounded across restarts and never replays a processing request',async()=>{
 const h=fixture();try{
  let e=h.create();const prepared=await e.messageRequests.prepare({...request,cacheUserId:'owner'});
  await e.receipts.prepare('owner','openai',prepared);await e.receipts.update('owner',prepared.requestId,{state:'pending'});
  for(let i=0;i<4;i++){
   e=h.create();e.cloudProvider=()=>({status:async()=>({state:i===0?'processing':'not_found'})});
   e.createProvider=()=>({translate:async()=>{throw Error('offline before reply')}});
   await assert.rejects(e.translateIncoming(request));
  }
  const receipt=await e.receipts.get('owner',prepared.requestId);assert.equal(receipt.missingRetries,2);assert.equal(receipt.state,'pending');
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
