import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,rmSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createHash} from 'node:crypto'
import {join,resolve,relative} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import ts from 'typescript'
import {mainHarness} from './main-harness.ts'

function fixture(){
 const h=mainHarness(),{createSecureIpc}=h.load('src/main/secureIpc.ts'),{normalizeSignalPeer}=h.load('src/shared/signalProtocol.ts'),{TranslationEngine}=h.load('src/main/translation/translationEngine.ts')
 const handlers=new Map<string,Function>(),whatsapp={ownsSender:(id:string,sender:number)=>id==='wa'&&sender===7},mainWindow={webContents:{id:1}},calls:any[]=[],recognized:any[]=[],ids:string[]=[]
 const ipcMain=createSecureIpc({handle:(name:string,handler:Function)=>handlers.set(name,handler)},mainWindow,whatsapp),translator=new TranslationEngine()
 let owner='owner',revision=0,hold=false,complete:(value:unknown)=>void=()=>{}
 translator.setOnlineSession(owner,'fixture-token');translator.settings.get=async()=>({provider:'openai'});translator.createProvider=()=>({translate:async(request:any)=>{
  calls.push(request);ids.push(request.requestId);await new Promise(resolve=>setTimeout(resolve,5));await translator.receipts.update(owner,request.requestId,{state:'charged',translated:'明天会给你打电话。',chargedCharacters:Array.from(request.text).length,balanceAfter:900});return '明天会给你打电话。'
 }})
 const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8'),selected=source.slice(source.indexOf('  const voice = new VoiceRecognition('),source.indexOf('  const assertTaskSender ='))
 runInNewContext(ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ipcMain,app:{isPackaged:false,getAppPath:()=>h.directory,getPath:()=>h.directory},join,__dirname:h.directory,process,mainWindow,whatsapp,createHash,normalizeSignalPeer,Uint8Array,
  accounts:{list:async()=>[{id:'wa',platform:'whatsapp'},{id:'signal',platform:'signal'}]},accountRuntime:async()=>({localLanguage:'zh-CN'}),translator,
  requireMain:(event:any)=>{if(event.sender.id!==1)throw Error('main required')},taskIdentity:()=>{if(!owner)throw Error('请先登录');const current=owner,version=revision;return{owner,authorized:()=>owner===current&&revision===version}},
  VoiceRecognition:class{async recognize(bytes:unknown,authorized:()=>boolean){recognized.push(bytes);if(!authorized())throw Error('登录状态已变化');if(hold)await new Promise(resolve=>complete=resolve);if(!authorized())throw Error('登录状态已变化');return 'I will call you tomorrow.'}}
 })
 const appUrl=pathToFileURL(fileURLToPath(new URL('../src/renderer/index.html',import.meta.url))).href
 const invoke=(name:string,args:unknown[],sender=1,url=appUrl,subframe=false)=>Promise.resolve().then(()=>{const mainFrame={url};return handlers.get('voice:'+name)!({sender:{id:sender,mainFrame,isDestroyed:()=>false},senderFrame:subframe?{url}:mainFrame},...args)})
 return{...h,invoke,translator,calls,recognized,ids,hold:()=>hold=true,finish:()=>complete(undefined),setOwner:(value:string)=>{owner=value;revision++;translator.setOnlineSession(value,'fixture-token')},close:()=>{assert.match(relative(resolve(process.env.TEMP||''),resolve(h.directory)),/^hellodog-test-[a-zA-Z0-9]+$/);rmSync(h.directory,{recursive:true,force:true})}}
}
const digest='a'.repeat(64),text='I will call you tomorrow.'
test('voice recognition allows the trusted file tool and owning WA view, denies other accounts, frames and origins without charging',async()=>{
 const h=fixture();try{
  for(const args of [['wa',1,undefined],['signal',1,undefined],['wa',7,'https://web.whatsapp.com/']] as const){const result=await h.invoke('recognize',[args[0],new Uint8Array([1,2])],args[1],args[2]);assert.equal(result.text,text);assert.match(result.audioId,/^[a-f0-9]{64}$/)}
  for(const args of [['wa',9,'https://web.whatsapp.com/',false],['signal',7,'https://web.whatsapp.com/',false],['wa',7,'https://evil.invalid/',false],['wa',7,'https://web.whatsapp.com/',true],['missing',1,undefined,false]] as const)await assert.rejects(h.invoke('recognize',[args[0],new Uint8Array([1,2])],args[1],args[2],args[3]))
  assert.equal(h.recognized.length,3);assert.equal(h.calls.length,0)
 }finally{h.close()}
})
test('a late voice result after owner change is rejected before returning its transcript',async()=>{
 const h=fixture();try{h.hold();const pending=h.invoke('recognize',['signal',new Uint8Array([1,2])]),rejected=assert.rejects(pending,/登录状态已变化/);while(!h.recognized.length)await new Promise(resolve=>setImmediate(resolve));h.setOwner('other');h.finish();await rejected;assert.equal(h.calls.length,0)}finally{h.close()}
})
test('confirmed file translations reuse the same paid identity for duplicate clicks and cache clearing; an edit has its own identity',async()=>{
 const h=fixture();try{
  const results=await Promise.all(Array.from({length:8},()=>h.invoke('translate-file',['wa',digest,text])));assert.equal(new Set(results).size,1);assert.equal(h.calls.length,1)
  await h.translator.flush();await h.translator.clearCache();await h.invoke('translate-file',['wa',digest,text]);assert.equal(h.calls.length,1)
  await h.invoke('translate-file',['wa',digest,text+' Again.']);assert.equal(h.calls.length,2);assert.equal(new Set(h.ids).size,2)
  assert.equal((await h.translator.history()).filter((row:any)=>row.state==='charged').length,2)
 }finally{h.close()}
})
test('voice message charge identities are isolated by Signal peer even when attachment ID and text match',async()=>{
 const h=fixture();try{
  await h.invoke('translate',['signal','+12025550123','voice:same-attachment:100',text]);await h.invoke('translate',['signal','+12025550456','voice:same-attachment:100',text]);assert.equal(h.calls.length,2);assert.notEqual(h.ids[0],h.ids[1])
  assert.notEqual(h.calls[0].messageId,h.calls[1].messageId);assert.ok(h.calls.every(call=>/^voice:[a-f0-9]{64}$/.test(call.messageId)))
  await h.invoke('translate',['signal','+12025550123','voice:same-attachment:100',text]);assert.equal(h.calls.length,2)
 }finally{h.close()}
})
test('voice paid IPC rejects malformed requests and non-main senders; local recognition never sends platform messages',async()=>{
 const h=fixture();try{
  await assert.rejects(h.invoke('translate-file',['wa',digest,text],7,'https://web.whatsapp.com/'))
  for(const args of [['missing',digest,text],['wa','bad',text],['wa',digest,''],['wa',digest,'x'.repeat(12001)]])await assert.rejects(h.invoke('translate-file',args))
  for(const args of [['wa','+12025550123','voice:1',text],['signal','invalid-peer','voice:1',text],['signal','+12025550123','x'.repeat(1001),text]])await assert.rejects(h.invoke('translate',args))
  h.setOwner('');await assert.rejects(h.invoke('translate-file',['wa',digest,text]),/登录/);assert.equal(h.calls.length,0)
 }finally{h.close()}
})
