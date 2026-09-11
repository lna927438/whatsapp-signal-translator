import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'
const request = { text: 'How is your project going today?', sourceLanguage:'auto', targetLanguage:'zh-CN', accountId:'account-a', conversationId:'wa:alex', messageId:'false_peer@c.us_message1', cacheUserId:'user-a', context:[{role:'incoming',text:'old context'}] }

test('cached message survives provider changes, contact rename and restart without leaking across users or languages', async () => {
  const h=mainHarness()
  try {
    const {TranslationCache}=h.load('src/main/translation/cache.ts')
    await new TranslationCache().set('openai',request,'项目进展如何？')
    const cache=new TranslationCache()
    assert.equal(await cache.get('deepseek',{...request,conversationId:'wa:renamed',context:[]}), '项目进展如何？')
    assert.equal(await cache.get('deepseek',{...request,cacheUserId:'user-b'}),undefined)
    assert.equal(await cache.get('deepseek',{...request,targetLanguage:'fr-FR'}),undefined)
    assert.equal(await cache.get('deepseek',{...request,text:'A different message'}),undefined)
    await cache.clear('user-b'); assert.equal((await cache.stats('user-a')).translations,1)
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})

test('persistent message requests freeze initial context and request ID after restart and reject a corrupt ledger', async () => {
  const h=mainHarness()
  try {
    const {MessageRequests}=h.load('src/main/translation/messageRequests.ts')
    const first=await new MessageRequests().prepare(request)
    const second=await new MessageRequests().prepare({...request,conversationId:'wa:new name',context:[]})
    assert.equal(first.requestId,second.requestId)
    assert.equal(JSON.stringify(first.context),JSON.stringify(second.context))
    assert.equal(second.conversationId,first.conversationId)
    const other=await new MessageRequests().prepare({...request,cacheUserId:'user-b'})
    assert.notEqual(other.requestId,first.requestId)
    const {writeFileSync}=await import('node:fs'); writeFileSync(h.directory+'/message-requests-v1.json','broken')
    await assert.rejects(new MessageRequests().prepare(request))
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})

test('twenty engine calls use one provider call and reopening serves persistent cache; clearing cache reuses original request', async () => {
  const h=mainHarness()
  try {
    const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts')
    let calls=0; const ids:string[]=[]
    const create=()=>{const e=new TranslationEngine();e.setOnlineSession('user-a','synthetic-token');e.settings.get=async()=>({provider:'openai'});e.createProvider=()=>({translate:async(r:any)=>{calls++;ids.push(r.requestId);await new Promise(resolve=>setTimeout(resolve,5));return '项目进展如何？'}});return e}
    const engine=create()
    await Promise.all(Array.from({length:20},()=>engine.translate({...request})))
    assert.equal(calls,1)
    const reopened=create();assert.equal(await reopened.translate({...request,conversationId:'wa:renamed',context:[]}), '项目进展如何？');assert.equal(calls,1)
    await reopened.clearCache();await reopened.translate({...request,conversationId:'wa:renamed',context:[]})
    assert.equal(ids[0],ids[1]) // Upstream replay uses its original immutable payload, so the server can deduplicate it.
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})
