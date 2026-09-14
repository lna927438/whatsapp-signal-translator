import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mainHarness } from './main-harness.ts'
const require = createRequire(import.meta.url)
const { RestartCoordinator } = require('../src/main/restartCoordinator.ts')
const { detectLanguageEvidence } = require('../src/main/translation/languageDetection.ts')
const { validateTranslation } = require('../src/main/translation/translationValidation.ts')
const { mergeQuality } = require('../src/shared/translationPolicy.ts')
const { PerformanceSamples } = require('../src/main/performanceSamples.ts')

test('one-click restart coalesces repeated clicks and commits only after persistence completes', async () => {
  const events:string[]=[];let finish:()=>void=()=>{}
  const restart=new RestartCoordinator(async()=>{events.push('save');await new Promise<void>(resolve=>{finish=resolve});events.push('saved')},()=>events.push('relaunch'))
  const first=restart.run(),second=restart.run();assert.equal(first,second);await Promise.resolve();assert.deepEqual(events,['save'])
  finish();await first;await restart.run();assert.deepEqual(events,['save','saved','relaunch'])
})
test('a failed restart save never schedules a later relaunch and allows a deliberate retry',async()=>{
  let failed=true,commits=0
  const restart=new RestartCoordinator(async()=>{if(failed)throw Error('disk unavailable')},()=>{commits++})
  await assert.rejects(restart.run(),/disk/);assert.equal(commits,0);failed=false;await restart.run();assert.equal(commits,1)
})
test('desktop restart uses normal quit, retains launch arguments and bypasses only the already-saved quit prompt',async()=>{
  const events:Record<string,Function>={},order:string[]=[]
  const h=mainHarness({app:{on:(name:string,fn:Function)=>events[name]=fn,relaunch:(options:any)=>{assert.equal(options,undefined);order.push('relaunch')},quit:()=>{events['before-quit']({preventDefault(){throw Error('should not request a second approval')}});order.push('quit')}}})
  try {const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({on(){},isDestroyed:()=>false,setOverlayIcon(){},flashFrame(){}});runtime.configureQuitGuard(async()=>1);runtime.configureRestart(async()=>{order.push('persist')});await runtime.restartDesktop();assert.deepEqual(order,['persist','relaunch','quit'])}finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('sensitive journals read legacy records and encrypt the next atomic write without losing identity',async()=>{
  const h=mainHarness();try{const {JsonStore}=h.load('src/main/storage/jsonStore.ts'),store=new JsonStore('outgoing-tasks-v1.json',{tasks:[]},true)
    const path=h.directory+'/outgoing-tasks-v1.json';const value={tasks:[{id:'same-request',state:'uncertain',text:'private-original'}]};writeFileSync(path,JSON.stringify(value))
    assert.deepEqual(structuredClone(await store.read()),value);await store.write(value);assert.equal(readFileSync(path,'utf8').includes('private-original'),false);assert.deepEqual(structuredClone(await new JsonStore('outgoing-tasks-v1.json',{},true).read()),value)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('unavailable encryption refuses a new write; unreadable protected data is never treated as an empty ledger',async()=>{
  const h=mainHarness({safeStorage:{isEncryptionAvailable:()=>false,decryptString:()=>{throw Error('wrong user')}}});try{const {JsonStore}=h.load('src/main/storage/jsonStore.ts'),store=new JsonStore('drafts-v1.json',{},true)
    writeFileSync(h.directory+'/drafts-v1.json','{"kept":"original"}');await assert.rejects(store.write({changed:true}),/加密/);assert.equal(readFileSync(h.directory+'/drafts-v1.json','utf8'),'{"kept":"original"}')
    writeFileSync(h.directory+'/drafts-v1.json','hellodog-encrypted-v1:AAAA');await assert.rejects(store.read(),/Windows/)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('two stores writing the same file serialize atomic replacement and leave a readable final snapshot',async()=>{
  const h=mainHarness();try{const {JsonStore}=h.load('src/main/storage/jsonStore.ts');const a=new JsonStore('drafts-v1.json',{},true),b=new JsonStore('drafts-v1.json',{},true)
    await Promise.all([a.write({revision:1}),b.write({revision:2})]);assert.equal((await a.read()).revision,2)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('language evidence does not invent languages for names, shared words, URLs or mixed messages',()=>{
  for(const text of ['Michael','LA','como no','https://hello.you.the.test','This is 你好','merci you are hola'])assert.equal(detectLanguageEvidence(text).confidence,'low',text)
  for(const [text,language] of [['hello thank you what are your plans','en-US'],['hola gracias usted estoy bien','es'],['olá obrigado você estou bem','pt-BR'],['我在这里，请你确认一下','zh-CN']])assert.equal(detectLanguageEvidence(text).language,language,text)
})
test('translation validation rejects a changed phone, missing glossary or confident wrong language without leaking the source',()=>{
  const request={text:'联系 Acme：+1 202-555-0100 https://example.test/order/42',targetLanguage:'en-US',quality:{glossary:[{source:'Acme',target:'ACME Corp'}]}}
  assert.equal(validateTranslation(request,'Contact ACME Corp: +1 202-555-0100 https://example.test/order/42').startsWith('Contact'),true)
  assert.throws(()=>validateTranslation(request,'Contact ACME Corp: +1 202-555-0199 https://example.test/order/42'),/链接、号码或术语/)
  assert.throws(()=>validateTranslation({text:'你好',targetLanguage:'es'},'Hello thank you what are your plans'),/目标/)
  assert.throws(()=>validateTranslation({text:'你好',targetLanguage:'en-US'},' '),/为空/)
})
test('contact tone and glossary updates preserve remembered language, other contacts and account defaults',async()=>{
  const h=mainHarness();try{const {AccountManager}=h.load('src/main/accounts/accountManager.ts');const accounts=new AccountManager();const account=await accounts.add('signal','fixture')
    await accounts.updateContactLanguage(account.id,'peer-a','es','A','manual');await accounts.updateContactLanguage(account.id,'peer-b','fr','B','manual')
    const result=await accounts.updateContactQuality(account.id,'peer-a',{tone:'business',glossary:[{source:'Acme',target:'ACME'}]});assert.equal(result.contactLanguages['peer-a'].language,'es');assert.equal(result.contactLanguages['peer-b'].translationQuality,undefined);assert.equal(result.translationQuality,undefined)
    await accounts.updateContactLanguage(account.id,'peer-a','de','A','manual');assert.equal((await accounts.list())[0].contactLanguages['peer-a'].translationQuality.tone,'business')
    await accounts.updateContactQuality(account.id,'peer-a',null);assert.equal((await accounts.list())[0].contactLanguages['peer-a'].translationQuality,undefined)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('an explicit empty scoped glossary disables inherited entries without changing the parent',()=>{
  const base={glossary:[{source:'Acme',target:'ACME'}],tone:'natural'};assert.deepEqual(mergeQuality(base,{glossary:[]}),{tone:'natural',glossary:[]});assert.equal(base.glossary.length,1)
})
test('restoring a free local correction preserves the original receipt and does not invoke the provider',async()=>{
  const h=mainHarness();try{const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts');const engine=new TranslationEngine();engine.setOnlineSession('owner','fixture')
    const request={text:'hello',targetLanguage:'zh-CN',requestId:'fixed'};await engine.receipts.prepare('owner','openai',request);await engine.receipts.update('owner','fixed',{state:'charged',translated:'你好',chargedCharacters:5})
    engine.createProvider=()=>{throw Error('provider must not run')};await engine.correct('fixed','您好');await engine.restoreCorrection('fixed');const receipt=(await engine.history())[0];assert.equal(receipt.correction,undefined);assert.equal(receipt.translated,'你好');assert.equal(receipt.chargedCharacters,5)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('native retries retain their original request and language even when current contact settings changed',async()=>{
  const h=mainHarness();try{const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts');const engine=new TranslationEngine();engine.setOnlineSession('owner','fixture')
    const request={text:'original',accountId:'a',messageId:'m',conversationId:'c',targetLanguage:'es',sourceLanguage:'auto',requestId:'send-sd-first'};await engine.receipts.prepare('owner','openai',request)
    const kept=await engine.preserveOutgoingRequest({...request,targetLanguage:'fr',requestId:'send-sd-new-hash'});assert.equal(kept.requestId,'send-sd-first');assert.equal(kept.targetLanguage,'es')
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('a current request reconciles only its own ID while another pending result remains unavailable',async()=>{
  const h=mainHarness();try{const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts');const engine=new TranslationEngine();engine.setOnlineSession('owner','fixture')
    for(const id of ['blocked','current']){await engine.receipts.prepare('owner','openai',{text:id,targetLanguage:'zh-CN',requestId:id});await engine.receipts.update('owner',id,{state:'pending'})}
    const queried:string[]=[];engine.cloudProvider=()=>({status:async(id:string)=>{queried.push(id);return {state:'processing'}}});await engine.reconcilePending('current');assert.deepEqual(queried,['current'])
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('window restoration handles detached monitors, negative coordinates, high DPI work areas and malformed bounds',()=>{
  const h=mainHarness();try{const {fitWindow}=h.load('src/main/windowState.ts');const main={x:0,y:0,width:1366,height:728}
    assert.deepEqual(structuredClone(fitWindow({x:3000,y:0,width:1200,height:800},[main])),{x:83,y:0,width:1200,height:728})
    assert.equal(fitWindow({x:-1600,y:40,width:1200,height:700},[{x:-1920,y:0,width:1920,height:1080},main]).x,-1600)
    const small=fitWindow(undefined,[{x:0,y:0,width:683,height:384}]);assert.equal(small.width,683);assert.equal(small.height,384)
    assert.ok(Number.isFinite(fitWindow({x:NaN,y:0,width:0,height:-1},[main]).x))
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('performance history separates account counts, retains a bounded sample and reports measured percentiles',()=>{
  const samples=new PerformanceSamples();for(let n=1;n<=100;n++)samples.switch(n)
  samples.record(100,1,1,0);samples.record(110,2,1,300000);assert.equal(samples.record(121,3,1,600000).memoryGrowthPercent,10)
  const five=samples.record(500,10,5,630000);assert.equal(five.baselineMemoryMiB,null);assert.equal(five.switchP95Ms,95)
})

test('history freezes the original context and glossary after settings change, including a legacy stored key',async()=>{
  const h=mainHarness();try{
    const {MessageRequests}=h.load('src/main/translation/messageRequests.ts'),{JsonStore}=h.load('src/main/storage/jsonStore.ts')
    const original={cacheUserId:'owner',accountId:'a',conversationId:'c',messageId:'m',text:'Hello there',targetLanguage:'zh-CN',sourceLanguage:'auto',quality:{tone:'natural'},context:[{role:'user',text:'old context'}],requestId:'stored-message-legacy'}
    await new JsonStore('message-requests-v1.json',{}).write({'legacy-quality-hash':original})
    const requests=new MessageRequests(),changed={...original,requestId:undefined,quality:{tone:'business'},context:[{role:'user',text:'new context'}]}
    assert.equal((await requests.prepare(changed)).requestId,original.requestId)
    assert.equal((await requests.lookup(changed)).quality.tone,'natural')
    assert.equal((await requests.prepare({...changed,conversationId:'renamed contact'})).requestId,original.requestId)
    for(const different of [{...changed,messageId:'another'},{...changed,accountId:'other'},{...changed,cacheUserId:'other'},{...changed,targetLanguage:'es'},{...changed,text:'Edited source'}]){
      assert.notEqual((await requests.prepare(different)).requestId,original.requestId)
    }
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('a restarted engine restores the same historical translation after a tone change without provider work',async()=>{
  const h=mainHarness();try{
    const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts')
    const first=new TranslationEngine();first.setOnlineSession('owner','fixture')
    const input={accountId:'a',conversationId:'c',messageId:'m',text:'Hello there',targetLanguage:'zh-CN',quality:{tone:'natural'},cacheUserId:'owner'}
    const original=await first.messageRequests.prepare(input);await first.receipts.prepare('owner','openai',original)
    await first.receipts.update('owner',original.requestId,{state:'charged',translated:'你好',chargedCharacters:11})
    await first.cache.set('openai',original,'你好');await first.flush()
    const second=new TranslationEngine();second.setOnlineSession('owner','fixture');second.createProvider=()=>{throw Error('no new API request')}
    assert.equal(await second.cached({...input,quality:{tone:'business'}}),'你好')
    assert.equal((await second.history()).length,1);assert.equal((await second.history())[0].chargedCharacters,11)
    assert.equal(await second.cached({...input,messageId:'different'}),undefined)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('native historical translations keep request settings but isolate another conversation and edited body',async()=>{
  const h=mainHarness();try{
    const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),engine=new TranslationEngine();engine.setOnlineSession('owner','fixture')
    const original={requestId:'sd-first',accountId:'a',conversationId:'c',messageId:'m',text:'original',targetLanguage:'zh-CN',sourceLanguage:'auto',quality:{tone:'natural'}}
    await engine.receipts.prepare('owner','openai',original)
    const changed={...original,requestId:'sd-new-hash',quality:{tone:'business'}}
    assert.equal((await engine.preserveIncomingRequest(changed)).requestId,'sd-first')
    assert.equal((await engine.preserveIncomingRequest({...changed,conversationId:'other'})).requestId,'sd-new-hash')
    assert.equal((await engine.preserveIncomingRequest({...changed,text:'edited'})).requestId,'sd-new-hash')
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('native quick reply uses only the matching empty controlled editor and removes listeners on unmount',()=>{
  const {installHelloDogQuickReply}=require('../integrations/hellodog-source/hellodog.quick-reply.dom.ts')
  const target=new EventTarget();let text='',editable=true,conversationId='peer'
  const stop=installHelloDogQuickReply(target,()=>({conversationId,editable,empty:!text,insert:(value:string)=>{text=value}}))
  const dispatch=(id:string,value:string)=>{const detail={conversationId:id,text:value,accepted:false};target.dispatchEvent(new CustomEvent('hellodog-insert-draft',{detail}));return detail.accepted}
  assert.equal(dispatch('wrong','No'),false);assert.equal(text,'')
  editable=false;assert.equal(dispatch('peer','No'),false);editable=true
  assert.equal(dispatch('peer','Hello 👋'),true);assert.equal(text,'Hello 👋')
  assert.equal(dispatch('peer','Overwrite'),false);assert.equal(text,'Hello 👋')
  text='';stop();assert.equal(dispatch('peer','Unmounted'),false)
})
