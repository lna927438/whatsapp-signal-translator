import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'

const request = {text:'Yes I am at work\n\nI have not been to Turkey Run in several years\nUnfortunately\n\nUsually will go canoeing down sugar creek',accountId:'wa',conversationId:'wa:alex',messageId:'false_peer@c.us_one',sourceLanguage:'auto',targetLanguage:'zh-CN'}
function setup(){
 const h=mainHarness(),{TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),{TranslationOutcomeError}=h.load('src/main/translation/providers/cloudflare.ts')
 let calls:string[]=[]
 const create=()=>{const e=new TranslationEngine();e.setOnlineSession('owner','fixture');e.settings.get=async()=>({provider:'openai'});e.createProvider=()=>({translate:async(r:any)=>{calls.push(r.requestId);await e.receipts.update('owner',r.requestId,{state:'charged',translated:'已经恢复翻译',chargedCharacters:Array.from(r.text).length});return '已经恢复翻译'}});return e}
 return {...h,create,calls,TranslationOutcomeError}
}
test('one manual click recovers a pending receipt that the cloud now confirms failed',async()=>{
 const h=setup();try{
  const e=h.create(),r=await e.messageRequests.prepare({...request,cacheUserId:'owner'})
  await e.receipts.prepare('owner','openai',r);await e.receipts.update('owner',r.requestId,{state:'pending'})
  e.cloudProvider=()=>({status:async()=>({state:'failed',error:'translation_outcome_unknown'})})
  assert.equal(await e.translateIncoming(request,true),'已经恢复翻译');assert.equal(h.calls.length,1);assert.notEqual(h.calls[0],r.requestId)
  assert.equal((await e.receipts.get('owner',r.requestId)).chargedCharacters,0)
  assert.equal(await h.create().translateIncoming(request),'已经恢复翻译');assert.equal(h.calls.length,1)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('a genuine processing receipt keeps its ID and precise status without a replacement or debit',async()=>{
 const h=setup();try{
  const e=h.create(),r=await e.messageRequests.prepare({...request,cacheUserId:'owner'})
  await e.receipts.prepare('owner','openai',r);await e.receipts.update('owner',r.requestId,{state:'pending'})
  e.cloudProvider=()=>({status:async()=>({state:'processing'})})
  await assert.rejects(e.translateIncoming(request,true),/仍在处理/);assert.equal(h.calls.length,0);assert.equal((await e.receipts.get('owner',r.requestId)).state,'pending')
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('outgoing retry keeps the send task and switches only a failed uncharged translation across restarts',async()=>{
 const h=setup();try{
  let e=h.create();const {SendTasks}=h.load('src/main/translation/sendTasks.ts'),{JsonStore}=h.load('src/main/storage/jsonStore.ts')
  const store=new JsonStore('outgoing-tasks-v1.json',{tasks:[]},true)
  let tasks=new SendTasks(store)
  const task=await tasks.prepare('owner',{platform:'whatsapp',accountId:'wa',conversationId:'wa:alex',targetKey:'peer:peer@c.us',translate:true,blockChinese:true,request:{...request,messageId:undefined}})
  e.createProvider=()=>({translate:async()=>{throw new h.TranslationOutcomeError('服务暂时不可用，未扣费。',true)}})
  const run=()=>tasks.translate('owner',task.id,async(r:any)=>{const next=await e.prepareOutgoingRequest(r);await tasks.useTranslationRequest('owner',task.id,next);return e.translate(next)},()=>true)
  await assert.rejects(run());assert.equal((await tasks.get('owner',task.id)).state,'draft')
  e=h.create();tasks=new SendTasks(store)
  const restored=await run();assert.equal(restored.id,task.id);assert.equal(restored.state,'ready');assert.notEqual(restored.request.requestId,task.id)
  let sends=0;await tasks.submit('owner',task.id,async()=>{sends++;return{messageId:'true_peer@c.us_new'}},()=>true)
  await tasks.submit('owner',task.id,async()=>{sends++;return{}},()=>true)
  assert.equal(sends,1);assert.equal(h.calls.length,1)
  const linked=await e.prepareOutgoingRequest(task.request);assert.equal(linked.requestId,restored.request.requestId)
  assert.equal((await e.history()).filter((r:any)=>r.state==='charged').length,1)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('concurrent outgoing retries use one child request and never replace an unresolved send',async()=>{
 const h=setup();try{
  const e=h.create(),r={...request,requestId:'send-original',cacheUserId:'owner'}
  await e.receipts.prepare('owner','openai',r);await e.receipts.update('owner',r.requestId,{state:'failed',chargedCharacters:0})
  const requests=await Promise.all(Array.from({length:10},()=>e.prepareOutgoingRequest(r)))
  assert.equal(new Set(requests.map(r=>r.requestId)).size,1)
  await Promise.all(requests.map(r=>e.translate(r)));assert.equal(h.calls.length,1)
  const pending={...request,requestId:'send-pending',cacheUserId:'owner'};await e.receipts.prepare('owner','openai',pending);await e.receipts.update('owner',pending.requestId,{state:'pending'})
  e.cloudProvider=()=>({status:async()=>({state:'processing'})})
  assert.equal((await e.prepareOutgoingRequest(pending)).requestId,pending.requestId);assert.equal((await e.receipts.get('owner',pending.requestId)).retryRequestId,undefined)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('record recovery works after cloud failure without needing a second click',async()=>{
 const h=setup();try{
  const e=h.create(),r=await e.messageRequests.prepare({...request,cacheUserId:'owner'});await e.receipts.prepare('owner','openai',r);await e.receipts.update('owner',r.requestId,{state:'pending'})
  e.cloudProvider=()=>({status:async()=>({state:'failed',error:'provider_unavailable'})})
  assert.equal(await e.retryOriginal(r.requestId),'已经恢复翻译');assert.equal(h.calls.length,1)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
