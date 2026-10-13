import test from 'node:test'
import assert from 'node:assert/strict'
import { mainHarness } from './main-harness.ts'
const {createGoogleVoiceTranslator}=mainHarness().load('src/main/platforms/googleVoice/translationBridge.ts') as typeof import('../src/main/platforms/googleVoice/translationBridge.ts')
const {GoogleVoiceDispatchLedger}=mainHarness().load('src/main/platforms/googleVoice/dispatchLedger.ts') as typeof import('../src/main/platforms/googleVoice/dispatchLedger.ts')
import type { GoogleVoiceDispatchData } from '../src/main/platforms/googleVoice/dispatchLedger.ts'
import type { RuntimeSettings, TranslationRequest } from '../src/main/types.ts'

function harness(){
  const preferences:RuntimeSettings={provider:'openai',localLanguage:'zh-CN',targetLanguage:'en-US',receiveAutoTranslate:true,sendAutoTranslate:true,blockChineseSend:true,groupTranslate:false,fontSize:13,translationColor:'#fff',historyMode:'visible'}
  let valid=true,balance=true,translated='Hello, how are you?',incomingCalls=0,providerCalls=0;const checks:boolean[]=[],requests:TranslationRequest[]=[],paid=new Map<string,string>()
  const engine={history:async()=>[],existingOutgoing:async(requestId:string,accountId:string,conversationId:string,text:string,result:string)=>{
    const request=requests.find(row=>row.requestId===requestId&&row.accountId===accountId&&row.conversationId===conversationId&&row.text===text)
    if(!request||paid.get(requestId)!==result)throw new Error('unverified');return request
  },preserveOutgoingRequest:async(request:TranslationRequest)=>request,preserveIncomingRequest:async(request:TranslationRequest)=>request,prepareOutgoingRequest:async(request:TranslationRequest)=>request,
  // Mirror the actual engine's canonical stored source and settled-ID reuse.
  translate:async(request:TranslationRequest)=>{if(!paid.has(request.requestId!)){requests.push({...request,text:request.text.trim()});paid.set(request.requestId!,translated);providerCalls++}return paid.get(request.requestId!)!},cached:async()=>undefined,translateIncoming:async()=>{incomingCalls++;return '你好'}}
  let dispatchData:GoogleVoiceDispatchData={records:[]}
  const dispatch=new GoogleVoiceDispatchLedger({read:async()=>structuredClone(dispatchData),write:async value=>{dispatchData=structuredClone(value)}})
  const run=createGoogleVoiceTranslator(engine,{check:async(_owner,_request,_translate,fresh)=>{checks.push(!!fresh);if(!balance)throw new Error('no balance')}},async()=>preferences,dispatch)
  const payload={direction:'outgoing',id:'message-1',conversationId:'conversation-1',text:'你好，你好吗？'}
  return {run,payload,preferences,checks,requests,get incomingCalls(){return incomingCalls},get providerCalls(){return providerCalls},setBalance:(value:boolean)=>balance=value,setResult:(value:string)=>translated=value,setIdentity:(value:boolean)=>valid=value,authorized:()=>valid}
}

const mediaFixture={fingerprint:'a'.repeat(64),count:1,types:['image/png'],totalBytes:1024}
test('image-only sends use no translation API or characters and reserve a durable image-specific dispatch',async()=>{
  const h=harness(),payload={...h.payload,text:'',media:mediaFixture}
  const answer:any=await h.run('owner','window','translate',payload,h.authorized)
  assert.equal(answer.text,'');assert.equal(answer.untranslated,true);assert.equal(h.providerCalls,0);assert.equal(h.checks.length,0)
  assert.deepEqual(JSON.parse(JSON.stringify(answer.media)),mediaFixture)
  const authorization:any=await h.run('owner','window','authorize',{...payload,translated:'',requestId:answer.requestId},h.authorized)
  assert.equal(authorization.authorized,true)
  assert.equal((await h.run('owner','window','dispatch-status',payload,h.authorized) as any).state,'uncertain')
  const changed={...payload,media:{...mediaFixture,fingerprint:'b'.repeat(64)}}
  assert.equal((await h.run('owner','window','dispatch-status',changed,h.authorized) as any).state,'clear')
  await assert.rejects(h.run('owner','window','authorize',{...changed,translated:'',requestId:answer.requestId},h.authorized))
  await assert.rejects(h.run('owner','window','translate',payload,h.authorized),/待确认/)
  await h.run('owner','window','dispatch-resolve',{conversationId:payload.conversationId,media:mediaFixture,requestId:answer.requestId,attempt:1,outcome:'not-sent',confirmed:true},h.authorized)
  assert.equal((await h.run('owner','window','dispatch-status',payload,h.authorized) as any).state,'clear')
})

