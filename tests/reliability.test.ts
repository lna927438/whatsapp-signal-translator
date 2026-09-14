import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'
import { normalizeQuality, protectLiterals, qualityKey } from '../src/shared/translationPolicy.ts'
const request={text:'Please confirm the revised proposal.',sourceLanguage:'auto',targetLanguage:'zh-CN',accountId:'a',conversationId:'wa:peer',messageId:'msg-a',cacheUserId:'owner',context:[]}

test('same text on different messages or manual requests never shares the message cache',async()=>{
 const h=mainHarness();try {
 const {TranslationCache}=h.load('src/main/translation/cache.ts');const cache=new TranslationCache()
 await cache.set('openai',request,'请确认修订后的方案。')
 assert.equal(await cache.get('openai',{...request,messageId:'msg-b'}),undefined)
 assert.equal(await cache.get('openai',{...request,quality:{tone:'business'}}),undefined)
 await cache.set('openai',{...request,messageId:undefined,requestId:'manual-a'},'独立译文')
 assert.equal(await cache.get('openai',{...request,messageId:undefined,requestId:'manual-b'}),undefined)
 assert.equal(await cache.get('openai',{...request,messageId:undefined,requestId:'manual-a'}),'独立译文')
 } finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('URL, email, international phone, numbers and glossary values survive a checked round trip',()=>{
 const original='Acme: https://example.test/a?q=7, email alex@example.test or +1 (415) 555-0123. Budget 1250.50.'
 const protectedText=protectLiterals(original,{tone:'business',glossary:[{source:'Acme',target:'艾克米'}]})
 assert.ok(!protectedText.input.includes('https://'));assert.ok(!protectedText.input.includes('+1'))
 assert.equal(protectedText.restore(protectedText.input),original.replace('Acme','艾克米'))
 assert.throws(()=>protectedText.restore('Missing every placeholder'),/protected_literal_mismatch/)
 assert.throws(()=>protectedText.restore(protectedText.input+protectedText.input),/protected_literal_mismatch/)
 assert.equal(qualityKey({}), '')
 assert.equal(normalizeQuality({}),undefined)
 assert.throws(()=>normalizeQuality({glossary:[{source:'A',target:'B'},{source:'A',target:'C'}]}))
 const collision=protectLiterals('HDPROTECTED 123');assert.equal(collision.restore(collision.input),'HDPROTECTED 123')
})

test('literal preservation accepts harmless Markdown escapes and exact restored values, but rejects changed or repeated numbers',()=>{
 const p=protectLiterals('Bitcoin at $1.00 😬😬😬');
 assert.equal(p.restore('比特币当时 $\\_\\_HDPROTECTED\\_0\\_\\_ 😬😬😬'),'比特币当时 $1.00 😬😬😬');
 assert.equal(p.restore('比特币当时 $1.00 😬😬😬'),'比特币当时 $1.00 😬😬😬');
 assert.throws(()=>p.restore('比特币当时 $100.00'),/protected_literal/);
 assert.throws(()=>p.restore('$1.00 和 $1.00'),/protected_literal/);
 const twice=protectLiterals('It was 12, now 12');assert.throws(()=>twice.restore('现在是12'),/protected_literal/);
 const small=protectLiterals('It was 1');assert.throws(()=>small.restore('现在是1.00'),/protected_literal/);
 assert.throws(()=>p.restore('__HDPROTECTED_9__'),/protected_literal/);
})

test('durable draft ownership and conditional clearing protect another recipient and a newer draft',async()=>{
 const h=mainHarness();try{
 const {Drafts}=h.load('src/main/storage/drafts.ts');const drafts=new Drafts()
 const target={accountId:'a',conversationId:'wa:peer'}
 await drafts.save('owner',target,'original')
 assert.equal(await new Drafts().get('owner',target),'original')
 assert.equal(await drafts.get('other',target),'')
 assert.equal(await drafts.get('owner',{...target,conversationId:'wa:other'}),'')
 await drafts.save('owner',target,'newer')
 await drafts.save('owner',target,'','original')
 assert.equal(await drafts.get('owner',target),'newer')
 await drafts.save('owner',target,'','newer')
 assert.equal(await drafts.get('owner',target),'')
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('settlement survives restart and cache clearing; free correction cannot create another charge',async()=>{
 const h=mainHarness();try {
 const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts')
 let calls=0
 const engine=new TranslationEngine();engine.setOnlineSession('owner','test');engine.settings.get=async()=>({provider:'openai'})
 engine.createProvider=()=>({translate:async(r:any)=>{calls++;await engine.receipts.update('owner',r.requestId,{state:'charged',sourceCharacters:r.text.length,chargedCharacters:r.text.length,balanceAfter:900,translated:'已确认方案'});return '已确认方案'}})
 await engine.translate(request)
 const id=(await engine.history())[0].requestId
 await engine.correct(id,'请确认新版方案。');await engine.clearCache()
 const reopened=new TranslationEngine();reopened.setOnlineSession('owner','test');reopened.settings.get=async()=>({provider:'openai'})
 reopened.createProvider=()=>{throw new Error('Must not request paid translation')}
 assert.equal(await reopened.translate(request),'请确认新版方案。')
 assert.equal(calls,1);assert.equal((await reopened.history())[0].chargedCharacters,request.text.length)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('unknown translation after restart queries only its original ID and cannot guess a success',async()=>{
 const h=mainHarness();try {
 const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts')
 const e=new TranslationEngine();e.setOnlineSession('owner','test');e.settings.get=async()=>({provider:'openai'})
 e.createProvider=()=>({translate:async()=>{throw new TypeError('simulated transport loss')}})
 await assert.rejects(e.translate(request))
 let posts=0,lookups=0
 const r=new TranslationEngine();r.setOnlineSession('owner','test');r.settings.get=async()=>({provider:'openai'})
 r.createProvider=()=>{posts++;throw new Error('Must not resend')}
 r.cloudProvider=()=>({status:async(id:string)=>{lookups++;return {state:'processing'}}})
 await assert.rejects(r.translate(request),/待确认/)
 assert.equal(posts,0);assert.equal(lookups,1);assert.equal((await r.history())[0].state,'pending')
 const id=(await r.history())[0].requestId
 r.cloudProvider=()=>({status:async(requestId:string)=>({state:'completed',response:{requestId,sourceCharacters:request.text.length,balanceAfter:900,translation:'恢复后的译文'}})})
 await r.reconcilePending()
 assert.equal(await r.translate(request),'恢复后的译文');assert.equal(posts,0)
 assert.equal((await r.history())[0].requestId,id)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('settings backup excludes keys and chat data, validates its schema and leaves scoped options intact',()=>{
 const h=mainHarness();try {
 const {makeSettingsBackup,parseSettingsBackup}=h.load('src/main/storage/settingsBackup.ts')
 const source={localLanguage:'zh-CN',targetLanguage:'en-US',closeToTray:true,openaiApiKey:'secret-test',deeplApiKey:'secret-test',accounts:[{session:'private'}],chats:['private'],quickReplies:['Got it.'],translationQuality:{tone:'business'}}
 const backup=makeSettingsBackup(source),json=JSON.stringify(backup)
 assert.ok(!json.includes('secret-test'));assert.ok(!json.includes('private'));assert.ok(!json.includes('accounts'))
 const restored=parseSettingsBackup(json).settings;assert.equal(restored.targetLanguage,'en-US');assert.equal(restored.translationQuality.tone,'business')
 assert.throws(()=>parseSettingsBackup('{}'))
 assert.throws(()=>parseSettingsBackup(JSON.stringify({...backup,settings:{fontSize:1000}})))
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('receipt identity rejects changed quality or context; unreadable journals fail closed',async()=>{
 const h=mainHarness();try {
 const {TranslationReceipts}=h.load('src/main/translation/receipts.ts');const receipts=new TranslationReceipts()
 await receipts.prepare('owner','openai',{...request,requestId:'fixed'})
 await assert.rejects(receipts.prepare('owner','openai',{...request,requestId:'fixed',quality:{tone:'business'}}))
 await assert.rejects(receipts.prepare('owner','openai',{...request,requestId:'fixed',context:[{role:'incoming',text:'new'}]}))
 writeFileSync(h.directory+'/translation-receipts-v1.json','broken')
 await assert.rejects(new TranslationReceipts().list('owner'))
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
