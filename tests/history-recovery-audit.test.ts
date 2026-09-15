import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'

for (const manual of [false,true]) test(`Signal ${manual?'manual':'automatic'} history recovers a failed local save without translating or charging again`,async()=>{
  const h=mainHarness();let translations=0,cached:string|undefined;
  try {
    const {SignalAdapter}=h.load('src/main/platforms/signal/signalAdapter.ts');
    const adapter=new SignalAdapter({cached:async()=>cached,translateIncoming:async()=>{translations++;cached='你今天过得怎么样？';return cached}});
    const identity={account:'+12025550100',peer:'10000000-0000-4000-8000-000000000001',timestamp:1,fromMe:false};
    adapter.setOnlineUser('owner');adapter.accounts.list=async()=>[{id:'a',platform:'signal',signalAccount:identity.account}];
    adapter.settings.runtime=async()=>({localLanguage:'zh-CN',receiveAutoTranslate:true,historyMode:'visible'});
    await adapter.historyStore.write([{...identity,owner:'owner',original:'How was your day?'}]);
    const write=adapter.historyStore.write.bind(adapter.historyStore);let fail=true;
    adapter.historyStore.write=async(data:any)=>{if(fail){fail=false;throw Error('temporary disk failure')}return write(data)};
    await assert.rejects(adapter.translateMessage('a',identity,manual),/temporary disk failure/);
    assert.equal(translations,1);
    // No fresh receive, refresh, restart or other history write intervenes.
    assert.equal(await adapter.translateMessage('a',identity,manual),cached);
    assert.equal(translations,1);
    assert.equal((await adapter.historyStore.read())[0].translated,cached);
    adapter.historyStore.read=async()=>{throw Error('history still unreadable')};
    await assert.rejects(adapter.translateMessage('a',identity,manual),/history still unreadable/);
    assert.equal(translations,1);
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})

test('lost local settlement save keeps the pending history identity and later restores the cloud result without a new inference',async()=>{
  const h=mainHarness();
  try {
    const {TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),e=new TranslationEngine();
    e.setOnlineSession('owner','fixture');e.settings.get=async()=>({provider:'openai'});
    const request={text:'How was your day at the lake?',accountId:'wa',conversationId:'peer',messageId:'false_peer@c.us_audit',sourceLanguage:'auto',targetLanguage:'zh-CN'};
    const original=await e.messageRequests.prepare({...request,cacheUserId:'owner'});
    await e.receipts.prepare('owner','openai',original);await e.receipts.update('owner',original.requestId,{state:'pending'});
    let statuses=0,providerCalls=0;
    e.createProvider=()=>({translate:async()=>{providerCalls++;throw Error('must not reinfer')}});
    e.cloudProvider=()=>({status:async(id:string)=>{statuses++;assert.equal(id,original.requestId);return {state:'completed',response:{requestId:id,translation:'今天在湖边过得怎么样？',sourceCharacters:Array.from(request.text).length,balanceAfter:800}}}});
    const update=e.receipts.update.bind(e.receipts);let fail=true;
    e.receipts.update=async(owner:string,id:string,patch:any)=>{if(patch.state==='charged'&&fail){fail=false;throw Error('temporary settlement write failure')}return update(owner,id,patch)};
    await assert.rejects(e.translateIncoming(request),/核对|确认/);
    assert.equal((await e.receipts.get('owner',original.requestId)).state,'pending');
    assert.equal((await e.messageRequests.lookup({...request,cacheUserId:'owner'})).requestId,original.requestId);
    assert.equal(await e.translateIncoming(request,true),'今天在湖边过得怎么样？');
    assert.equal(providerCalls,0);assert.equal(statuses,2);
    const receipts=await e.history();assert.equal(receipts.length,1);assert.equal(receipts[0].state,'charged');
    assert.equal(receipts[0].chargedCharacters,Array.from(request.text).length);
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})
