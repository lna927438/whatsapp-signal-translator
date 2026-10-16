import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { signalDesktopLayout, signalCompanionVisible } from '../src/main/platforms/signal/signalDesktopPlatform.ts'
const require = createRequire(import.meta.url)

test('platform paths select a real Mac application and never require a Windows helper', () => {
  const mac = signalDesktopLayout('darwin','/resources/signal-desktop','/electron','/native',()=>true)
  assert.equal(mac.executable,join('/resources/signal-desktop','Signal.app','Contents','MacOS','Signal'))
  assert.equal(mac.helper,undefined);assert.deepEqual(mac.args,[]);assert.equal(mac.presentation,'companion')
  const development=signalDesktopLayout('darwin','/source','/electron','/native',()=>false)
  assert.equal(development.executable,join('/electron','dist','Electron.app','Contents','MacOS','Electron'))
  assert.deepEqual(development.args,['/source'])
  const windows=signalDesktopLayout('win32','C:/core','C:/electron','C:/native',()=>true)
  assert.equal(windows.executable,join('C:/core','Signal.exe'));assert.equal(windows.helper,join('C:/native','SignalWindowHost.exe'))
  assert.equal(signalDesktopLayout('linux','/r','/e','/n',()=>true).supported,false)
})

function fixture(platform='darwin') {
  let owner='owner-a',visible=true,minimized=false,quit=0
  const children:any[]=[],launches:any[]=[],events:any[]=[],app:any=new EventEmitter(),window:any=new EventEmitter()
  Object.assign(app,{isPackaged:true,getPath:()=>'/profiles',getAppPath:()=>'/app',quit:()=>quit++})
  Object.assign(window,{webContents:{id:1,send:(...event:any[])=>events.push(event),getZoomFactor:()=>1},isDestroyed:()=>false,isVisible:()=>visible,isMinimized:()=>minimized,show(){visible=true;window.emit('show')},hide(){visible=false;window.emit('hide')},restore(){minimized=false;window.emit('restore')},focus(){},getNativeWindowHandle(){throw Error('Mac must not read native HWND')}})
  const spawn=(executable:string,args:any,options:any)=>{
    launches.push({executable,args,options})
    const child:any=new EventEmitter()
    Object.assign(child,{pid:1000+children.length,connected:true,exitCode:null,sent:[],send(value:any,callback?:Function){child.sent.push(value);callback?.();if(value.type==='quit'){child.exitCode=0;child.emit('exit',0)}},kill(){child.exitCode=0;child.emit('exit',0)}})
    children.push(child);return child
  }
  const stubs:any={electron:{app,ipcMain:new EventEmitter(),screen:{getDisplayMatching:()=>{throw Error('Mac must not use HWND geometry')}}},child_process:{spawn},fs:{existsSync:()=>true,realpathSync:(value:string)=>value},'fs/promises':{mkdir:async()=>{}},'./signalDesktopPlatform':{signalDesktopLayout,signalCompanionVisible},'./signalDesktopVoice':{decodeSignalVoiceRequest:()=>{throw Error('unexpected voice')}},'./signalTranslationErrors':{signalTranslationErrorMessage:()=> 'translation error'},'../../runtimeHealth':{setAccountState(){},setExternalMetrics(){}},'../../desktopRuntime':{updateAccountUnread(){},notifyAccount(){}}}
  const exports:any={}
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/main/platforms/signal/signalDesktopHost.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{platform,pid:42,env:{},resourcesPath:'/resources'},setTimeout,clearTimeout,Buffer,require:(name:string)=>stubs[name]||require(name)})
  const host=new exports.SignalDesktopHost(window,()=>owner,async()=>({text:'translated'}))
  const record=(id:string)=>({id,platform:'signal',signalEngine:'desktop',label:id})
  const ready=(child:any,pid=child.pid)=>child.emit('message',{channel:'hellodog',type:'ready',pid,version:'8.27.0'})
  return {host,children,launches,events,window,record,ready,owner:(value:string)=>owner=value,quit:()=>quit,minimize(){minimized=true;window.emit('minimize')}}
}

test('Mac readiness uses owning PID and private IPC; background launch stays hidden without a helper',async()=>{
  const h=fixture();try{
    await h.host.open(h.record('a'),true)
    assert.equal(h.host.status('a').presentation,'companion');assert.equal(h.host.status('a').available,true)
    assert.equal(h.launches.length,1);assert.equal(h.launches[0].options.stdio[3],'ipc')
    assert.ok(h.launches[0].options.env.HELLODOG_SIGNAL_USER_DATA.includes('signal-desktop-profiles'))
    h.ready(h.children[0],999);assert.equal(h.host.status('a').state,'starting')
    h.ready(h.children[0]);assert.equal(h.host.status('a').state,'ready');assert.equal(h.host.status('a').visible,false)
    assert.equal(h.launches.length,1);assert.equal(h.children[0].sent.some((item:any)=>item.type==='focus'),false)
    h.host.focus('a');assert.equal(h.host.status('a').visible,true);assert.equal(h.children[0].sent.at(-1).type,'focus')
  }finally{await h.host.stopAll()}
})

test('companion dismissal survives layout changes, account switching hides old window, explicit reopen restores',async()=>{
  const h=fixture();try{
    for(const id of ['a','b']){await h.host.open(h.record(id),true);h.ready(h.children.at(-1))}
    const [a,b]=h.children;h.host.focus('a')
    a.emit('message',{channel:'hellodog',type:'window-hidden'});h.window.emit('resize')
    assert.equal(h.host.status('a').visible,false)
    h.host.focus('a');assert.equal(h.host.status('a').visible,true)
    h.host.focus('b');assert.equal(h.host.status('a').visible,false);assert.equal(h.host.status('b').visible,true)
    h.host.setOverlayOpen(true);assert.equal(h.host.status('b').visible,false)
    h.host.setOverlayOpen(false);assert.equal(h.host.status('b').visible,true)
    h.minimize();assert.equal(h.host.status('b').visible,false);h.window.restore();assert.equal(h.host.status('b').visible,true)
    b.emit('message',{channel:'hellodog',type:'request-quit'});assert.equal(h.quit(),1)
    h.owner('owner-b');h.window.emit('resize');assert.equal(h.host.status('b').visible,false)
    b.emit('message',{channel:'hellodog',type:'request-quit'});assert.equal(h.quit(),1)
    b.emit('message',{channel:'hellodog',type:'request-focus'});assert.equal(h.events.some((item:any)=>item[0]==='ui:account-action'),false)
  }finally{await h.host.stopAll()}
})

test('Mac crash can restart only its isolated account and ignores an old child readiness replay',async()=>{
  const h=fixture();try{
    await h.host.open(h.record('a'));const first=h.children[0];h.ready(first)
    first.exitCode=1;first.emit('exit',1);assert.equal(h.host.status('a').state,'failed')
    await h.host.open(h.record('a'));const replacement=h.children[1]
    h.ready(first);assert.equal(h.host.status('a').state,'starting')
    h.ready(replacement);assert.equal(h.host.status('a').state,'ready')
    assert.equal(h.launches[0].options.env.HELLODOG_SIGNAL_USER_DATA,h.launches[1].options.env.HELLODOG_SIGNAL_USER_DATA)
    replacement.emit('message',{channel:'hellodog',type:'request-focus'})
    assert.deepEqual(JSON.parse(JSON.stringify(h.events.at(-1))),['ui:account-action',{action:'focus',accountId:'a'}])
  }finally{await h.host.stopAll()}
})
