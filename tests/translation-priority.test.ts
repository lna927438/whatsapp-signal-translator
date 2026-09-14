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
