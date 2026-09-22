import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,rmSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {mainHarness} from './main-harness'

const health=(openai=false)=>({ok:true,features:{providerSelection:true},translationProviders:openai?['deepseek','openai']:['deepseek'],defaultTranslationProvider:'deepseek'})
const reply=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})

test('trial capabilities use authenticated identity, share reads within one owner and never cross accounts',async()=>{
 const calls:string[]=[]
 const h=mainHarness(undefined,async(input,init)=>{
  assert.ok(String(input).endsWith('/api/translation-channels'))
  const token=new Headers(init?.headers).get('authorization')!;calls.push(token)
  return reply(health(token==='Bearer trial-token'))
 })
 try{
  const channels=h.load('src/main/network/translationChannels.ts')
  channels.setTranslationChannelIdentity({owner:'owner-a',token:'trial-token'})
  const results=await Promise.all(Array.from({length:30},()=>channels.readTranslationChannels()))
  assert.ok(results.every((r:any)=>r.openai.available));assert.equal(calls.length,1)
  channels.setTranslationChannelIdentity({owner:'owner-b',token:'regular-token'})
  assert.equal((await channels.readTranslationChannels()).openai.available,false)
  channels.setTranslationChannelIdentity({owner:'owner-a',token:'trial-token'})
  assert.equal((await channels.readTranslationChannels()).openai.available,true)
  assert.deepEqual(calls,['Bearer trial-token','Bearer regular-token','Bearer trial-token'])
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('logout cancels late trial results and anonymous reads never inherit trial availability',async()=>{
 let release!:(value:Response)=>void,entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve})
 const h=mainHarness(undefined,async(input)=>{
  if(String(input).endsWith('/health'))return reply(health())
  entered();return new Promise<Response>(resolve=>{release=resolve})
 })
 try{
  const channels=h.load('src/main/network/translationChannels.ts')
  channels.setTranslationChannelIdentity({owner:'owner-a',token:'trial-token'})
  const old=channels.readTranslationChannels(),rejected=assert.rejects(old,/登录状态已变化/)
  await started;channels.setTranslationChannelIdentity();release(reply(health(true)));await rejected
  assert.equal((await channels.readTranslationChannels()).openai.available,false)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('only a missing endpoint falls back to public metadata; auth and service failures fail closed',async()=>{
 for(const status of [401,403,429,500,404,405]){
  const paths:string[]=[]
  const h=mainHarness(undefined,async(input,init)=>{const path=new URL(String(input)).pathname;paths.push(path);if(path==='/health')assert.equal(new Headers(init?.headers).get('authorization'),null);return path==='/health'?reply(health()):reply({error:'fixture'},status)})
  try{
   const channels=h.load('src/main/network/translationChannels.ts')
   channels.setTranslationChannelIdentity({owner:'owner-a',token:'trial-token'})
   const result=await channels.readTranslationChannels()
   assert.equal(result.openai.available,false)
   assert.equal(result.deepseek.available,[404,405].includes(status))
   assert.deepEqual(paths,[404,405].includes(status)?['/api/translation-channels','/health']:['/api/translation-channels'])
  }finally{rmSync(h.directory,{recursive:true,force:true})}
 }
})

test('forcing a failed capability refresh cannot reuse prior enabled trial permissions',async()=>{
 let valid=true,calls=0
 const h=mainHarness(undefined,async()=>{calls++;return valid?reply(health(true)):reply({error:'forbidden'},403)})
 try{
  const channels=h.load('src/main/network/translationChannels.ts')
  channels.setTranslationChannelIdentity({owner:'owner-a',token:'trial-token'})
  assert.equal((await channels.readTranslationChannels()).openai.available,true)
  valid=false
  assert.equal((await channels.readTranslationChannels(undefined,true)).openai.available,false)
  assert.equal((await channels.readTranslationChannels()).openai.available,false);assert.equal(calls,2)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('a recovered token for the same owner can retry immediately after session recovery failed',async()=>{
 let ready=false,calls=0
 const h=mainHarness(undefined,async()=>{calls++;return reply(health(true))})
 try{
  const channels=h.load('src/main/network/translationChannels.ts')
  channels.setTranslationChannelIdentity({owner:'owner-a',token:()=>{if(!ready)throw Error('登录恢复失败');return 'refreshed-token'}})
  await assert.rejects(channels.readTranslationChannels(),/登录.*恢复/)
  ready=true
  assert.equal((await channels.readTranslationChannels()).openai.available,true);assert.equal(calls,1)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('ordinary capability invalidation does not invent a logout during an in-flight DeepSeek check',async()=>{
 let calls=0,release!:(value:Response)=>void,entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve})
 const h=mainHarness(undefined,async()=>{calls++;if(calls>1)return reply(health());entered();return new Promise<Response>(resolve=>{release=resolve})})
 try{
  const channels=h.load('src/main/network/translationChannels.ts')
  channels.setTranslationChannelIdentity({owner:'owner-a',token:'valid-token'})
  const first=channels.readTranslationChannels();await started
  channels.clearTranslationChannels();release(reply(health()))
  assert.equal((await first).deepseek.available,true)
  assert.equal((await channels.readTranslationChannels()).deepseek.available,true);assert.equal(calls,2)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('provider capability checks bind its own credentials and reject expired owner guards before translation',async()=>{
 let authorized=true,posts=0,capabilities=0
 const h=mainHarness(undefined,async(input,init)=>{
  const url=String(input)
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer owner-a-token')
  if(url.endsWith('/api/translation-channels')){capabilities++;return reply(health(true))}
  assert.ok(url.endsWith('/api/translate'));posts++
  const body=JSON.parse(String(init?.body));return reply({requestId:body.requestId,translation:'你好',sourceCharacters:5,balanceAfter:95})
 })
 try{
  const {CloudflareProvider}=h.load('src/main/translation/providers/cloudflare.ts')
  const provider=new CloudflareProvider('owner-a-token','https://fixture.invalid',undefined,{owner:'owner-a',authorized:()=>authorized})
  const request={requestId:'send-first',text:'Hello',targetLanguage:'zh-CN',providerPreference:'openai'}
  assert.equal(await provider.translate(request),'你好');authorized=false
  await assert.rejects(provider.translate({...request,requestId:'send-second'}),/登录状态已变化/)
  assert.equal(posts,1);assert.equal(capabilities,1)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('workspace manual refresh forwards force after an earlier read and ignores disposed renderer responses',async()=>{
 const source=readFileSync(new URL('../src/renderer/src/App.vue',import.meta.url),'utf8')
 const section=source.slice(source.indexOf('function loadTranslationChannels('),source.indexOf('const channelWindowId'))
 const calls:boolean[]=[];let release!:(value:any)=>void
 const context:any={channelsRequest:undefined,channelsLoading:{value:false},translationChannels:{value:null},disposed:false,t:(s:string)=>s,
  window:{desktopAPI:{translationChannels:(force:boolean)=>{calls.push(force);return new Promise(resolve=>{release=resolve})}}}}
 runInNewContext(ts.transpileModule(section,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
 const first=context.loadTranslationChannels(false),forced=context.loadTranslationChannels(true)
 assert.deepEqual(calls,[false]);release({defaultProvider:'deepseek',deepseek:{available:true},openai:{available:false}})
 await first;await Promise.resolve();assert.deepEqual(calls,[false,true])
 context.disposed=true;release({defaultProvider:'deepseek',deepseek:{available:true},openai:{available:true}});await forced
 assert.equal(context.translationChannels.value.openai.available,false)
})
