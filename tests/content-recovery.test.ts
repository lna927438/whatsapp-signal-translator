import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

const request = { text:'Please call tomorrow.', sourceLanguage:'en-US', targetLanguage:'zh-CN', accountId:'signal-a', conversationId:'signal-desktop:peer-a', messageId:'message-a' }
function setup() {
  const h = mainHarness(), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts')
  const engine = new TranslationEngine(); engine.setOnlineSession('owner','fixture-token'); engine.settings.get = async () => ({provider:'openai'})
  return { ...h, engine, TranslationEngine }
}
const removed = { owner:'owner', accountId:'signal-a', conversationId:'signal-desktop:peer-a', identity:'message-a', expiresAt:0, reason:'message' }

test('deleted message rejects late translation but preserves its actual charge and scrubs every local translation copy', async () => {
  const h = setup(), e = h.engine
  try {
    let release!:()=>void, entered!:()=>void
    const started = new Promise<void>(r=>entered=r), hold = new Promise<void>(r=>release=r)
    e.createProvider = () => ({translate:async (r:any)=>{ entered(); await hold; await e.receipts.update('owner',r.requestId,{state:'charged',translated:'明天打电话',chargedCharacters:21,balanceAfter:979});return '明天打电话' }})
    const task = e.translate({...request,context:[{role:'incoming',text:'private context'}]})
    const rejected = assert.rejects(task,/删除或过期/)
    await started; await e.trackContent([removed]); release(); await rejected
    const [receipt] = await e.history()
    assert.equal(receipt.state,'charged'); assert.equal(receipt.chargedCharacters,21);assert.equal(receipt.request.text,'');assert.equal(receipt.translated,undefined)
    const { JsonStore } = h.load('src/main/storage/jsonStore.ts')
    for (const file of ['message-requests-v1.json','translation-receipts-v1.json','translation-cache.json']) {
      const text = JSON.stringify(await new JsonStore(file,{}).read())
      assert.ok(!text.includes(request.text));assert.ok(!text.includes('private context'));assert.ok(!text.includes('明天打电话'))
    }
    const reopened = new h.TranslationEngine();reopened.setOnlineSession('owner','fixture-token');reopened.settings.get=e.settings.get
    reopened.createProvider = () => { throw new Error('Must not send another request') }
    await assert.rejects(reopened.translate({...request,requestId:'new-id',targetLanguage:'fr-FR'}),/删除或过期/)
    await assert.rejects(reopened.cached(request),/删除或过期/)
    await reopened.clearCache(); await assert.rejects(reopened.translate(request),/删除或过期/)
    await reopened.flush()
  } finally { await e.flush(); rmSync(h.directory,{recursive:true,force:true}) }
})

test('deadline survives restart; cleanup failure is retried and never marked finished early',async()=>{
  const h=setup(), e=h.engine
  try {
    const {TranslationContentPolicy}=h.load('src/main/translation/contentPolicy.ts'), policy=new TranslationContentPolicy()
    await policy.track([{...removed,expiresAt:Date.now()+60000}]);await policy.assertAvailable({...request,cacheUserId:'owner'})
    await policy.track([removed])
    const original=e.cache.expire.bind(e.cache);let calls=0
    e.cache.expire=async(...args:any[])=>{calls++;if(calls===1)throw new Error('disk unavailable');return original(...args)}
    await assert.rejects(e.sweepContent(),/disk unavailable/)
    assert.equal((await policy.due()).length,1)
    await e.sweepContent();assert.equal((await policy.due()).length,0)
    await policy.track([{...removed,expiresAt:Date.now()+999999}])
    await assert.rejects(new TranslationContentPolicy().assertAvailable({...request,cacheUserId:'owner'}),/删除或过期/)
    await policy.assertAvailable({...request,cacheUserId:'other-owner'})
    await policy.assertAvailable({...request,cacheUserId:'owner',accountId:'other-account'})
  }finally{await e.flush();rmSync(h.directory,{recursive:true,force:true})}
})

test('history loading cannot deliver the previous owner records after switching login',async()=>{
  const h=setup(),e=h.engine
  try{
    let release!:()=>void,entered!:()=>void
    const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
    e.receipts.list=async()=>{entered();await hold;return [{owner:'owner',request:{text:'previous owner content'}}]}
    const pending=e.history(),rejected=assert.rejects(pending,/登录状态已变化/)
    await started;e.setOnlineSession('other','test');release();await rejected
  }finally{await e.flush();rmSync(h.directory,{recursive:true,force:true})}
})

