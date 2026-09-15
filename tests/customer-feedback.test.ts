import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
import {createRequire} from 'node:module'
const {UnreadState,unreadBitmap}=createRequire(import.meta.url)('../src/main/unreadState.ts')
import {readSignalTyping,SignalTypingState} from '../src/shared/signalTyping.ts'

test('unread snapshots are independent per account; reopening and translation updates do not add or clear messages',()=>{
  const state=new UnreadState()
  assert.equal(state.set('wa-1',3),false);state.set('signal-1',5);state.set('wa-2',2)
  assert.equal(state.total,10);assert.equal(state.set('signal-1',5),false);assert.equal(state.total,10)
  assert.equal(state.set('signal-1',6),true);state.set('wa-1',0);assert.equal(state.total,8)
  state.set('signal-1',-1);state.set('signal-1',NaN);assert.equal(state.total,8)
  state.remove('wa-2');assert.deepEqual(state.snapshot(),{'wa-1':0,'signal-1':6});state.remove();assert.equal(state.total,0)
  for(const count of [1,5,99,100,20000]){const bitmap=unreadBitmap(count);assert.equal(bitmap.length,32*32*4);assert.ok(bitmap.includes(255));assert.equal(bitmap[3],0)}
})

test('Signal typing expires, respects stop/order, ignores stale packets and separates accounts and groups',()=>{
  const now=Date.now(),state=new SignalTypingState()
  const envelope=(action:string,timestamp=now)=>({sourceUuid:'peer',typingMessage:{action,timestamp}})
  const first=readSignalTyping('a',envelope('STARTED'),now)!;state.update(first)
  state.update({...first,account:'b'});state.update({...first,peer:'group:YWJj'})
  state.update(readSignalTyping('a',envelope('STOPPED',now+2),now+2)!)
  state.update(first);assert.equal(state.snapshot(now+3).length,2)
  assert.equal(state.snapshot(now+15001).length,0)
  assert.equal(readSignalTyping('a',envelope('STARTED',now-20000),now),undefined)
  assert.equal(readSignalTyping('a',envelope('UNKNOWN'),now),undefined)
  assert.equal(readSignalTyping('a',{...envelope('STARTED'),typingMessage:{action:'STARTED',timestamp:now,groupId:'YWJj'}},now)?.peer,'group:YWJj')
})

function adapterFixture(){
 const h=mainHarness(),cache=new Map<string,string>(),requests:any[]=[],events:any[]=[],record:any={id:'signal-a',platform:'signal',signalAccount:'+12025550100',historyMode:'visible'}
 const key=(r:any)=>JSON.stringify([r.accountId,r.conversationId,r.messageId,r.text,r.targetLanguage])
 const translator={cached:async(r:any)=>cache.get(key(r)),translateIncoming:async(r:any)=>{requests.push(r);cache.set(key(r),'这是译文');return '这是译文'},history:async()=>[]}
 const {SignalAdapter}=h.load('src/main/platforms/signal/signalAdapter.ts'),adapter=new SignalAdapter(translator)
 adapter.setOnlineUser('owner');adapter.accounts.list=async()=>[record];adapter.accounts.updateContactLanguage=async()=>{}
 adapter.settings.runtime=async()=>({localLanguage:'zh-CN',receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible'})
 adapter.attachMainWindow({webContents:{send:(channel:string,value:any)=>events.push({channel,value})}})
 return {h,adapter,requests,events,record,close:()=>rmSync(h.directory,{recursive:true,force:true})}
}

test('phone-synced outgoing Signal messages get a local-language display translation; cache replay does not bill twice',async()=>{
 const f=adapterFixture()
 try{
  const incoming={account:f.record.signalAccount,envelope:{sourceNumber:f.record.signalAccount,syncMessage:{sentMessage:{destinationNumber:'+12025550123',timestamp:Date.now(),message:'Incredible! Where is his son working now?'}}}}
  await f.adapter.onReceive(incoming)
  let history=await f.adapter.loadHistory(f.record.signalAccount)
  assert.equal(history[0].fromMe,true);assert.equal(history[0].displayTranslated,'这是译文');assert.equal(f.requests.length,1)
  await f.adapter.translateMessage(f.record.id,history[0],true);await f.adapter.onReceive(incoming)
  assert.equal(f.requests.length,1)
  incoming.envelope.syncMessage.sentMessage.timestamp++
  await f.adapter.onReceive(incoming);assert.equal(f.requests.length,2);assert.notEqual(f.requests[0].messageId,f.requests[1].messageId)
 }finally{f.close()}
})

test('a locally translated Signal send displays its saved original without paying for reverse translation',async()=>{
 const f=adapterFixture()
 try{
  const message={account:f.record.signalAccount,peer:'+12025550123',timestamp:Date.now(),fromMe:true,taskId:'original-task',original:'你好，很高兴见到你',translated:'Hello, nice to meet you'}
  await f.adapter.rememberMessage('owner',message)
  assert.equal(await f.adapter.translateMessage(f.record.id,message),'Hello, nice to meet you');assert.equal(f.requests.length,0)
  const other={...message,timestamp:message.timestamp+1,taskId:'english-task',original:'Hello, what are your plans today?',translated:'Hello, what are your plans today?'}
  await f.adapter.rememberMessage('owner',other);await f.adapter.translateMessage(f.record.id,other)
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].messageId,'english-task')
  const saved=(await f.adapter.loadHistory(f.record.signalAccount)).find((row:any)=>row.taskId==='english-task')
  assert.equal(saved.original,other.original);assert.equal(saved.translated,other.translated);assert.equal(saved.displayTranslated,'这是译文')
 }finally{f.close()}
})

test('Signal display honors history settings and cannot translate invented or expired renderer messages',async()=>{
 const f=adapterFixture()
 try{
  f.record.historyMode='new'
  const message={account:f.record.signalAccount,peer:'+12025550123',timestamp:42,fromMe:true,original:'What are you doing?'}
  await f.adapter.rememberMessage('owner',message)
  await f.adapter.translateMessage(f.record.id,message);assert.equal(f.requests.length,0)
  await f.adapter.translateMessage(f.record.id,{...message,timestamp:43,original:'invented'},true);assert.equal(f.requests.length,0)
  await f.adapter.translateMessage(f.record.id,message,true);assert.equal(f.requests.length,1)
  await f.adapter.rememberMessage('owner',{...message,timestamp:44,expiresAt:Date.now()-1})
  await f.adapter.translateMessage(f.record.id,{...message,timestamp:44},true);assert.equal(f.requests.length,1)
  await assert.rejects(f.adapter.translateMessage('another-account',message,true),/不匹配/)
 }finally{f.close()}
})

test('classic Signal refresh really checks connection and requests contact sync, without sending a message',async()=>{
 const f=adapterFixture(),calls:string[]=[]
 try{
  f.adapter.start=async()=>calls.push('start');f.adapter.cli.call=async(method:string)=>{calls.push(method);return []}
  await f.adapter.refreshAccount(f.record.id)
  assert.ok(calls.includes('sendSyncRequest'));assert.ok(!calls.includes('send'));assert.ok(f.events.some(e=>e.channel==='accounts:unread'))
  f.record.runtimeMode='paused';await assert.rejects(f.adapter.refreshAccount(f.record.id),/恢复/)
 }finally{f.close()}
})
