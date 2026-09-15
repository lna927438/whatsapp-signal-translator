import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
const tick=()=>new Promise(resolve=>setTimeout(resolve,10))
test('restart recovery reconciles interrupted submissions and unknown tasks without sending again',async()=>{
 const handlers=new Map<string,Function>(),power=new EventEmitter(),events=new EventEmitter(),resolved:string[]=[],queried:string[]=[]
 const h=mainHarness({app:{getPath:()=>h.directory},ipcMain:{on(){},handle:(name:string,callback:Function)=>handlers.set(name,callback)},powerMonitor:power})
 try{
  const register=h.load('src/main/reliabilityIpc.ts').registerReliabilityIpc
  const tasks={unfinished:async()=>[
   {id:'interrupted',owner:'owner',state:'submitting',platform:'signal',accountId:'a',conversationId:'signal:peer',request:{text:'first'}},
   {id:'unknown',owner:'owner',state:'uncertain',platform:'whatsapp',accountId:'b',conversationId:'wa:peer',request:{text:'second'}},
   {id:'draft',owner:'owner',state:'draft',platform:'signal',accountId:'a'}],resolveWithEvidence:async(_owner:string,id:string)=>{resolved.push(id);return {state:'sent'}}}
  const read=async(task:any)=>{queried.push(task.id);return {messageId:'receipt-'+task.id}}
  register({webContents:{id:7,send(){}},isDestroyed:()=>false,on:events.on.bind(events)}, {},{},tasks,
   {reconcilePending:async()=>{},onContentCleanup(){},sweepContent:async()=>{}},{resumeTranslations(){},reconcileTask:read},{resumeReceiving:async()=>{},reconcileTask:read},()=> 'owner')
  const frame={url:new URL('../src/renderer/index.html',import.meta.url).href}
  await handlers.get('reliability:recover')!({sender:{id:7,mainFrame:frame},senderFrame:frame})
  assert.deepEqual(queried,['interrupted','unknown']);assert.deepEqual(resolved,['interrupted','unknown'])
 }finally{events.emit('closed');rmSync(h.directory,{recursive:true,force:true})}
})
test('quit with unfinished work flushes recovery records and honors continue or explicit exit',async()=>{
 const appEvents=new EventEmitter(),windowEvents=new EventEmitter();let flushes=0,exits=0,answer=0
 const electron={app:{on:appEvents.on.bind(appEvents),setLoginItemSettings(){},quit(){exits++}},dialog:{showMessageBox:async()=>({response:answer})}}
 const h=mainHarness(electron);try{
 const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({isDestroyed:()=>false,setOverlayIcon(){},flashFrame(){},on:windowEvents.on.bind(windowEvents)})
 runtime.configureQuitGuard(async()=>{flushes++;return 2});runtime.applyDesktopOptions({closeToTray:false})
 let prevented=0;appEvents.emit('before-quit',{preventDefault(){prevented++}});await tick()
 assert.equal(flushes,1);assert.equal(exits,0);assert.equal(prevented,1)
 answer=1;appEvents.emit('before-quit',{preventDefault(){prevented++}});await tick()
 assert.equal(exits,1);assert.equal(flushes,2)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('sleep and lock events expose state; resume and unlock reconcile without any platform send',async()=>{
 const power=new EventEmitter();const eventWindow=new EventEmitter();let recoveries=0;const events:any[]=[]
 const h=mainHarness({app:{getAppMetrics:()=>[{cpu:{percentCPUUsage:0.25},memory:{workingSetSize:1024}}]},powerMonitor:power});try{
 const runtime=h.load('src/main/runtimeHealth.ts')
 runtime.watchPower({on:eventWindow.on.bind(eventWindow),isDestroyed:()=>false,webContents:{send:(...args:any[])=>events.push(args)}},async()=>{recoveries++})
 power.emit('suspend');power.emit('lock-screen');assert.equal(recoveries,0)
 power.emit('resume');power.emit('unlock-screen');await tick();assert.equal(recoveries,2);assert.equal(events.length,4)
 assert.equal(runtime.runtimeSnapshot().memoryMiB,1)
 eventWindow.emit('closed');power.emit('resume');assert.equal(recoveries,2)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('Signal receiving subscriptions pause one account without disconnecting other accounts',async()=>{
 const h=mainHarness();try{
 const {SignalAdapter}=h.load('src/main/platforms/signal/signalAdapter.ts');const adapter=new SignalAdapter({history:async()=>[]})
 adapter.setOnlineUser('owner')
 const records=[{id:'a',platform:'signal',signalAccount:'+12025550100',runtimeMode:'receiving'},{id:'b',platform:'signal',signalAccount:'+12025550101',runtimeMode:'paused'}]
 adapter.accounts.list=async()=>records;adapter.cli.start=async()=>{};adapter.cli.runtimeStatus=async()=>({state:'ready'})
 const calls:any[]=[];adapter.cli.call=async(method:string,args:any)=>{calls.push({method,args});return calls.length}
 await adapter.resumeReceiving();assert.equal(calls.length,1);assert.equal(calls[0].args.account,'+12025550100')
 records[1].runtimeMode='receiving';await adapter.resumeReceiving();assert.equal(calls.length,2);assert.equal(calls[1].args.account,'+12025550101')
 records[0].runtimeMode='paused';await adapter.resumeReceiving();assert.equal(calls.length,3);assert.equal(calls[2].method,'unsubscribeReceive');assert.equal(calls[2].args.subscription,1)
 assert.equal(adapter.subscriptions.has('+12025550101'),true)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('Signal emits a single new-message event plus an update and stores history under the receiving user',async()=>{
 const h=mainHarness();try{
 const {SignalAdapter}=h.load('src/main/platforms/signal/signalAdapter.ts')
 const adapter=new SignalAdapter({cached:async()=>undefined,translateIncoming:async()=> '你好',history:async()=>[]});adapter.setOnlineUser('owner')
 adapter.accounts.list=async()=>[{id:'a',platform:'signal',signalAccount:'+12025550100',runtimeMode:'receiving'}]
 adapter.accounts.updateContactLanguage=async()=>{}
 adapter.settings.runtime=async()=>({localLanguage:'zh-CN',receiveAutoTranslate:true,historyMode:'visible'})
 const events:any[]=[];adapter.attachMainWindow({webContents:{send:(name:string,payload:any)=>{if(name==='signal:message')events.push(payload)}}})
 await adapter.onReceive({account:'+12025550100',envelope:{sourceNumber:'+12025550101',timestamp:123,dataMessage:{message:'Hello',timestamp:123}}})
 assert.equal(events.filter(x=>!x.update).length,1);assert.equal(events.filter(x=>x.update).length,1)
 assert.equal((await adapter.loadHistory('+12025550100'))[0].translated,'你好')
 adapter.setOnlineUser('other');assert.equal((await adapter.loadHistory('+12025550100')).length,0)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
