import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
import {clientNotices,noticeWindowBounds,noticeActionUrl} from '../src/shared/clientNotices.ts'
const notice=(patch={})=>({id:randomUUID(),revision:1,title:'Title',body:'Private body',level:'info',popup:true,action:'none',starts_at:new Date(Date.now()-1000).toISOString(),ends_at:null,displayed:false,dismissed:false,...patch})
const delay=()=>new Promise(r=>setTimeout(r,25))
function setup(){
 const handlers=new Map<string,Function>(),windows:any[]=[],opened:string[]=[];let nextId=1
 class Window extends EventEmitter{
  webContents:any;visible=false;focused=false;minimized=false;destroyed=false;bounds={x:0,y:0,width:1200,height:800};options:any
  constructor(options:any={}){super();this.options=options;this.webContents=new EventEmitter();Object.assign(this.webContents,{id:nextId++,send:(..._a:any[])=>{},setWindowOpenHandler:()=>{}});windows.push(this)}
  setMenu(){} async loadURL(){} async loadFile(){} setBounds(b:any){this.bounds=b}getContentBounds(){return this.bounds}isDestroyed(){return this.destroyed}isVisible(){return this.visible}isFocused(){return this.focused}isMinimized(){return this.minimized}showInactive(){this.visible=true}hide(){this.visible=false}destroy(){this.destroyed=true;this.emit('closed')}
 }
 const h=mainHarness({BrowserWindow:Window,ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn),removeHandler:(name:string)=>handlers.delete(name)},shell:{openExternal:async(url:string)=>{opened.push(url)}}})
 const parent=new Window();parent.visible=true;parent.focused=true
 const invoke=(name:string,sender:any,...args:any[])=>{sender.webContents.mainFrame??={url:'file:///notification.html'};return handlers.get(name)!({sender:sender.webContents,senderFrame:sender.webContents.mainFrame},...args)}
 return {h,parent,windows,handlers,invoke,opened}
}
test('journal serializes concurrent receipts, separates users and stores no message body',async()=>{
 const {h}=setup(),{NoticeJournal}=h.load('src/main/storage/noticeJournal.ts'),j=new NoticeJournal(),n=notice()
 await Promise.all([j.record('A',n,'displayed'),j.record('A',n,'dismissed'),j.record('B',n,'displayed')]);assert.equal((await j.pending('A')).length,2);assert.equal((await j.pending('B')).length,1)
 await j.acknowledged('A',n,'displayed');assert.equal((await j.pending('A'))[0].state,'dismissed')
 const reloaded=new NoticeJournal();assert.equal((await reloaded.entries('A'))[n.id+':1'].dismissed,true)
 const disk=readFileSync(h.directory+'/notification-receipts.json','utf8');assert.equal(disk.includes(n.body),false);assert.equal(disk.includes('title'),false)
})
test('toast stays above native content without taking focus and follows parent visibility',async()=>{
 const s=setup(),{NotificationWindow}=s.h.load('src/main/notificationWindow.ts');const seen:string[]=[];const win=new NotificationWindow(s.parent,{action:async()=>{},displayed:(k:string)=>seen.push(k),hidden:()=>{}})
 const data={key:'test',title:'Hello',body:'Message',category:'Notice',level:'info',brand:'HelloDog',actionLabel:'',closeLabel:'Close',detailsLabel:'Details',errorLabel:'Error'}
 try{await win.show(data);const popup=s.windows[1];assert.equal(popup.options.transparent,false);assert.equal(popup.options.backgroundColor,'#191e24');assert.equal(popup.options.focusable,false);assert.equal(popup.options.skipTaskbar,true);assert.equal(popup.options.parent,s.parent);assert.equal(popup.visible,true)
  await s.invoke('notice-window:painted',popup,'test');assert.deepEqual(seen,['test']);assert.equal(s.parent.focused,true)
  s.parent.focused=false;s.parent.emit('blur');assert.equal(popup.visible,false);await s.invoke('notice-window:painted',popup,'test');assert.equal(seen.length,1)
  s.parent.focused=true;s.parent.emit('focus');assert.equal(popup.visible,true);win.setBlocked(true);assert.equal(popup.visible,false);win.setBlocked(false);assert.equal(popup.visible,true)
  s.parent.bounds={x:1300,y:100,width:1000,height:700};s.parent.emit('move');assert.deepEqual(JSON.parse(JSON.stringify(popup.bounds)),noticeWindowBounds(s.parent.bounds))
  await assert.rejects(s.invoke('notice-window:action',s.parent,'test','open'),/Invalid notification window/)
 }finally{s.parent.destroy()}
})
test('logout discards in-flight data and does not expose notices to the next user',async()=>{
 const s=setup(),{ClientNotifications}=s.h.load('src/main/clientNotifications.ts');let user='A',resolve:(v:any)=>void=()=>{},calls=0
 const manager=new ClientNotifications(s.parent,{notice:async()=>({available:false,show:false})},()=>user,()=>++calls===1?new Promise(r=>resolve=r):Promise.resolve({notices:[]}),async()=>({accepted:true}))
 try{manager.setIdentity();user='B';manager.setIdentity();resolve({notices:[notice()]});await delay();await delay();assert.equal(manager.snapshot().notices.length,0);assert.equal(s.windows.length,1);assert.equal(calls,2)
  user='';manager.setIdentity();assert.equal(manager.snapshot().unread,0);assert.throws(()=>s.invoke('notices:snapshot',s.parent),/登录/)
 }finally{s.parent.destroy()}
})
test('only actual paint acknowledges display; failed receipts persist, dismissal stops repeats after restart',async()=>{
 const s=setup(),{ClientNotifications}=s.h.load('src/main/clientNotifications.ts');const n=notice(),sent:any[]=[];let failed=true,offlineAttempts=0
 // IPC acknowledgement does not wait for the receipt journal's durable writes.
 const until=async(check:()=>void)=>{const deadline=Date.now()+3000;for(;;){try{check();return}catch(error){if(Date.now()>=deadline)throw error}await delay()}}
 const persisted=()=>JSON.parse(readFileSync(s.h.directory+'/notification-receipts.json','utf8')).owners.A[n.id+':1']
 const updates={notice:async()=>({available:false,show:false})}
 const manager=new ClientNotifications(s.parent,updates,()=> 'A',async()=>({notices:[{...n}]}),async(v:any)=>{if(failed){offlineAttempts++;throw new Error('offline')}sent.push(v);return {accepted:true}})
 try{manager.setIdentity();await until(()=>assert.equal(s.windows[1]?.visible,true));await manager.refresh();const popup=s.windows[1];assert.ok(popup);assert.equal(sent.length,0);assert.equal(offlineAttempts,0)
  await s.invoke('notice-window:painted',popup,n.id+':1');await until(()=>{assert.equal(offlineAttempts,1);assert.equal(persisted().displayed,true);assert.equal(persisted().displayAck,false)});assert.equal(sent.length,0)
  failed=false;await s.invoke('notices:action',s.parent,n.id+':1','dismiss');await until(()=>{assert.deepEqual(sent.map(v=>v.state),['displayed','dismissed']);assert.equal(persisted().displayAck,true);assert.equal(persisted().dismissAck,true)});assert.equal(manager.snapshot().notices[0].dismissed,true);assert.equal(sent.length,2)
  manager.nextAttempt=0;await manager.refresh();assert.equal(popup.visible,false);assert.equal(manager.snapshot().notices[0].dismissed,true)
  assert.equal(s.opened.length,0);assert.equal(JSON.parse(readFileSync(s.h.directory+'/notification-receipts.json','utf8')).owners.A[n.id+':1'].dismissAck,true)
 }finally{s.parent.destroy()}
})
test('notification payload and action URLs remain bounded and fixed to the official site',()=>{
 const n=notice({url:'javascript:alert(1)'});assert.equal((clientNotices({notices:[n]})[0] as any).url,undefined)
 assert.equal(noticeActionUrl('download'),'https://hellodog.net/download');assert.equal(noticeActionUrl('none'),null)
 assert.throws(()=>clientNotices({notices:[notice({title:'x'.repeat(121)})]}));assert.throws(()=>clientNotices({notices:[notice({action:'javascript:'})]}))
 for(const b of [{x:0,y:0,width:980,height:700},{x:-1400,y:40,width:1200,height:800}]){const r=noticeWindowBounds(b);assert.ok(r.x>=b.x&&r.x+r.width<=b.x+b.width);assert.ok(r.y>=b.y&&r.y+r.height<=b.y+b.height-76)}
})