test('image captions preserve translation billing and cannot authorize a changed or removed attachment',async()=>{
  const h=harness(),payload={...h.payload,media:mediaFixture}
  const answer:any=await h.run('owner','window','translate',payload,h.authorized)
  assert.equal(h.providerCalls,1);assert.deepEqual(h.checks,[false,true])
  await h.run('owner','window','translate',payload,h.authorized);assert.equal(h.providerCalls,1)
  await assert.rejects(h.run('owner','window','authorize',{...h.payload,translated:answer.text,requestId:answer.requestId},h.authorized))
  await assert.rejects(h.run('owner','window','authorize',{...payload,media:{...mediaFixture,totalBytes:2048},translated:answer.text,requestId:answer.requestId},h.authorized))
  assert.equal((await h.run('owner','window','authorize',{...payload,translated:answer.text,requestId:answer.requestId},h.authorized) as any).authorized,true)
  const other={...payload,media:{...mediaFixture,fingerprint:'b'.repeat(64)}}
  await h.run('owner','window','translate',other,h.authorized);assert.equal(h.providerCalls,2)
})

test('a long translated editor can recover its uncertain send without translating or charging again', async () => {
  const h = harness(), payload = { ...h.payload, text: '你好，'.repeat(2000) }
  const translated = 'Hello, '.repeat(2000).trim()
  h.setResult(translated)
  const answer: any = await h.run('owner', 'window', 'translate', payload, h.authorized)
  await h.run('owner', 'window', 'authorize', { ...payload, translated: answer.text, requestId: answer.requestId }, h.authorized)
  const status: any = await h.run('owner', 'window', 'dispatch-status', { conversationId: payload.conversationId, text: translated }, h.authorized)
  assert.equal(status.state, 'uncertain'); assert.equal(status.requestId, answer.requestId); assert.equal(status.attempt, 1)
  assert.equal(h.providerCalls, 1)
  await assert.rejects(h.run('owner', 'window', 'dispatch-status', { conversationId: payload.conversationId, text: 'x'.repeat(20001) }, h.authorized), /草稿无效/)
  await assert.rejects(h.run('owner', 'window', 'translate', { ...payload, text: translated }, h.authorized), /翻译请求无效/)
  assert.equal(h.providerCalls, 1)
})

test('media metadata is bounded and cannot smuggle filenames, URLs, unsupported files or incoming draft data',async()=>{
  const h=harness()
  for(const media of [null,{}, {...mediaFixture,count:0},{...mediaFixture,count:2},{...mediaFixture,types:['audio/mp3']},{...mediaFixture,totalBytes:20*1024*1024+1},{...mediaFixture,filename:'private'},{...mediaFixture,fingerprint:'bad'}]) {
    await assert.rejects(h.run('owner','window','translate',{...h.payload,media},h.authorized))
  }
  await assert.rejects(h.run('owner','window','translate',{...h.payload,direction:'incoming',media:mediaFixture},h.authorized))
  await assert.rejects(h.run('owner','window','translate',{...h.payload,text:''},h.authorized))
  assert.equal(h.providerCalls,0)
})

