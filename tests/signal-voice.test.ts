import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import type { SignalVoiceItem } from '../integrations/hellodog-source/hellodog.voice.dom.ts'
import { mainHarness } from './main-harness.ts'
const uiExports:any={}
runInNewContext(ts.transpileModule(readFileSync(new URL('../integrations/hellodog-source/hellodog.voice.dom.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:uiExports,Date})
const createSignalVoiceUi=uiExports.createSignalVoiceUi as typeof import('../integrations/hellodog-source/hellodog.voice.dom.ts').createSignalVoiceUi
const {decodeSignalVoiceRequest}=mainHarness().load('src/main/platforms/signal/signalDesktopVoice.ts')

const answer = {text:'How are you?',translation:'你好吗？',audioId:'b'.repeat(64),targetLanguage:'zh-CN' as const}
const flush = async () => { await new Promise(resolve=>setImmediate(resolve)) }
function fixture(translate: (item:SignalVoiceItem,current:()=>boolean)=>Promise<typeof answer> = async()=>answer) {
  const dom = new JSDOM('<div data-hellodog-id="message-a"><div class="module-message__container"><audio></audio></div></div>')
  let items:SignalVoiceItem[]=[{id:'message-a',conversationId:'conversation-a',attachmentId:'a'.repeat(64),ready:true}]
  let selected='conversation-a',calls=0
  const ui=createSignalVoiceUi({document:dom.window.document,items:id=>items.filter(item=>item.id===id),selectedConversation:()=>selected,
    translate:async(item,current)=>{calls++;return translate(item,current)}})
  ui.scan()
  return {ui,dom,calls:()=>calls,items:(value:SignalVoiceItem[])=>{items=value;ui.scan()},select:(value:string)=>{selected=value;ui.scan()},
    button:()=>dom.window.document.querySelector('button')!,close:()=>{ui.dispose();dom.window.close()}}
}

test('native Signal pure voice has an explicit Chinese action, no automatic ASR or sending, and repeated clicks deduplicate',async()=>{
  let finish!:(value:typeof answer)=>void
  const f=fixture(()=>new Promise(resolve=>{finish=resolve}))
  try{assert.equal(f.calls(),0);assert.equal(f.button().textContent,'转为中文');f.button().click();f.button().click();assert.equal(f.calls(),1);assert.equal(f.button().disabled,true)
    finish(answer);await flush();assert.match(f.dom.window.document.body.textContent!,/你好吗/);f.button().click();assert.equal(f.calls(),1)
  }finally{f.close()}
})
test('native Signal failure exposes retry and a successful retry displays Chinese',async()=>{
  let attempt=0;const f=fixture(async()=>{if(++attempt===1)throw new Error('private payload');return answer})
  try{f.button().click();await flush();assert.equal(f.button().textContent,'重试语音翻译');assert.doesNotMatch(f.dom.window.document.body.textContent!,/private payload/)
    f.button().click();await flush();assert.equal(f.calls(),2);assert.match(f.dom.window.document.body.textContent!,/你好吗/)
  }finally{f.close()}
})
test('native Signal rejects late results after switching conversation, deletion, expiry or disposal',async()=>{
  for(const change of ['conversation','deletion','expiry','dispose']){
    let finish!:(value:typeof answer)=>void,current!:()=>boolean
    const f=fixture((_item,valid)=>{current=valid;return new Promise(resolve=>{finish=resolve})})
    try{f.button().click();if(change==='conversation')f.select('other');else if(change==='dispose')f.ui.dispose();else if(change==='deletion')f.items([]);else f.items([{id:'message-a',conversationId:'conversation-a',attachmentId:'a'.repeat(64),ready:true,expiresAt:Date.now()-1}])
      assert.equal(current(),false);finish(answer);await flush();assert.doesNotMatch(f.dom.window.document.body.textContent!,/你好吗/)
    }finally{f.close()}
  }
})
test('native Signal un-downloaded voice does not read audio; downloading then retrying works',async()=>{
  const f=fixture();const item={id:'message-a',conversationId:'conversation-a',attachmentId:'a'.repeat(64),ready:false}
  try{f.items([item]);f.button().click();await flush();assert.equal(f.calls(),0);assert.match(f.dom.window.document.body.textContent!,/先下载/)
    f.items([{...item,ready:true}]);f.button().click();await flush();assert.equal(f.calls(),1)
  }finally{f.close()}
})
test('native Signal renders translator output as text and rejects a non-Chinese target contract',async()=>{
  const f=fixture(async()=>({...answer,translation:'<img src=x onerror="bad()">中文'}))
  try{f.button().click();await flush();assert.equal(f.dom.window.document.querySelector('img'),null);assert.match(f.dom.window.document.body.textContent!,/中文/)}finally{f.close()}
  const g=fixture(async()=>({...answer,targetLanguage:'en' as any}));try{g.button().click();await flush();assert.equal(g.button().textContent,'重试语音翻译')}finally{g.close()}
})
function wav(){
  const bytes=Buffer.alloc(3244);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22)
  bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40)
  for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(Math.round(Math.sin(i)*10000),i)
  return bytes
}
test('native private voice IPC accepts only bounded canonical PCM plus stable owned identifiers, never a path or arbitrary URL',()=>{
  const input={id:'message-a',conversationId:'conversation-a',attachmentId:'a'.repeat(64),audioBase64:wav().toString('base64')}
  const good=decodeSignalVoiceRequest(input);assert.equal(good.bytes.length,3244);assert.equal(good.id,'message-a')
  for(const patch of [{id:'../message'},{conversationId:''},{attachmentId:'file:///secret'},{audioBase64:' '+input.audioBase64},{audioBase64:Buffer.from('not audio').toString('base64')},{expiresAt:0},{expiresAt:Date.now()-1},{expiresAt:Infinity},{audioBase64:'A'.repeat(12800064+4)}])assert.throws(()=>decodeSignalVoiceRequest({...input,...patch}))
})

async function hostFixture() {
  let owner='owner-a',finish!:(value:typeof answer)=>void,valid!:()=>boolean,calls=0
  const messages:any[]=[],child:any=new EventEmitter(),window:any=new EventEmitter(),app:any=new EventEmitter()
  Object.assign(child,{pid:999999,connected:true,exitCode:null,send:(message:any)=>{messages.push(message);if(message.type==='quit'){child.exitCode=0;child.emit('exit',0)}},kill:()=>child.emit('exit',0)})
  Object.assign(window,{webContents:{id:1,send:()=>{},getZoomFactor:()=>1},isDestroyed:()=>false,isVisible:()=>false})
  Object.assign(app,{isPackaged:false,getPath:()=> 'D:/UserAppData/Temp/hellodog-voice-host-fixture',getAppPath:()=> 'D:/fixture'})
  const ipc=new EventEmitter()
  const h=mainHarness({app,ipcMain:ipc,screen:{getDisplayMatching:()=>({scaleFactor:1})}},undefined,{
    child_process:{spawn:()=>child},fs:{existsSync:()=>true,realpathSync:(value:string)=>value},'fs/promises':{mkdir:async()=>{}},
    '../../runtimeHealth':{setAccountState:()=>{},setExternalMetrics:()=>{}},'../../desktopRuntime':{updateAccountUnread:()=>{},notifyAccount:()=>{}},
    './signalTranslationErrors':{signalTranslationErrorMessage:()=> 'translation failed'}
  })
  const {SignalDesktopHost}=h.load('src/main/platforms/signal/signalDesktopHost.ts')
  const host=new SignalDesktopHost(window,()=>owner,async()=>{},async()=>{},async(_account:string,request:any,authorized:()=>boolean)=>{assert.equal(request.bytes.length,3244);calls++;valid=authorized;return new Promise(resolve=>{finish=resolve})})
  await host.open({id:'account-a',platform:'signal',signalEngine:'desktop',label:'fixture'})
  const request={id:'message-a',conversationId:'conversation-a',attachmentId:'a'.repeat(64),audioBase64:wav().toString('base64')}
  return {send:(id='call-a')=>child.emit('message',{channel:'hellodog',type:'voice',id,request}),privacy:(expiresAt=0)=>child.emit('message',{channel:'hellodog',type:'privacy',updates:[{id:'message-a',conversationId:'conversation-a',expiresAt}]}),
    switchOwner:()=>{owner='owner-b'},calls:()=>calls,valid:()=>valid(),finish:()=>finish(answer),messages,close:()=>host.stop('account-a')}
}
test('native host limits an account to one voice job and immediately revokes it on message deletion or account change',async()=>{
  for(const reason of ['delete','owner']){
    const h=await hostFixture()
    try{h.send();await flush();assert.equal(h.calls(),1);assert.equal(h.valid(),true);h.send('call-b');await flush();assert.equal(h.calls(),1);assert.ok(h.messages.find(row=>row.id==='call-b'&&row.error))
      if(reason==='delete')h.privacy();else h.switchOwner();assert.equal(h.valid(),false);h.finish();await flush();assert.equal(h.messages.some(row=>row.type==='voice-result'&&row.result),false)
    }finally{await h.close()}
  }
})
