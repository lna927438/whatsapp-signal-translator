import test from 'node:test'
import assert from 'node:assert/strict'
import { mainHarness } from './main-harness.ts'
const {createGoogleVoiceTranslator}=mainHarness().load('src/main/platforms/googleVoice/translationBridge.ts') as typeof import('../src/main/platforms/googleVoice/translationBridge.ts')
const {GoogleVoiceDispatchLedger}=mainHarness().load('src/main/platforms/googleVoice/dispatchLedger.ts') as typeof import('../src/main/platforms/googleVoice/dispatchLedger.ts')
import type { GoogleVoiceDispatchData } from '../src/main/platforms/googleVoice/dispatchLedger.ts'
import type { RuntimeSettings, TranslationRequest } from '../src/main/types.ts'

function harness(){
  const preferences:RuntimeSettings={provider:'openai',localLanguage:'zh-CN',targetLanguage:'en-US',receiveAutoTranslate:true,sendAutoTranslate:true,blockChineseSend:true,groupTranslate:false,fontSize:13,translationColor:'#fff',historyMode:'visible'}
  let valid=true,balance=true,translated='Hello, how are you?',incomingCalls=0;const checks:boolean[]=[],requests:TranslationRequest[]=[],paid=new Map<string,string>()
  const engine={existingOutgoing:async(requestId:string,accountId:string,conversationId:string,text:string,result:string)=>{
    const request=requests.find(row=>row.requestId===requestId&&row.accountId===accountId&&row.conversationId===conversationId&&row.text===text)
    if(!request||paid.get(requestId)!==result)throw new Error('unverified');return request
  },preserveOutgoingRequest:async(request:TranslationRequest)=>request,preserveIncomingRequest:async(request:TranslationRequest)=>request,prepareOutgoingRequest:async(request:TranslationRequest)=>request,
  translate:async(request:TranslationRequest)=>{requests.push(request);paid.set(request.requestId!,translated);return translated},cached:async()=>undefined,translateIncoming:async()=>{incomingCalls++;return '你好'}}
  let dispatchData:GoogleVoiceDispatchData={records:[]}
  const dispatch=new GoogleVoiceDispatchLedger({read:async()=>structuredClone(dispatchData),write:async value=>{dispatchData=structuredClone(value)}})
  const run=createGoogleVoiceTranslator(engine,{check:async(_owner,_request,_translate,fresh)=>{checks.push(!!fresh);if(!balance)throw new Error('no balance')}},async()=>preferences,dispatch)
  const payload={direction:'outgoing',id:'message-1',conversationId:'conversation-1',text:'你好，你好吗？'}
  return {run,payload,preferences,checks,requests,get incomingCalls(){return incomingCalls},setBalance:(value:boolean)=>balance=value,setResult:(value:string)=>translated=value,setIdentity:(value:boolean)=>valid=value,authorized:()=>valid}
}
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
