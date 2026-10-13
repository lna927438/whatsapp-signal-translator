import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {basename} from 'node:path'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'

const flush=async()=>{for(let n=0;n<32;n++)await Promise.resolve()}
async function fixture(){
 let owner='owner';const children:any[]=[],requests:any[]=[],app:any=new EventEmitter(),window:any=new EventEmitter()
 Object.assign(window,{webContents:{id:1,send:()=>{},getZoomFactor:()=>1},isDestroyed:()=>false,isVisible:()=>false})
 Object.assign(app,{isPackaged:false,getPath:()=> 'D:/UserAppData/Temp/hellodog-policy-fixture',getAppPath:()=> 'D:/fixture'})
 const h=mainHarness({app,ipcMain:new EventEmitter(),screen:{getDisplayMatching:()=>({scaleFactor:1})}},undefined,{
  child_process:{spawn:()=>{const child:any=new EventEmitter();Object.assign(child,{pid:9000+children.length,connected:true,exitCode:null,sent:[],send(value:any){child.sent.push(value);if(value.type==='quit'){child.exitCode=0;child.emit('exit',0)}},kill(){child.exitCode=0;child.emit('exit',0)}});children.push(child);return child}},
  fs:{existsSync:()=>true,realpathSync:(value:string)=>value},'fs/promises':{mkdir:async()=>{}},
  '../../runtimeHealth':{setAccountState:()=>{},setExternalMetrics:()=>{}},'../../desktopRuntime':{updateAccountUnread:()=>{},notifyAccount:()=>{}}
 })
 const {SignalDesktopHost}=h.load('src/main/platforms/signal/signalDesktopHost.ts'),host=new SignalDesktopHost(window,()=>owner,async(_id:string,request:any)=>{requests.push(request);return {authorized:true,text:request.text}})
 await host.open({id:'a',platform:'signal',signalEngine:'desktop',label:'A'});await host.open({id:'b',platform:'signal',signalEngine:'desktop',label:'B'})
 return {host,children,requests,owner:(value:string)=>owner=value,ack:(child:any,id:string,error=false)=>child.emit('message',{channel:'hellodog',type:'send-policy-invalidated',id,error}),close:async()=>{await host.stopAll();assert.match(basename(h.directory),/^hellodog-test-/);rmSync(h.directory,{recursive:true,force:true})}}
}

test('Signal policy barrier waits for each owning child and rejects forged, reused or cross-account ACK',async()=>{
 const h=await fixture();try{
  let complete=false;const work=h.host.invalidateSendPolicy().then(()=>complete=true)
  const [a,b]=h.children,ta=a.sent.at(-1).id,tb=b.sent.at(-1).id;assert.notEqual(ta,tb)
  h.ack(b,ta);h.ack(a,'not-a-token');await flush();assert.equal(complete,false)
  h.ack(a,ta);h.ack(a,ta);await flush();assert.equal(complete,false)
  h.ack(b,tb);await work;assert.equal(complete,true)
 }finally{await h.close()}
})

test('Signal policy barrier timeout and child exit fail closed and discard late ACKs',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=await fixture();try{
  const a=h.children[0],pending=h.host.invalidateSendPolicy('a'),token=a.sent.at(-1).id
  const rejected=assert.rejects(pending,/尚未确认/);t.mock.timers.tick(2001);await rejected;h.ack(a,token)
  const pendingExit=h.host.invalidateSendPolicy('a'),exitRejected=assert.rejects(pendingExit,/尚未确认/)
  a.exitCode=1;a.emit('exit',1);await exitRejected
 }finally{await h.close()}
})

test('Signal policy acknowledgements from an old owner cannot release a settings barrier',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=await fixture();try{
  const a=h.children[0],pending=h.host.invalidateSendPolicy('a'),token=a.sent.at(-1).id
  const rejected=assert.rejects(pending,/尚未确认/);h.owner('other');h.ack(a,token);t.mock.timers.tick(2001);await rejected
 }finally{await h.close()}
})

test('Signal final policy IPC permits bounded empty/expanded actual text while rejecting invalid flags and keeping ordinary cap',async()=>{
 const h=await fixture();try{
  const a=h.children[0],base={id:'message',conversationId:'conversation',direction:'outgoing',dispatchPolicyOnly:true,text:''}
  for(const text of ['', 'a'.repeat(20000)]){a.emit('message',{channel:'hellodog',type:'translate',id:'ok-'+text.length,request:{...base,text}});await flush();assert.equal(a.sent.at(-1).result.text,text)}
  assert.equal(h.requests.length,2)
  const invalid=[{text:'a'.repeat(20001)},{direction:'incoming'},{direction:'display'},{dispatchPolicyOnly:false},{dispatchPolicyOnly:'true'},{authorizationOnly:true,requestId:'send-fixture',translated:'Hello'},{requestId:'send-fixture'},{translated:'different'},{unexpected:'value'}]
  for(const patch of invalid){a.emit('message',{channel:'hellodog',type:'translate',id:'bad',request:{...base,...patch}});await flush();assert.equal(a.sent.at(-1).id,'bad');assert.ok(a.sent.at(-1).error)}
  a.emit('message',{channel:'hellodog',type:'translate',id:'ordinary',request:{id:'message',conversationId:'conversation',direction:'outgoing',text:'a'.repeat(10001)}});await flush();assert.ok(a.sent.at(-1).error);assert.equal(h.requests.length,2)
 }finally{await h.close()}
})