test('a first SMS remains protected when Google replaces its draft route with a real thread',async()=>{
  const h=harness(),context={kind:'recipients',recipientKey:'a'.repeat(64),recipientCount:1}
  const draft={...h.payload,text:'Hello',conversationId:'draft-destination',context}
  const answer:any=await h.run('owner','window','translate',draft,h.authorized)
  await h.run('owner','window','authorize',{...draft,translated:answer.text,requestId:answer.requestId},h.authorized)
  const after={...h.payload,text:'Hello',conversationId:'new-server-thread'}
  assert.equal((await h.run('owner','window','dispatch-status',after,h.authorized) as any).state,'uncertain')
  await assert.rejects(h.run('owner','window','translate',after,h.authorized),/待确认/)
  assert.equal((await h.run('owner','different-window','dispatch-status',after,h.authorized) as any).state,'clear')
  const resolution={conversationId:after.conversationId,requestId:answer.requestId,attempt:1,outcome:'sent',confirmed:true}
  await assert.rejects(h.run('different-owner','window','dispatch-resolve',resolution,h.authorized))
  await assert.rejects(h.run('owner','window','dispatch-resolve',{...resolution,attempt:2},h.authorized))
  await h.run('owner','window','dispatch-resolve',resolution,h.authorized)
  assert.equal((await h.run('owner','window','dispatch-status',after,h.authorized) as any).state,'clear')
  assert.equal(h.providerCalls,0)
})

test('new-recipient image uncertainty cannot be resolved with a different image after thread navigation',async()=>{
  const h=harness(),context={kind:'recipients',recipientKey:'a'.repeat(64),recipientCount:1}
  const draft={...h.payload,text:'',media:mediaFixture,context}
  const answer:any=await h.run('owner','window','translate',draft,h.authorized)
  await h.run('owner','window','authorize',{...draft,translated:'',requestId:answer.requestId},h.authorized)
  const after={conversationId:'new-server-thread',text:'',media:mediaFixture}
  assert.equal((await h.run('owner','window','dispatch-status',after,h.authorized) as any).state,'uncertain')
  const resolution={...after,requestId:answer.requestId,attempt:1,outcome:'not-sent',confirmed:true}
  await assert.rejects(h.run('owner','window','dispatch-resolve',{...resolution,media:{...mediaFixture,fingerprint:'b'.repeat(64)}},h.authorized))
  await assert.rejects(h.run('owner','window','dispatch-resolve',resolution,h.authorized),/原来的收件人/)
  assert.equal((await h.run('owner','window','dispatch-status',after,h.authorized) as any).state,'uncertain')
  await h.run('owner','window','dispatch-resolve',{...resolution,conversationId:draft.conversationId,context},h.authorized)
})

test('editor whitespace uses the canonical engine receipt and keeps the original dispatch fingerprint',async()=>{
  const h=harness(),payload={...h.payload,text:' \n你好，你好吗？\n '}
  const answer:any=await h.run('owner','window','translate',payload,h.authorized)
  const repeated:any=await h.run('owner','window','translate',payload,h.authorized)
  assert.equal(repeated.requestId,answer.requestId);assert.equal(h.providerCalls,1)
  assert.equal(h.requests[0].text,payload.text.trim())
  await assert.rejects(h.run('owner','window','authorize',{...payload,text:'不同的中文内容',requestId:answer.requestId,translated:answer.text},h.authorized))
  const authorization:any=await h.run('owner','window','authorize',{...payload,requestId:answer.requestId,translated:answer.text},h.authorized)
  assert.equal(authorization.authorized,true);assert.equal(h.providerCalls,1)
  assert.equal((await h.run('owner','window','dispatch-status',payload,h.authorized) as any).state,'uncertain')
  assert.equal((await h.run('owner','window','dispatch-status',{...payload,text:payload.text.trim()},h.authorized) as any).state,'clear')
})
test('outgoing uses existing billing flow and validates exact result again before sending',async()=>{
  const h=harness(),answer:any=await h.run('owner','window','translate',h.payload,h.authorized)
  assert.match(answer.requestId,/^send-gv-/);assert.deepEqual(h.checks,[false,true])
  // The actual engine normalizes an uncertain detected source to auto. This is
  // not the UI source-language preference and must not strand a paid result.
  h.requests[0].sourceLanguage='auto'
  const auth:any=await h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized)
  assert.equal(auth.authorized,true);assert.deepEqual(h.checks,[false,true,true])
  await assert.rejects(h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized),/待确认/)
  await assert.rejects(h.run('owner','other-window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized))
  await assert.rejects(h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:'different'},h.authorized))
  await assert.rejects(h.run('owner','window','authorize',{...h.payload,id:'message-2',requestId:answer.requestId,translated:answer.text},h.authorized))
  h.preferences.targetLanguage='fr-FR';await assert.rejects(h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized))
})

