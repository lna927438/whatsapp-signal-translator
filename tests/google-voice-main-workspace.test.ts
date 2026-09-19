import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mainHarness} from './main-harness.ts'
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
function fixture(){
 let owner='owner-a',authRevision=0
 const calls:any[]=[],hosts:FakeHost[]=[],launchers:FakeLauncher[]=[],getGates=new Map<string,Promise<void>>()
 const recordsData=['a','b'].map((id,tabOrder)=>({id,owner,label:id,tabOrder,browser:'chrome'}))
 const records={get:async(who:string,id:string)=>{await getGates.get(id);const row=recordsData.find(row=>row.owner===who&&row.id===id);if(!row)throw new Error('missing');return row},update:async(who:string,id:string,patch:any)=>{const row=await records.get(who,id);Object.assign(row,patch);return row}}
 let attachGate:Promise<void>|undefined,detachGate:Promise<void>|undefined,attachFailure=false,detachFailure=false,discoveryCount=1
 class FakeLauncher{
  constructor(public profile:string){launchers.push(this)}
  resolveDetails=async()=>this.details()
  details(){return{browser:'chrome',executable:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',profile:this.profile}}
  async open(authorized:()=>boolean){assert.ok(authorized());calls.push(['launch',this.profile]);return{browser:'chrome',launched:true}}
  async openExtensions(authorized:()=>boolean){assert.ok(authorized());calls.push(['extensions',this.profile])}
 }
 class FakeHost{
  visible=false;ready=false;profile='';disconnected?:((error?:Error)=>void);captures:any
  constructor(){hosts.push(this)}
  async attach(configuration:any,authorized:()=>boolean){this.captures=configuration;this.profile=configuration.profile;calls.push(['attach',this.profile]);const waiting=attachGate;attachGate=undefined;await waiting;if(!authorized())throw new Error('cancelled identity');if(attachFailure)throw new Error('attach failed');this.ready=true}
  onDisconnected(callback:(error?:Error)=>void){this.disconnected=callback;return()=>{}}
  setBounds(value:any){calls.push(['bounds',this.profile,value])}
  setVisible(value:boolean){this.visible=value;calls.push(['visible',this.profile,value])}
  focus(){calls.push(['focus',this.profile])}
  async detach(){calls.push(['detach',this.profile]);await detachGate;if(detachFailure)throw new Error('recovery unconfirmed');this.ready=false;this.disconnected?.()}
 }
 class FakeWindow extends EventEmitter{
  destroyed=false;visible=true;minimized=false;closeCalls=0
  webContents={send:(...args:any[])=>calls.push(['send',...args]),getZoomFactor:()=>1}
  getBounds(){return{x:0,y:0,width:900,height:700}}
  isDestroyed(){return this.destroyed}isVisible(){return this.visible}isMinimized(){return this.minimized}
  getNativeWindowHandle(){const result=Buffer.alloc(8);result.writeBigUInt64LE(100n);return result}
  close(){this.closeCalls++;const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};this.emit('close',event);if(!event.defaultPrevented){this.destroyed=true;this.emit('closed')}}
 }
 const window=new FakeWindow()
 const h=mainHarness({app:{isPackaged:false,getAppPath:()=> 'D:\\HelloDog',getPath:()=> 'D:\\HelloDog\\data'},screen:{getDisplayMatching:()=>({scaleFactor:1})}},undefined,{
  './officialWindow':{GoogleVoiceOfficialWindow:FakeLauncher},
  './windowRecords':{googleVoiceProfileRoot:(root:string,who:string,id:string)=>root+'\\'+who+'\\'+id},
  './nativeWindowHost':{GoogleVoiceNativeWindowHost:FakeHost,discoverGoogleVoiceWindows:async(_helper:string,_exe:string,profile:string)=>Array.from({length:discoveryCount},(_,index)=>({hwnd:String(profile.endsWith('a')?201+index:301+index),pid:20,startTicks:'639000000000000000'}))}
 })
 const {GoogleVoiceWorkspace}=h.load('src/main/platforms/googleVoice/workspace.ts')
 const workspace=new GoogleVoiceWorkspace(window,records,()=>{const saved=owner,revision=authRevision;return{owner,authorized:()=>!!owner&&owner===saved&&revision===authRevision}})
 return{workspace,window,records,calls,hosts,launchers,getGates,setAttachGate:(value:Promise<void>)=>attachGate=value,setDetachGate:(value:Promise<void>|undefined)=>detachGate=value,setAttachFailure:(value:boolean)=>attachFailure=value,setDetachFailure:(value:boolean)=>detachFailure=value,setDiscoveryCount:(value:number)=>discoveryCount=value,setOwner:(value:string)=>{owner=value;authRevision++}}
}
test('main workspace reuses an existing dedicated window instead of spawning a duplicate after restart',async()=>{
 const h=fixture();assert.equal((await h.workspace.focus('a')).state,'ready')
 assert.equal(h.calls.filter(row=>row[0]==='launch').length,0);assert.equal(h.hosts[0].visible,true)
 await h.workspace.external('a');assert.equal(h.calls.filter(row=>row[0]==='launch').length,0)
 assert.equal((await h.workspace.focus('a')).state,'ready');assert.equal(h.calls.filter(row=>row[0]==='launch').length,0)
})
test('closing a nonselected record preserves the active native window and its focus',async()=>{
 const h=fixture();await h.workspace.focus('a');await h.workspace.focus('b');await h.workspace.close('a')
 assert.equal(h.hosts[1].visible,true);assert.equal(h.calls.filter(row=>row[0]==='detach').length,1)
})
test('a late record lookup cannot restore an earlier selection',async()=>{
 const h=fixture(),gate=deferred();h.getGates.set('a',gate.promise)
 const earlier=h.workspace.focus('a');await h.workspace.focus('b');gate.resolve();assert.equal((await earlier).state,'cancelled')
 assert.equal(h.hosts.length,1);assert.equal(h.hosts[0].visible,true);assert.ok(h.hosts[0].profile.endsWith('b'))
})
test('a late native attachment stays hidden when another window has become active',async()=>{
 const h=fixture(),gate=deferred();h.setAttachGate(gate.promise)
 const earlier=h.workspace.focus('a');await tick();await h.workspace.focus('b');gate.resolve()
 assert.equal((await earlier).state,'cancelled');assert.equal(h.hosts[0].visible,false);assert.equal(h.hosts[1].visible,true)
})
test('global recovery blocks new focus and external operations until every host acknowledges detach',async()=>{
 const h=fixture();await h.workspace.focus('a');const gate=deferred();h.setDetachGate(gate.promise)
 const stopping=h.workspace.detachAll();await tick()
 assert.equal((await h.workspace.focus('b')).state,'cancelled');await assert.rejects(h.workspace.external('b'),/状态已变化/)
 assert.equal(h.hosts.length,1);gate.resolve();await stopping
 assert.equal((await h.workspace.focus('b')).state,'ready')
})
test('an attachment whose restoration fails remains tracked and prevents destroying the parent',async()=>{
 const h=fixture();h.setAttachFailure(true);h.setDetachFailure(true)
 await assert.rejects(h.workspace.focus('a'),/recovery unconfirmed/)
 await assert.rejects(h.workspace.focus('a'),/恢复尚未确认/)
 h.window.close();await tick();assert.equal(h.window.destroyed,false);assert.ok(h.calls.some(row=>row[0]==='send'))
 h.setDetachFailure(false);h.window.close();await tick();await tick();assert.equal(h.window.destroyed,true)
})
test('close waits for pending attach cancellation and its confirmed restoration',async()=>{
 const h=fixture(),attach=deferred(),detach=deferred();h.setAttachGate(attach.promise)
 const opening=h.workspace.focus('a');await tick();h.setDetachGate(detach.promise);h.window.close()
 assert.equal(h.window.destroyed,false);attach.resolve();await tick();assert.equal(h.window.destroyed,false)
 detach.resolve();assert.equal((await opening).state,'cancelled');await tick();await tick();assert.equal(h.window.destroyed,true)
})
test('switching owner cancels delayed attachment and never displays an old owner window',async()=>{
 const h=fixture(),gate=deferred();h.setAttachGate(gate.promise);const opening=h.workspace.focus('a');await tick()
 h.setOwner('owner-b');const stopping=h.workspace.detachAll();gate.resolve();assert.equal((await opening).state,'cancelled');await stopping
 assert.equal(h.hosts[0].visible,false);assert.equal(h.hosts[0].ready,false)
})
test('external request invalidates a pending attach instead of allowing it to return inside later',async()=>{
 const h=fixture(),gate=deferred();h.setAttachGate(gate.promise);const opening=h.workspace.focus('a');await tick()
 const external=h.workspace.external('a');await tick();gate.resolve();assert.equal((await opening).state,'cancelled');assert.equal((await external).state,'external')
 assert.equal(h.hosts[0].ready,false);assert.equal(h.calls.filter(row=>row[0]==='launch').length,0)
})
test('extension setup detaches only its own window and opens management in that profile',async()=>{
 const h=fixture();await h.workspace.focus('a');await h.workspace.focus('b');await h.workspace.extensionSetup('a')
 assert.equal(h.hosts[1].visible,true);assert.equal(h.calls.filter(row=>row[0]==='extensions').length,1);assert.ok(h.calls.find(row=>row[0]==='extensions')[1].endsWith('a'))
})
test('multiple matching native windows fail closed without launching or guessing a target',async()=>{
 const h=fixture();h.setDiscoveryCount(2);await assert.rejects(h.workspace.focus('a'),/唯一识别/)
 assert.equal(h.hosts.length,0);assert.equal(h.calls.filter(row=>row[0]==='launch').length,0)
})
test('overlay and minimize hide embedded surfaces and restore only the active surface',async()=>{
 const h=fixture();await h.workspace.focus('a');await h.workspace.focus('b');h.workspace.setOverlayOpen(true);assert.ok(h.hosts.every(host=>!host.visible))
 h.workspace.setOverlayOpen(false);assert.equal(h.hosts[1].visible,true);h.window.minimized=true;h.window.emit('minimize');assert.ok(h.hosts.every(host=>!host.visible))
 h.window.minimized=false;h.window.emit('restore');assert.equal(h.hosts[0].visible,false);assert.equal(h.hosts[1].visible,true)
})