test('retention removes only old completed content, preserves pending drafts and monetary history, and is per owner',async()=>{
  const h=setup(),e=h.engine
  try {
    const {JsonStore}=h.load('src/main/storage/jsonStore.ts'), store=new JsonStore('translation-receipts-v1.json',[])
    const now=Date.now(), old=now-40*86400000
    const record=(id:string, state:string, owner='owner')=>({owner,requestId:id,request:{...request,requestId:id,messageId:id,cacheUserId:owner},provider:'openai',sourceCharacters:21,chargedCharacters:21,state,lastAccess:'request',translated:'text',createdAt:old,updatedAt:old})
    await store.write([record('complete','charged'),record('pending','pending'),record('unsent','charged'),record('other','charged','other'),{...record('new','charged'),createdAt:now}])
    e.onContentCleanup(async()=>{},async()=>new Set(['unsent']))
    assert.equal((await e.retentionInfo()).days,30);assert.equal((await e.retentionInfo(30)).affected,1)
    await e.setRetention(30)
    const records=await store.read()
    assert.equal(records.find((r:any)=>r.requestId==='complete').contentExpired,true)
    assert.equal(records.find((r:any)=>r.requestId==='complete').chargedCharacters,21)
    for(const id of ['pending','unsent','other','new'])assert.equal(records.find((r:any)=>r.requestId===id).request.text,request.text)
    e.setOnlineSession('other','test');assert.equal((await e.retentionInfo()).days,30)
    await assert.rejects(e.setRetention(1),/保留期/)
  }finally{await e.flush();rmSync(h.directory,{recursive:true,force:true})}
})

test('pending contextual request is scrubbed after deletion and can query but cannot repost altered context',async()=>{
  const h=setup(),e=h.engine
  try{
    const pending={...request,messageId:'message-b',requestId:'pending-b',cacheUserId:'owner',context:[{role:'incoming',text:'deleted message text'}]}
    await e.receipts.prepare('owner','openai',pending);await e.receipts.update('owner','pending-b',{state:'pending'})
    await e.trackContent([removed]);assert.equal((await e.history())[0].request.context.length,0)
    e.cloudProvider=()=>({status:async()=>({state:'not_found'})})
    await assert.rejects(e.retryOriginal('pending-b'),/只能查询/)
    assert.equal((await e.history())[0].state,'pending')
  }finally{await e.flush();rmSync(h.directory,{recursive:true,force:true})}
})

test('a stalled recovery lane cannot block other services or duplicate itself on resume/unlock',async()=>{
  const h=mainHarness()
  try{
    const {RecoveryCoordinator}=h.load('src/main/recoveryCoordinator.ts'), coordinator=new RecoveryCoordinator()
    let release!:()=>void, starts=0, good=0
    const hold=new Promise<void>(r=>release=r), jobs={stalled:()=>{starts++;return hold},healthy:async()=>{good++}}
    const [first,second]=await Promise.all([coordinator.run('owner',jobs,15),coordinator.run('owner',jobs,15)])
    assert.equal(starts,1);assert.equal(good,1);assert.ok(first.find((r:any)=>r.name==='healthy').ok);assert.ok(!second.find((r:any)=>r.name==='stalled').ok)
    await coordinator.run('owner',jobs,10);assert.equal(starts,1);assert.equal(good,2)
    release();await hold;await new Promise(r=>setTimeout(r,0))
    await coordinator.run('owner',jobs,15);assert.equal(starts,2)
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('ambiguous slang, names, negation, questions, context and other languages cannot become canned insults',()=>{
  const h=mainHarness(),{deterministicChatTranslation}=h.load('src/main/translation/slang.ts')
  try {
  for(const text of ['cap','based','NPC','SB','TM','no cap?','not bad','I am not angry','idk?','idk\nwhy'])assert.equal(deterministicChatTranslation({...request,text}),undefined)
  assert.equal(deterministicChatTranslation({...request,text:'brb',sourceLanguage:'fr'}),undefined)
  assert.equal(deterministicChatTranslation({...request,text:'brb',sourceLanguage:'auto'}),undefined)
  assert.equal(deterministicChatTranslation({...request,text:'brb',context:[{role:'incoming',text:'What does BRB stand for in this paper?'}]}),undefined)
  assert.equal(deterministicChatTranslation({...request,text:'brb'}),'马上回来')
  assert.equal(deterministicChatTranslation({...request,text:'brb',targetLanguage:'zh-TW'}),'馬上回來')
  }finally{rmSync(h.directory,{recursive:true,force:true})}
})
