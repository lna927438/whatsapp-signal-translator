import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

test('desktop notification modes, click navigation and close-to-tray execute their actual handlers',()=>{
 const appEvents:Record<string,any>={},events:Record<string,any>={},notifications:any[]=[];let focused=true,hidden=0,shown=0;const sent:any[]=[]
 const electron={app:{on:(name:string,fn:any)=>{appEvents[name]=fn},setLoginItemSettings:()=>{},quit:()=>{}},Menu:{buildFromTemplate:(value:any)=>value},nativeImage:{createFromPath:()=>({resize:()=>({isEmpty:()=>false})})},Tray:class{setImage(){}setToolTip(){}setContextMenu(){}on(){}destroy(){}},Notification:class{static isSupported(){return true}events:Record<string,any>={};constructor(public options:any){notifications.push(this)}on(name:string,fn:any){this.events[name]=fn}show(){}close(){this.events.close?.()}}}
 const h=mainHarness(electron)
 try{const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({isDestroyed:()=>false,setOverlayIcon(){},flashFrame(){},on:(name:string,fn:any)=>{events[name]=fn},isFocused:()=>focused,show:()=>{shown++},focus:()=>{},hide:()=>{hidden++},webContents:{send:(...args:any[])=>sent.push(args)}})
 runtime.applyDesktopOptions({notifications:'background',closeToTray:true,notificationSound:false});runtime.notifyAccount('a','Work');assert.equal(notifications.length,0)
 focused=false;runtime.notifyAccount('a','Work');assert.equal(notifications.length,1);assert.equal(notifications[0].options.silent,true);assert.equal(notifications[0].options.body,'Work 有新消息');notifications[0].events.click();assert.equal(shown,1);assert.equal(sent[0][1].accountId,'a')
 let prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,true);assert.equal(hidden,1)
 runtime.applyDesktopOptions({notifications:'off',closeToTray:false});runtime.notifyAccount('a','Work');assert.equal(notifications.length,1);prevented=false;events.close({preventDefault:()=>{prevented=true}});assert.equal(prevented,false)
 focused=true;runtime.applyDesktopOptions({notifications:'always',closeToTray:false,notificationSound:true,hideNotificationNames:true});runtime.notifyAccount('signal','Private contact');assert.equal(notifications.length,2);assert.equal(notifications[1].options.silent,false);assert.equal(notifications[1].options.body,'有新的聊天消息')
 runtime.notifyAccount('signal','Private contact',{silent:true,hideNames:true});assert.equal(notifications[2].options.silent,true);assert.equal(notifications[2].options.body,'有新的聊天消息')
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

function notificationFixture() {
 const notifications: FakeNotification[] = [], events: Record<string, (...args: any[]) => void> = {}, sent: any[] = []
 let destroyed = false, shown = 0, focused = 0
 class FakeNotification {
  static isSupported() { return true }
  events: Record<string, (...args: any[]) => void> = {}; shown = 0; closed = 0
  constructor(public options: any) { notifications.push(this) }
  on(name: string, callback: (...args: any[]) => void) { this.events[name] = callback }
  show() { this.shown++ }
  close() { this.closed++; this.events.close?.() }
 }
 const h = mainHarness({ app: { on() {}, setLoginItemSettings() {} }, Notification: FakeNotification,
  nativeImage: { createFromBitmap: () => ({}) } })
 const runtime = h.load('src/main/desktopRuntime.ts')
 const live = () => { if (destroyed) throw new Error('Window has been destroyed') }
 const window = { isDestroyed: () => destroyed, setOverlayIcon() {}, flashFrame() {}, on: (name: string, callback: (...args: any[]) => void) => { events[name] = callback },
  isFocused: () => { live(); return false }, show: () => { live(); shown++ }, focus: () => { live(); focused++ },
  get webContents() { live(); return { send: (...args: any[]) => sent.push(args) } } }
 runtime.attachDesktopRuntime(window)
 runtime.applyDesktopOptions({ notifications: 'always', closeToTray: false })
 return { runtime, notifications, events, sent, window, destroy: () => { destroyed = true }, shown: () => shown, focused: () => focused,
  dispose: () => { runtime.clearAccountNotifications(); rmSync(h.directory, { recursive: true, force: true }) } }
}

test('a replacement notification revokes old clicks and clearing one account preserves another', () => {
 const f = notificationFixture()
 try {
  f.runtime.notifyAccount('a', 'Account A'); f.runtime.notifyAccount('b', 'Account B')
  const [oldA, b] = f.notifications
  f.runtime.notifyAccount('a', 'Account A'); const newA = f.notifications[2]
  assert.equal(oldA.closed, 1); assert.equal(newA.shown, 1); assert.equal(b.closed, 0)
  oldA.events.click(); assert.equal(f.shown(), 0); assert.equal(f.sent.length, 0)
  f.runtime.clearAccountNotifications('a'); assert.equal(newA.closed, 1); assert.equal(b.closed, 0)
  newA.events.click(); assert.equal(f.shown(), 0)
  b.events.click(); assert.equal(f.shown(), 1); assert.equal(f.focused(), 1); assert.equal(f.sent[0][1].accountId, 'b')
  f.runtime.clearAccountNotifications(); assert.equal(b.closed, 1)
  b.events.click(); assert.equal(f.shown(), 1)
 } finally { f.dispose() }
})

test('authorization is checked before display and old notifications cannot focus after revocation or account removal', () => {
 const f = notificationFixture(); let authorized = false
 try {
  f.runtime.notifyAccount('a', 'Account A', { authorized: () => authorized }); assert.equal(f.notifications.length, 0)
  authorized = true; f.runtime.notifyAccount('a', 'Account A', { authorized: () => authorized })
  const first = f.notifications[0]; assert.equal(first.shown, 1)
  authorized = false; first.events.click(); assert.equal(f.shown(), 0); assert.equal(f.sent.length, 0)
  authorized = true; f.runtime.notifyAccount('a', 'Account A', { authorized: () => authorized })
  const next = f.notifications[1]; f.runtime.updateAccountUnread('a', 2); f.runtime.clearAccountUnread('a')
  assert.equal(next.closed, 1); assert.equal(f.runtime.accountUnreadSnapshot().a, undefined)
  next.events.click(); assert.equal(f.shown(), 0)
  assert.doesNotThrow(() => f.runtime.notifyAccount('a', 'Account A', { authorized: () => { throw new Error('Revoked') } }))
  assert.equal(f.notifications.length, 2)
 } finally { f.dispose() }
})

test('destroyed or closed windows never receive notification navigation and close releases all notifications', () => {
 const f = notificationFixture()
 try {
  f.runtime.notifyAccount('a', 'Account A'); f.runtime.notifyAccount('b', 'Account B')
  f.destroy()
  assert.doesNotThrow(() => f.notifications[0].events.click())
  assert.doesNotThrow(() => f.runtime.notifyAccount('c', 'Account C'))
  assert.equal(f.notifications.length, 2); assert.equal(f.shown(), 0); assert.equal(f.sent.length, 0)
  f.events.closed(); assert.ok(f.notifications.every(item => item.closed === 1))
  assert.doesNotThrow(() => f.notifications[1].events.click())
  assert.doesNotThrow(() => f.runtime.notifyAccount('c', 'Account C'))
  assert.equal(f.notifications.length, 2); assert.equal(f.shown(), 0)
 } finally { f.dispose() }
})

test('X minimizes instead of exiting when the tray is unavailable, while explicit exit is allowed',()=>{
 const events:Record<string,any>={},appEvents:Record<string,any>={};let minimized=0
 const h=mainHarness({app:{on:(n:string,f:any)=>{appEvents[n]=f},setLoginItemSettings:()=>{}},Menu:{},nativeImage:{createFromPath:()=>({resize:()=>({isEmpty:()=>true})})}})
 try{const runtime=h.load('src/main/desktopRuntime.ts');runtime.attachDesktopRuntime({isDestroyed:()=>false,setOverlayIcon(){},flashFrame(){},on:(n:string,f:any)=>{events[n]=f},minimize:()=>{minimized++}})
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
