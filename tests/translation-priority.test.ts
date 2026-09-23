import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mainHarness} from './main-harness.ts'
import {rmSync} from 'node:fs'
import {createRequire} from 'node:module'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('history traffic leaves capacity for outgoing translations and cannot jump ahead of queued sends',async()=>{
 const h=mainHarness();try{
  const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),engine=new TranslationEngine(),started:string[]=[],releases=new Map<string,Function>()
  const enqueue=(id:string,interactive=false)=>engine.enqueue(()=>{started.push(id);return new Promise(resolve=>releases.set(id,resolve))},interactive)
  const jobs=[enqueue('history-1'),enqueue('history-2'),enqueue('history-3'),enqueue('send-1',true),enqueue('send-2',true),enqueue('send-3',true)]
  await tick();assert.deepEqual(started,['history-1','history-2','send-1','send-2']);releases.get('send-1')!('done');await tick();assert.equal(started.at(-1),'send-3')
  releases.get('history-1')!('done');await tick();assert.equal(started.at(-1),'history-3')
  for(const release of releases.values())release('done');await Promise.all(jobs)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('a burst using translation quality shares one capability query and keeps each charge request separate',async()=>{
 const {CloudflareProvider,clearCloudCapabilityCache}=createRequire(import.meta.url)('../src/main/translation/providers/cloudflare.ts')
 const original=globalThis.fetch;let health=0;const ids:string[]=[];clearCloudCapabilityCache()
 try{
  globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/health')){health++;return Response.json({features:{translationQuality:true}})}const body=JSON.parse(String(init?.body));ids.push(body.requestId);return Response.json({requestId:body.requestId,translation:'Hello',sourceCharacters:2,balanceAfter:100})}
  await Promise.all([1,2,3].map(id=>new CloudflareProvider('test','https://translation.invalid').translate({text:'你好',targetLanguage:'en-US',requestId:'send-'+id,quality:{tone:'natural'}})))
  assert.equal(health,1);assert.equal(new Set(ids).size,3)
 }finally{globalThis.fetch=original;clearCloudCapabilityCache()}
})

test('manual retry promotes an already queued history request without changing its ID or charging twice', async () => {
 const h=mainHarness()
 try {
  const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),engine=new TranslationEngine()
  engine.setOnlineSession('owner','fixture');engine.settings.get=async()=>({provider:'openai'})
  const started:string[]=[],releases=new Map<string,()=>void>()
  engine.createProvider=()=>({translate:async(r:any)=>{
   started.push(r.requestId)
   await new Promise<void>(resolve=>releases.set(r.requestId,resolve))
   await engine.receipts.update('owner',r.requestId,{state:'charged',translated:'翻译完成',chargedCharacters:Array.from(r.text).length})
   return '翻译完成'
  }})
  const request=(id:string)=>({text:'This is a translation priority fixture.',accountId:'wa',conversationId:'wa:peer',messageId:id,requestId:id,targetLanguage:'zh-CN'})
  const jobs:Promise<string>[]=[]
  const until=async(check:()=>boolean)=>{for(let i=0;i<1000;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2))}assert.fail('queue did not reach expected state')}
  jobs.push(engine.translateIncoming(request('history-one')));await until(()=>started.length===1)
  jobs.push(engine.translateIncoming(request('history-two')));await until(()=>started.length===2)
  jobs.push(engine.translateIncoming(request('history-three')));await until(()=>engine.metrics().queueDepth===1)
  jobs.push(engine.translateIncoming(request('chosen-message')));await until(()=>engine.metrics().queueDepth===2)
  const manual=engine.translateIncoming(request('chosen-message'),true)
  await until(()=>started.includes('chosen-message'))
  assert.equal(started.includes('history-three'),false)
  assert.equal(started.filter(id=>id==='chosen-message').length,1)
  releases.get('chosen-message')!();assert.equal(await manual,'翻译完成')
  releases.get('history-one')!();releases.get('history-two')!()
  await until(()=>started.includes('history-three'));releases.get('history-three')!()
  await Promise.all(jobs)
  assert.equal(started.length,4)
  assert.equal((await engine.history()).filter((r:any)=>r.requestId==='chosen-message').length,1)
  assert.equal(engine.metrics().activeRequests,0)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