test('manual refresh bypasses passive backoff, details routes locally, open uses the fixed official URL',async()=>{
 const s=setup(),{ClientNotifications}=s.h.load('src/main/clientNotifications.ts'),n=notice({action:'download'}),sent:any[]=[];let reads=0
 s.parent.webContents.send=(...args:any[])=>sent.push(args)
 const manager=new ClientNotifications(s.parent,{notice:async()=>({available:false,show:false})},()=> 'A',async()=>{reads++;return {notices:[{...n}]}},async()=>({accepted:true}))
 try{
  manager.setIdentity();await delay();const before=reads
  await manager.refresh();assert.equal(reads,before)
  await s.invoke('notices:refresh',s.parent);assert.equal(reads,before+1)
  const popup=s.windows[1];await s.invoke('notice-window:action',popup,n.id+':1','details')
  assert.equal(popup.visible,false);assert.ok(sent.some(args=>args[0]==='ui:open-notices'));assert.equal(s.opened.length,0)
  await s.invoke('notices:action',s.parent,n.id+':1','open');assert.deepEqual(s.opened,['https://hellodog.net/download']);assert.equal(manager.snapshot().unread,0)
  assert.throws(()=>s.handlers.get('notices:snapshot')!({sender:s.parent.webContents,senderFrame:{}}),/登录/)
 }finally{s.parent.destroy();assert.equal(s.handlers.size,0)}
})

test('acknowledging an update clears the unread badge while its download stays available',async()=>{
 const s=setup(),{ClientNotifications}=s.h.load('src/main/clientNotifications.ts')
 const update={available:true,show:true,latestVersion:'99.0.0',currentVersion:'0.0.0'}
 const manager=new ClientNotifications(s.parent,{notice:async()=>update,snooze:async()=>({...update,show:false})},()=> 'A',async()=>({notices:[]}),async()=>({accepted:true}))
 try{manager.setIdentity();await delay();assert.equal(manager.snapshot().unread,1);await s.invoke('notices:action',s.parent,'update:99.0.0','dismiss');assert.equal(manager.snapshot().unread,0);assert.equal(manager.snapshot().update.available,true)}finally{s.parent.destroy()}
})
