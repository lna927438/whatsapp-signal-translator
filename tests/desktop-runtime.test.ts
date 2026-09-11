import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

test('desktop notification modes, click navigation and close-to-tray execute their actual handlers',()=>{
 const appEvents:Record<string,any>={},events:Record<string,any>={},notifications:any[]=[];let focused=true,hidden=0,shown=0;const sent:any[]=[]
 const electron={app:{on:(name:string,fn:any)=>{appEvents[name]=fn},setLoginItemSettings:()=>{},quit:()=>{}},Menu:{buildFromTemplate:(value:any)=>value},nativeImage:{createFromPath:()=>({resize:()=>({isEmpty:()=>false})})},Tray:class{setToolTip(){}setContextMenu(){}on(){}destroy(){}},Notification:class{static isSupported(){return true}events:Record<string,any>={};constructor(public options:any){notifications.push(this)}on(name:string,fn:any){this.events[name]=fn}show(){}}}
 const h=mainHarness(electron)
 try{const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({on:(name:string,fn:any)=>{events[name]=fn},isFocused:()=>focused,show:()=>{shown++},focus:()=>{},hide:()=>{hidden++},webContents:{send:(...args:any[])=>sent.push(args)}})
 runtime.applyDesktopOptions({notifications:'background',closeToTray:true,notificationSound:false});runtime.notifyAccount('a','Work');assert.equal(notifications.length,0)
 focused=false;runtime.notifyAccount('a','Work');assert.equal(notifications.length,1);assert.equal(notifications[0].options.silent,true);assert.equal(notifications[0].options.body,'Work 有新消息');notifications[0].events.click();assert.equal(shown,1);assert.equal(sent[0][1].accountId,'a')
 let prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,true);assert.equal(hidden,1)
 runtime.applyDesktopOptions({notifications:'off',closeToTray:false});runtime.notifyAccount('a','Work');assert.equal(notifications.length,1);prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,false)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('X minimizes instead of exiting when the tray is unavailable, while explicit exit is allowed',()=>{
 const events:Record<string,any>={},appEvents:Record<string,any>={};let minimized=0
 const h=mainHarness({app:{on:(n:string,f:any)=>{appEvents[n]=f},setLoginItemSettings:()=>{}},Menu:{},nativeImage:{createFromPath:()=>({resize:()=>({isEmpty:()=>true})})}})
 try{const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({on:(n:string,f:any)=>{events[n]=f},minimize:()=>{minimized++}})
 assert.throws(()=>runtime.applyDesktopOptions({closeToTray:true}),/任务栏最小化/)
 let prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,true);assert.equal(minimized,1)
 appEvents['before-quit']();prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,false)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('existing settings migrate to background close, while a new explicit opt-out persists',async()=>{
 const h=mainHarness()
 try{const {SettingsStore}=h.load('src/main/storage/settingsStore.ts');const store=new SettingsStore();const initial=await store.get();assert.equal(initial.closeToTray,true)
 await store.save({...initial,closeToTray:false,closeBehaviorVersion:undefined});assert.equal((await store.get()).closeToTray,true)
 await store.save({...initial,closeToTray:false,closeBehaviorVersion:1});assert.equal((await store.get()).closeToTray,false)
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
