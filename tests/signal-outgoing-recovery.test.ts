import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync,readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {mainHarness} from './main-harness.ts'

const original='What is your point of view?',bad='作为一个人工智能，我没有个人观点或情感。',good='你的观点是什么？'
const request={text:original,sourceLanguage:'en-US',targetLanguage:'zh-CN',accountId:'signal-fixture',conversationId:'signal-desktop:conversation-fixture',messageId:'message-fixture',requestId:'send-sd-fixture'}
async function fixture(input=request,translation=bad){
  const h=mainHarness(),{TranslationEngine}=h.load('src/main/translation/translationEngine.ts'),engine=new TranslationEngine();
  engine.setOnlineSession('owner','fixture');engine.createProvider=()=>{throw Error('No paid translation allowed')};
  engine.cloudProvider=()=>({repair:async()=>{throw Error('No repair configured')}});
  await engine.receipts.prepare('owner','openai',input);
  await engine.receipts.update('owner',input.requestId,{state:'charged',translated:translation,chargedCharacters:Array.from(input.text).length,balanceAfter:700});
  return {...h,engine,restore:()=>engine.restoreSignalOutgoing(input.requestId,input.accountId,input.conversationId,input.messageId,input.text),close:()=>rmSync(h.directory,{recursive:true,force:true})};
}

function nativeAuthorization(f:Awaited<ReturnType<typeof fixture>>,input=request,balance=100,blockChineseSend=! /^(zh|ja)(-|$)/.test(input.targetLanguage)){
  const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8');
  const start=source.indexOf('  const signalDesktop = new SignalDesktopHost('),end=source.indexOf("  ipcMain.handle('signal-desktop:status'");assert.ok(start>0&&end>start);
  let handler:Function=()=>assert.fail('Native handler not captured'),creditReads=0,settlementReads=0,authorized=true;
  const {OutgoingCredit}=f.load('src/main/translation/outgoingCredit.ts');
  const outgoingCredit=new OutgoingCredit(()=> 'owner',async()=>{creditReads++;return{user:{id:'owner'},profile:{status:'active'},wallet:{balance,reserved_characters:0}}},async(id:string)=>{settlementReads++;return{state:'completed',response:{requestId:id,sourceCharacters:Array.from(input.text).length,translation:'Original paid result'}}});
  runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    SignalDesktopHost:class{constructor(_window:any,_owner:any,translate:Function){handler=translate}},mainWindow:{},onlineIdentity:{userId:'owner'},sendPolicyChanging:0,
    taskIdentity:()=>({owner:'owner',authorized:()=>authorized}),accounts:{list:async()=>[{id:input.accountId,platform:'signal',signalEngine:'desktop'}]},
    // These legacy recovery fixtures intentionally translate English into a
    // Chinese target; the current explicit send switch must be disabled.
    accountRuntime:async()=>({blockChineseSend}),translator:f.engine,outgoingCredit,
    ...f.load('src/main/translation/outgoingPolicy.ts'),
    validateTranslation:f.load('src/main/translation/translationValidation.ts').validateTranslation,
  });
  return {invoke:(patch:any={})=>handler(input.accountId,{id:input.messageId,conversationId:input.conversationId.replace('signal-desktop:',''),direction:'outgoing',authorizationOnly:true,requestId:input.requestId,text:input.text,translated:bad,...patch},0),creditReads:()=>creditReads,settlementReads:()=>settlementReads,revoke:()=>{authorized=false}};
}

test('native retry cannot send an old English translation of Chinese after the user switches to original-only Chinese',async()=>{
 const input={...request,text:'请确认明天的会议。',sourceLanguage:'zh-CN',targetLanguage:'en-US'},translated='Please confirm the meeting tomorrow.'
 const f=await fixture(input,translated)
 try{
  const native=nativeAuthorization(f,input,100,false)
  await assert.rejects(native.invoke({translated}),/发送原文/)
  assert.equal(native.creditReads(),0);assert.equal(native.settlementReads(),0)
  await assert.rejects(native.invoke({text:translated,translated}),/尚未核实/)
 }finally{f.close()}
})

test('native authorization recovers a free correction while retaining original charged receipt and request identity',async()=>{
  const f=await fixture();try{
    await f.engine.correct(request.requestId,good);
    // This mismatch strands the native retry in the previous implementation.
    await assert.rejects(f.engine.existingOutgoing(request.requestId,request.accountId,request.conversationId,original,bad),/尚未核实/);
    const result=await f.restore();assert.equal(result.text,good);assert.equal(result.request.requestId,request.requestId);
    const rows=await f.engine.history();assert.equal(rows.length,1);assert.equal(rows[0].chargedCharacters,original.length);assert.equal(rows[0].balanceAfter,700);assert.equal(rows[0].translated,bad);
  }finally{f.close()}
})

test('quarantined native retry uses one free repair and never creates a replacement translation request',async()=>{
  const f=await fixture();try{
    let calls=0;f.engine.cloudProvider=()=>({repair:async(r:any)=>{calls++;assert.equal(r.requestId,request.requestId);return{translation:good}}});
    const values=await Promise.all([f.restore(),f.restore()]);assert.equal(calls,1);assert.ok(values.every(v=>v.text===good));
    const rows=await f.engine.history();assert.equal(rows.length,1);assert.equal(rows[0].correctionSource,'cloud-repair');assert.equal(rows[0].chargedCharacters,original.length);
  }finally{f.close()}
})

