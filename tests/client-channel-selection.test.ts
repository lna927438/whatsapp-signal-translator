import test from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness'
import {channelsFromHealth,assertCloudChannelTransport,translationModelLabel} from '../src/shared/translationChannels'

const health={ok:true,features:{providerSelection:true},translationProviders:['deepseek','openai'],defaultTranslationProvider:'deepseek'}
const reply=(data:any)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})

test('legacy private services cannot advertise or silently execute a selected cloud channel',async()=>{
  const advertised=channelsFromHealth(health)
  for(const transport of ['deepl','google']){
    assert.throws(()=>assertCloudChannelTransport(transport),/已移除/)
    const h=mainHarness()
    try {
      const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),engine=new TranslationEngine()
      engine.setOnlineSession('owner','fixture')
      engine.settings.get=async()=>({provider:transport})
      engine.createProvider=()=>assert.fail('Must not route an explicit cloud preference through the private service')
      for(const providerPreference of ['openai','deepseek'])await assert.rejects(engine.translate({text:'Hello there',targetLanguage:'zh-CN',providerPreference}),/个人翻译服务/)
      assert.equal((await engine.history()).length,0)
    }finally{rmSync(h.directory,{recursive:true,force:true})}
  }
  assert.doesNotThrow(()=>assertCloudChannelTransport('openai'))
})
test('only server-advertised configured channels are selectable; legacy DeepSeek stays usable',()=>{
  assert.equal(channelsFromHealth(health).openai.available,true)
  assert.equal(channelsFromHealth({...health,translationProviders:['deepseek']}).openai.available,false)
  const old=channelsFromHealth({ok:true,routing:[{provider:'deepseek'}]})
  assert.equal(old.deepseek.available,true);assert.equal(old.openai.available,false);assert.equal(old.selectionSupported,false)
  assert.equal(channelsFromHealth({ok:true,routing:[{provider:'openai'},{provider:'deepseek'}]}).openai.available,false)
  assert.equal(channelsFromHealth(null).checked,false)
})
test('many windows share one capability read and legacy requests retain an absent preference',async()=>{
  let calls=0
  const h=mainHarness(undefined,async()=>{calls++;return reply({ok:true,routing:[{provider:'deepseek'}]})})
  try {
    const {requestChannelPreference}=h.load('src/main/network/translationChannels.ts')
    const values=await Promise.all(Array.from({length:30},()=>requestChannelPreference('deepseek')))
    assert.equal(calls,1);assert.ok(values.every(value=>value===undefined))
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('explicit channel reaches the cloud request; unavailable OpenAI never silently uses DeepSeek',async()=>{
  let selectionEnabled=true,posts:any[]=[]
  const h=mainHarness(undefined,async(input,init)=>{
    const url=String(input)
    if(url.endsWith('/health')||url.endsWith('/api/translation-channels'))return reply(selectionEnabled?health:{ok:true,routing:[{provider:'deepseek'}]})
    if(url.includes('/api/translation-status?'))return reply({state:'not_found'})
    assert.ok(url.endsWith('/api/translate'))
    const body=JSON.parse(String(init?.body));posts.push(body)
    return reply({requestId:body.requestId,translation:'你好',sourceCharacters:Array.from(body.text).length,balanceAfter:999})
  })
  try {
    const {CloudflareProvider}=h.load('src/main/translation/providers/cloudflare.ts')
    const provider=new CloudflareProvider('fixture','https://gateway.invalid')
    const request={requestId:'send-one',text:'Hello',targetLanguage:'zh-CN',providerPreference:'openai'}
    assert.equal(await provider.translate(request),'你好');assert.equal(posts[0].providerPreference,'openai')
    selectionEnabled=false;h.load('src/main/network/translationChannels.ts').clearTranslationChannels()
    await assert.rejects(provider.translate({...request,requestId:'send-two'}),/所选翻译通道/)
    assert.equal(posts.length,1)
    await provider.translate({...request,requestId:'legacy',providerPreference:undefined})
    assert.equal(Object.hasOwn(posts[1],'providerPreference'),false)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('a health outage never silently strips an explicitly selected DeepSeek channel',async()=>{
  const h=mainHarness(undefined,async()=>{throw new Error('offline')})
  try {await assert.rejects(h.load('src/main/network/translationChannels.ts').requestChannelPreference('deepseek'),/无法确认翻译通道/)}
  finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('channel retirement resolves the original receipt before reporting a failure and never reroutes',async()=>{
  let advertised=true,settled=true,posts=0,statusReads=0
  const h=mainHarness(undefined,async(input)=>{
    const url=String(input)
    if(url.endsWith('/health')||url.endsWith('/api/translation-channels'))return reply({...health,translationProviders:advertised?['deepseek','openai']:['deepseek']})
    if(url.includes('/api/translation-status?')){
      statusReads++
      return reply(settled?{state:'completed',response:{requestId:'send-retired',translation:'你好',sourceCharacters:5,balanceAfter:995}}:{state:'not_found'})
    }
    assert.ok(url.endsWith('/api/translate'));posts++
    return new Response(JSON.stringify({error:'provider_not_available'}),{status:503})
  })
  try {
    const {CloudflareProvider}=h.load('src/main/translation/providers/cloudflare.ts'),provider=new CloudflareProvider('fixture','https://gateway.invalid')
    const request={requestId:'send-retired',text:'Hello',targetLanguage:'zh-CN',providerPreference:'openai'}
    // Cached capability may race with an operator disabling the channel.
    assert.equal(await provider.translate(request),'你好');assert.equal(posts,1)
    advertised=false
    assert.equal(await provider.translate(request),'你好');assert.equal(posts,1)
    settled=false
    await assert.rejects(provider.translate(request),(error:any)=>error.confirmedFailure===true&&/所选翻译通道/.test(error.message))
    assert.equal(posts,1);assert.equal(statusReads,3)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('persisted incoming request and outgoing retry keep their first channel across a switch and restart',async()=>{
  const h=mainHarness()
  try{
    const {MessageRequests}=h.load('src/main/translation/messageRequests.ts'),{TranslationReceipts}=h.load('src/main/translation/receipts.ts')
    const request={cacheUserId:'owner',accountId:'wa',messageId:'message-one',text:'Hello there',targetLanguage:'zh-CN',sourceLanguage:'auto',providerPreference:'openai'}
    const first=await new MessageRequests().prepare(request)
    const replay=await new MessageRequests().prepare({...request,providerPreference:'deepseek'})
    assert.equal(replay.requestId,first.requestId);assert.equal(replay.providerPreference,'openai')
    const next=await new MessageRequests().prepare({...request,messageId:'message-two',providerPreference:'deepseek'})
    assert.equal(next.providerPreference,'deepseek');assert.notEqual(next.requestId,first.requestId)
    const receipts=new TranslationReceipts(),outgoing={...request,requestId:'send-first'}
    await receipts.prepare('owner','openai',outgoing)
    await receipts.update('owner',outgoing.requestId,{state:'failed',chargedCharacters:0})
    const retry=await receipts.retryFailedOutgoing('owner',outgoing.requestId)
    assert.equal(retry.providerPreference,'openai')
    const resumed=await new TranslationReceipts().prepare('owner','openai',{...outgoing,providerPreference:'deepseek'})
    assert.equal(resumed.request.providerPreference,'openai')
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('each account persists its own channel without changing proxy, contact languages or other accounts',async()=>{
  const h=mainHarness()
  try {
    const {AccountManager}=h.load('src/main/accounts/accountManager.ts'),accounts=new AccountManager()
    const a=await accounts.add('whatsapp','One'),b=await accounts.add('signal','Two')
    await accounts.updateContactLanguage(a.id,'peer','en-US','Original name')
    await accounts.update(a.id,{translationProvider:'openai'})
    await accounts.update(b.id,{translationProvider:'deepseek'})
    const again=await new AccountManager().list()
    assert.equal(again.find((r:any)=>r.id===a.id).translationProvider,'openai')
    assert.equal(again.find((r:any)=>r.id===a.id).contactLanguages.peer.name,'Original name')
    assert.equal(again.find((r:any)=>r.id===b.id).translationProvider,'deepseek')
    const {GoogleVoiceRecords}=h.load('src/main/platforms/googleVoice/windowRecords.ts')
    let data={windows:[]};const store={read:async()=>structuredClone(data),write:async(value:any)=>{data=value}}
    const gv=new GoogleVoiceRecords(store),one=await gv.add('owner',{label:'Voice one'}),two=await gv.add('owner',{label:'Voice two'})
    await gv.update('owner',one.id,{translationProvider:'openai'})
    assert.equal((await gv.get('owner',one.id)).translationProvider,'openai')
    assert.equal((await gv.get('owner',two.id)).translationProvider,undefined)
    await assert.rejects(gv.update('other',one.id,{translationProvider:'deepseek'}),/不存在/)
    assert.equal((await gv.get('owner',one.id)).translationProvider,'openai')
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('model names come from validated server metadata and never enable a disabled channel',()=>{
 const result=channelsFromHealth({...health,translationProviders:['deepseek'],translationModels:{deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'}}})
 assert.equal(translationModelLabel('deepseek',result.deepseek),'DeepSeek · deepseek-v4-pro')
 assert.equal(translationModelLabel('openai',result.openai),'OpenAI · gpt-5.6-luna');assert.equal(result.openai.available,false)
 const invalid=channelsFromHealth({...health,translationModels:{openai:{model:'<script>private</script>',displayName:'unsafe\nname'}}})
 assert.equal(invalid.openai.model,undefined);assert.equal(translationModelLabel('openai',invalid.openai),'OpenAI')
})

test('manual refresh bypasses settled cache and parallel refreshes reuse an in-flight capability check',async()=>{
 let calls=0,enabled=false,release:((value:Response)=>void)|undefined
 const h=mainHarness(undefined,async()=>{calls++;if(calls===1)return reply({...health,translationProviders:['deepseek']});return new Promise<Response>(resolve=>{release=resolve})})
 try {
  const {readTranslationChannels}=h.load('src/main/network/translationChannels.ts')
  assert.equal((await readTranslationChannels()).openai.available,false)
  enabled=true
  assert.equal((await readTranslationChannels()).openai.available,false);assert.equal(calls,1)
  const forced=Array.from({length:30},()=>readTranslationChannels(undefined,true))
  const regular=readTranslationChannels()
  assert.equal(calls,2);assert.ok(forced.every(value=>value===forced[0]));assert.equal(regular,forced[0])
  release!(reply({...health,translationProviders:enabled?['deepseek','openai']:['deepseek']}))
  const results=await Promise.all([...forced,regular]);assert.ok(results.every(value=>value.openai.available))
  assert.equal((await readTranslationChannels()).openai.available,true);assert.equal(calls,2)
  for(const value of ['true',1,null,{}])assert.throws(()=>readTranslationChannels(undefined,value),/刷新参数无效/)
  assert.equal(calls,2)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