test('dispatch uncertainty survives fresh requests and only explicit review unlocks retry',async()=>{
  const h=harness(),answer:any=await h.run('owner','window','translate',h.payload,h.authorized)
  await h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized)
  assert.equal((await h.run('owner','window','dispatch-status',h.payload,h.authorized) as any).state,'uncertain')
  const newer={...h.payload,id:'new-after-reload'}
  await assert.rejects(h.run('owner','window','translate',newer,h.authorized),/待确认/)
  await assert.rejects(h.run('owner','window','translate',{...newer,text:answer.text},h.authorized),/待确认/)
  assert.equal(h.requests.length,1)
  const resolution={conversationId:h.payload.conversationId,requestId:answer.requestId,attempt:1,outcome:'not-sent',confirmed:true}
  await assert.rejects(h.run('owner','window','dispatch-resolve',{...resolution,confirmed:false},h.authorized))
  await assert.rejects(h.run('other-owner','window','dispatch-resolve',resolution,h.authorized))
  await h.run('owner','window','dispatch-resolve',resolution,h.authorized)
  assert.equal((await h.run('owner','window','dispatch-status',h.payload,h.authorized) as any).state,'clear')
  await h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized)
  await assert.rejects(h.run('owner','window','dispatch-resolve',resolution,h.authorized),/次数已变化/)
  await h.run('owner','window','dispatch-resolve',{...resolution,attempt:2,outcome:'sent'},h.authorized)
  await assert.rejects(h.run('owner','window','authorize',{...h.payload,requestId:answer.requestId,translated:answer.text},h.authorized),/已经使用/)
})

test('plain target-language sends need no translation charge but still reserve exactly once',async()=>{
  const h=harness(),payload={...h.payload,text:'Hello'}
  const plain:any=await h.run('owner','window','translate',payload,h.authorized)
  assert.equal(plain.untranslated,true);assert.equal(h.requests.length,0);assert.equal(h.checks.length,0)
  await h.run('owner','window','authorize',{...payload,requestId:plain.requestId,translated:plain.text},h.authorized)
  await assert.rejects(h.run('owner','window','authorize',{...payload,requestId:plain.requestId,translated:plain.text},h.authorized),/待确认/)
  const altered={...payload,id:'message-new',text:'你好'}
  await assert.rejects(h.run('owner','window','authorize',{...altered,requestId:plain.requestId,translated:altered.text},h.authorized))
  h.preferences.sendAutoTranslate=false
  const english:any=await h.run('owner','window','translate',{...payload,text:'Any unmodified English draft'},h.authorized)
  assert.equal(english.untranslated,true)
  await assert.rejects(h.run('owner','window','translate',altered,h.authorized),/中文原文/)
})
test('zero balance, Chinese result, disabled translation and stale session fail closed',async()=>{
  const h=harness();h.setBalance(false)
  await assert.rejects(h.run('owner','window','translate',h.payload,h.authorized));assert.equal(h.requests.length,0)
  h.setBalance(true);h.setResult('你好');await assert.rejects(h.run('owner','window','translate',h.payload,h.authorized))
  h.preferences.sendAutoTranslate=false;await assert.rejects(h.run('owner','window','translate',h.payload,h.authorized))
  h.setIdentity(false);await assert.rejects(h.run('owner','window','status',undefined,h.authorized))
})
test('incoming honors visible-history/manual settings and rejects malformed payloads',async()=>{
  const h=harness(),incoming={...h.payload,direction:'incoming',text:'Hello'}
  await h.run('owner','window','translate',incoming,h.authorized);assert.equal(h.incomingCalls,1)
  h.preferences.historyMode='manual';await h.run('owner','window','translate',incoming,h.authorized);assert.equal(h.incomingCalls,1)
  await h.run('owner','window','translate',{...incoming,manual:true},h.authorized);assert.equal(h.incomingCalls,2)
  for(const payload of [{...incoming,conversationId:'../../bad'},{...incoming,text:'a'.repeat(10001)},{...incoming,direction:'delete'}])await assert.rejects(h.run('owner','window','translate',payload,h.authorized))
})