test('native recovery binds the original owner, account, conversation, message ID and source before repair',async()=>{
  const f=await fixture();try{
    let calls=0;f.engine.cloudProvider=()=>({repair:async()=>{calls++;return{translation:good}}});
    const args=[request.requestId,request.accountId,request.conversationId,request.messageId,original];
    for(let i=0;i<args.length;i++){const changed=[...args];changed[i]+='-changed';await assert.rejects(f.engine.restoreSignalOutgoing(...changed),/尚未核实/)}
    f.engine.setOnlineSession('other-owner','fixture');await assert.rejects(f.restore(),/尚未核实/);assert.equal(calls,0);
  }finally{f.close()}
})

test('a failed free repair cannot authorize the old answer or fall back to a new paid translation',async()=>{
  const f=await fixture();try{
    let calls=0;f.engine.cloudProvider=()=>({repair:async()=>{calls++;throw Error('temporary failure')}});
    await assert.rejects(f.restore(),/免费修正/);await assert.rejects(f.restore(),/免费修正/);assert.equal(calls,1);
    await f.engine.correct(request.requestId,good);assert.equal((await f.restore()).text,good);
    const rows=await f.engine.history();assert.equal(rows.length,1);assert.equal(rows[0].chargedCharacters,original.length);
  }finally{f.close()}
})

test('session changes and message expiry during native recovery reject the result without changing settlement',async()=>{
  for(const change of ['session','expiry']){
    const f=await fixture();try{
      let finish:Function=()=>{},started:Function=()=>{};const ready=new Promise<void>(resolve=>{started=resolve});
      f.engine.cloudProvider=()=>({repair:()=>new Promise(resolve=>{finish=resolve;started()})});
      const task=f.restore();await ready;
      if(change==='session')f.engine.setOnlineSession('other-owner','fixture');else await f.engine.receipts.expireMessage('owner',request.accountId,request.conversationId,request.messageId);
      finish({translation:good});await assert.rejects(task,/登录状态|过期/);
      const receipt=await f.engine.receipts.get('owner',request.requestId);assert.equal(receipt.chargedCharacters,original.length);assert.equal(receipt.correction,undefined);
    }finally{f.close()}
  }
})

test('actual native IPC authorizes the repaired original at zero balance without another character debit',async()=>{
  const input={...request,text:'你有什么观点？',sourceLanguage:'zh-CN',targetLanguage:'en-US'},answer='What is your point of view?';
  const f=await fixture(input,'As an AI, I do not have personal opinions.');try{
    await f.engine.correct(input.requestId,answer);const bridge=nativeAuthorization(f,input,0),result=await bridge.invoke();
    assert.equal(result.authorized,true);assert.equal(result.text,answer);assert.equal(result.requestId,input.requestId);assert.equal(bridge.creditReads(),1);assert.equal(bridge.settlementReads(),1);
    const rows=await f.engine.history();assert.equal(rows.length,1);assert.equal(rows[0].chargedCharacters,Array.from(input.text).length);assert.equal(rows[0].balanceAfter,700);
  }finally{f.close()}
})

test('actual native IPC never authorizes Chinese output for English or a revoked session',async()=>{
  const input={...request,text:'你好',sourceLanguage:'zh-CN',targetLanguage:'en-US'},f=await fixture(input,'Hello');try{
    await f.engine.correct(input.requestId,'中文错误');const blocked=nativeAuthorization(f,input);await assert.rejects(blocked.invoke(),/含中文/);assert.equal(blocked.creditReads(),0);
    await f.engine.correct(input.requestId,'Hello');const stale=nativeAuthorization(f,input);stale.revoke();await assert.rejects(stale.invoke(),/登录状态/);
    assert.equal((await f.engine.history()).length,1);
  }finally{f.close()}
})

test('native edit receipts cannot borrow another revision or the legacy original message even when their source is identical',async()=>{
  const f=await fixture();try{
    await f.engine.correct(request.requestId,good);
    const edit={...request,requestId:'send-sd-edit-200',signalEditTimestamp:200};
    assert.equal((await f.engine.preserveOutgoingRequest(edit)).requestId,edit.requestId);
    await f.engine.receipts.prepare('owner','openai',edit);await f.engine.receipts.update('owner',edit.requestId,{state:'charged',translated:good,chargedCharacters:original.length,balanceAfter:650});
    assert.equal((await f.engine.preserveOutgoingRequest({...edit,requestId:'send-sd-recreated'})).requestId,edit.requestId);
    assert.equal((await f.engine.preserveOutgoingRequest({...edit,requestId:'send-sd-edit-300',signalEditTimestamp:300})).requestId,'send-sd-edit-300');
    const restore=(id:string,revision?:number)=>f.engine.restoreSignalOutgoing(id,request.accountId,request.conversationId,request.messageId,original,revision);
    assert.equal((await restore(edit.requestId,200)).text,good);
    const bridge=nativeAuthorization(f,edit);assert.equal((await bridge.invoke({editTimestamp:200})).requestId,edit.requestId);
    await assert.rejects(bridge.invoke({editTimestamp:300}),/尚未核实/);
    for(const [id,revision] of [[edit.requestId,undefined],[edit.requestId,300],[request.requestId,200],[edit.requestId,0]] as const)await assert.rejects(restore(id,revision),/尚未核实/);
    assert.equal((await f.restore()).text,good);
  }finally{f.close()}
})
