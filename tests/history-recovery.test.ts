import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
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
test('history recovery has a persistent limit and manual Retry remains usable without retrying completed work',async()=>{
 const h=fixture();try{
  h.setFailures(10);let e=h.create();
  for(let i=0;i<6;i++){await assert.rejects(e.translateIncoming(request));if(i===2)e=h.create();}
  assert.equal(h.calls,3);h.setFailures(0);await e.translateIncoming(request,true);assert.equal(h.calls,4);
  await e.translateIncoming(request,true);assert.equal(h.calls,4);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
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