test('disabled Chinese switch sends exact mixed text and image captions without API or balance reads',async()=>{
 for(const media of [undefined,mediaFixture]){
  const h=harness();h.preferences.blockChineseSend=false;h.setBalance(false)
  const payload={...h.payload,text:'  你好 Alice\n保持  间隔。  ',...(media?{media}:{})}
  const status:any=await h.run('owner','window','status',undefined,h.authorized);assert.equal(status.blockChineseSend,false)
  const result:any=await h.run('owner','window','translate',payload,h.authorized)
  assert.equal(result.text,payload.text);assert.equal(result.untranslated,true);assert.equal(h.providerCalls,0);assert.equal(h.checks.length,0)
  h.preferences.blockChineseSend=true
  await assert.rejects(h.run('owner','window','authorize',{...payload,translated:result.text,requestId:result.requestId},h.authorized),/设置已变化/)
  h.preferences.blockChineseSend=false
  assert.equal((await h.run('owner','window','authorize',{...payload,translated:result.text,requestId:result.requestId},h.authorized) as any).authorized,true)
  await assert.rejects(h.run('owner','window','translate',payload,h.authorized),/待确认/)
  assert.equal(h.providerCalls,0);assert.equal(h.checks.length,0)
 }
})

test('enabled Chinese switch rejects Han even for Chinese and Japanese targets',async()=>{
 for(const targetLanguage of ['zh-CN','ja']){
  const h=harness();h.preferences.targetLanguage=targetLanguage;h.setResult('中文𠀀')
  await assert.rejects(h.run('owner','window','translate',h.payload,h.authorized),/中文/)
 }
})

test('switching off cannot reuse an old translated Chinese draft as a fresh direct send',async()=>{
 const h=harness(),result:any=await h.run('owner','window','translate',h.payload,h.authorized)
 h.preferences.blockChineseSend=false
 await assert.rejects(h.run('owner','window','authorize',{...h.payload,translated:result.text,requestId:result.requestId},h.authorized),/设置已变化/)
 const raw:any=await h.run('owner','window','translate',h.payload,h.authorized)
 assert.equal(raw.untranslated,true);assert.equal(raw.text,h.payload.text);assert.equal(h.providerCalls,1)
})

test('live send policy revisions survive boolean round trips and reject a status read across a change',async()=>{
 const preferences=harness().preferences
 let revision=4, mutate=false
 const run=createGoogleVoiceTranslator({} as any,{check:async()=>assert.fail('status must not bill')},async()=>{if(mutate)revision++;return preferences},{} as any,()=>revision)
 let status:any=await run('owner','window','status',undefined,()=>true)
 assert.equal(status.sendPolicyRevision,4);assert.equal(status.blockChineseSend,true)
 preferences.blockChineseSend=false;revision++
 status=await run('owner','window','status',undefined,()=>true);assert.equal(status.sendPolicyRevision,5);assert.equal(status.blockChineseSend,false)
 preferences.blockChineseSend=true;revision++
 status=await run('owner','window','status',undefined,()=>true);assert.equal(status.sendPolicyRevision,6);assert.equal(status.blockChineseSend,true)
 mutate=true;await assert.rejects(run('owner','window','status',undefined,()=>true),/设置已变化/)
})
