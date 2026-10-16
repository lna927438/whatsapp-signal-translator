import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {EventEmitter} from 'node:events'
import ts from 'typescript'
import {join} from 'node:path'

function setup(platform='win32'){
  const handlers=new Map<string,Function>(),timers=new Map<number,Function>(),sent:any[]=[],ui:any[]=[]
  let sequence=0,reloads=0,focused=0,shown=0,quit=0
  const ipc=Object.assign(new EventEmitter(),{handle:(name:string,fn:Function)=>handlers.set(name,fn)})
  const process=Object.assign(new EventEmitter(),{env:{HELLODOG_EMBEDDED:'1'},platform,pid:1,send:(message:any)=>sent.push(message)})
  const contents=Object.assign(new EventEmitter(),{id:1,mainFrame:{detached:false},isDestroyed:()=>false,setBackgroundThrottling(){},focus(){},reload(){reloads++},send:(...args:any[])=>ui.push(args)})
  const window=Object.assign(new EventEmitter(),{webContents:contents,showInactive(){shown++},show(){shown++},focus(){focused++},setTitle(){},isMinimized:()=>false,hide(){window.emit('hide')}})
  const exports:any={}
  const code=ts.transpileModule(readFileSync(new URL('../integrations/hellodog-source/hellodog.main.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const app=Object.assign(new EventEmitter(),{quit(){quit++},getVersion:()=> '8.27.0',getAppPath:()=>'/core'});
  runInNewContext(code,{exports,process,Error,setTimeout:(fn:Function)=>{timers.set(++sequence,fn);return sequence},clearTimeout:(id:number)=>timers.delete(id),require:(name:string)=>name==='electron'?{app,ipcMain:ipc}:name==='node:path'?{join}:{randomUUID:()=>String(++sequence)}})
  exports.attachHelloDog(window)
  return{ipc,process,contents,handlers,timers,sent,ui,app,exports,window,reloads:()=>reloads,focused:()=>focused,shown:()=>shown,quit:()=>quit,event:{sender:{id:1}}}
}

test('Mac companion readiness never reads a Windows handle and focus cannot reveal a host-hidden account',()=>{
  const h=setup('darwin');h.window.emit('ready-to-show')
  assert.equal(h.sent[0].type,'ready');assert.equal(h.sent[0].pid,1);assert.equal('handle' in h.sent[0],false)
  h.process.emit('message',{channel:'hellodog',type:'focus'});assert.equal(h.shown(),0)
  h.process.emit('message',{channel:'hellodog',type:'visibility',visible:true})
  h.process.emit('message',{channel:'hellodog',type:'focus'});assert.equal(h.focused(),1)
  h.process.emit('message',{channel:'hellodog',type:'visibility',visible:false})
  assert.equal(h.sent.some(item=>item.type==='window-hidden'),false,'owner hide is not a user dismissal')
  h.process.emit('message',{channel:'hellodog',type:'visibility',visible:true});h.window.hide()
  assert.equal(h.sent.at(-1).type,'window-hidden')
})

test('Mac Cmd+Q delegates to the owner pending-task guard and only owner quit or disconnect permits exit',()=>{
  for(const cause of ['quit','disconnect']){
    const h=setup('darwin');let prevented=0
    h.app.emit('before-quit',{preventDefault(){prevented++}});assert.equal(prevented,0);assert.equal(h.sent.length,0)
    h.window.emit('ready-to-show')
    h.app.emit('before-quit',{preventDefault(){prevented++}})
    assert.equal(prevented,1);assert.equal(h.sent.at(-1).type,'request-quit');assert.equal(h.quit(),0)
    if(cause==='quit')h.process.emit('message',{channel:'hellodog',type:'quit'});else h.process.emit('disconnect')
    assert.equal(h.quit(),1)
    h.app.emit('before-quit',{preventDefault(){prevented++}});assert.equal(prevented,1)
  }
})

test('Mac Command+R follows preserving refresh and a companion keeps its normal native window',()=>{
  const h=setup('darwin');let prevented=0
  h.contents.emit('before-input-event',{preventDefault(){prevented++}},{type:'keyDown',key:'r',meta:true})
  assert.equal(prevented,1);assert.equal(h.sent[0].type,'request-refresh')
  h.app.emit('browser-window-created',{}, {setSkipTaskbar(){throw Error('no hidden dock window')},setIcon(){throw Error('not supported on macOS')}})
})
test('a bridge timeout settles the promise; a late translation cannot dispatch or resolve another message',async()=>{
  const h=setup(),pending=h.handlers.get('hellodog:translate')!(h.event,{id:'message-a'})
  const rejected=assert.rejects(pending,/超时/)
  const first=h.sent[0].id;for(const [id,callback] of h.timers){h.timers.delete(id);callback()}await rejected
  const next=h.handlers.get('hellodog:translate')!(h.event,{id:'message-b'})
  h.process.emit('message',{channel:'hellodog',type:'translation',id:first,result:{text:'late'}})
  h.process.emit('message',{channel:'hellodog',type:'translation',id:h.sent[1].id,result:{text:'second'}})
  assert.equal((await next).text,'second');assert.equal(h.timers.size,0);assert.equal(h.sent.length,2)
})
test('native page refresh waits for renderer preservation and finished loading',()=>{
  const h=setup();h.process.emit('message',{channel:'hellodog',type:'reload',id:'refresh-a'})
  assert.deepEqual(h.ui,[['hellodog:reload','refresh-a']]);assert.equal(h.reloads(),0)
  h.ipc.emit('hellodog:reload-ready',{sender:{id:99}},{id:'refresh-a',mode:'reload'});assert.equal(h.reloads(),0)
  h.ipc.emit('hellodog:reload-ready',h.event,{id:'refresh-a',mode:'reload'});assert.equal(h.reloads(),1);assert.equal(h.sent.length,0)
  h.contents.emit('did-finish-load');assert.equal(h.sent[0].type,'refreshed');assert.equal(h.sent[0].error,false)
})

test('native unread and notification bridge accept only the bound renderer and never forward chat text',()=>{
  const h=setup()
  h.ipc.emit('set-badge-count',{sender:{id:99}},12)
  h.ipc.emit('set-badge-count',h.event,-1)
  h.ipc.emit('set-badge-count',h.event,4)
  h.ipc.emit('hellodog:notification',{sender:{id:99}})
  h.ipc.emit('hellodog:notification',h.event,{text:'private text'})
  assert.equal(h.sent.length,2);assert.equal(h.sent[0].count,4);assert.equal(h.sent[1].type,'notification')
  assert.equal(JSON.stringify(h.sent).includes('private text'),false)
})

test('embedded native windows skip their own taskbar entry and carry the HelloDog icon',()=>{
 const h=setup(),settings:any={};h.app.emit('browser-window-created',{}, {setSkipTaskbar:(v:any)=>settings.skip=v,setIcon:(v:any)=>settings.icon=v});
 assert.equal(settings.skip,true);assert.ok(settings.icon.endsWith('images'+ (process.platform==='win32'?'\\':'/') +'hellodog-icon.png'));
 h.exports.forwardHelloDogNotification(99);assert.equal(h.sent.length,0);
 h.exports.forwardHelloDogNotification(1,{silent:true});assert.equal(h.sent.length,1);assert.equal(h.sent[0].silent,true);
 h.window.emit('closed');h.exports.forwardHelloDogNotification(1);assert.equal(h.sent.length,1);
})
test('busy refresh acknowledges completion without reloading or creating a send request',()=>{
  const h=setup();h.process.emit('message',{channel:'hellodog',type:'reload',id:'refresh-a'})
  h.ipc.emit('hellodog:reload-ready',h.event,{id:'refresh-a',mode:'synchronized'})
  assert.equal(h.reloads(),0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].type,'refreshed')
})
test('a draft-save error returns a failed refresh instead of a silent no-op',()=>{
  const h=setup();h.process.emit('message',{channel:'hellodog',type:'reload',id:'refresh-a'})
  h.ipc.emit('hellodog:reload-ready',h.event,{id:'refresh-a',error:true})
  assert.equal(h.reloads(),0);assert.equal(h.sent[0].error,true)
})

test('restart preparation is acknowledged only by the matched native window and request',()=>{
  const h=setup();h.process.emit('message',{channel:'hellodog',type:'prepare-restart',id:'restart-a'})
  assert.deepEqual(h.ui,[['hellodog:prepare-restart','restart-a']])
  h.ipc.emit('hellodog:restart-ready',{sender:{id:99}},{id:'restart-a'})
  h.ipc.emit('hellodog:restart-ready',h.event,{id:'wrong'})
  assert.equal(h.sent.length,0)
  h.ipc.emit('hellodog:restart-ready',h.event,{id:'restart-a'})
  assert.equal(h.sent[0].type,'restart-ready');assert.equal(h.sent[0].error,false);assert.equal(h.reloads(),0)
})
test('native F5 and Ctrl+R request the preserving refresh flow instead of reloading directly',()=>{
  const h=setup();let prevented=0
  for(const input of [{type:'keyDown',key:'F5'},{type:'keyDown',key:'r',control:true}])h.contents.emit('before-input-event',{preventDefault(){prevented++}},input)
  assert.equal(prevented,2);assert.ok(h.sent.every(item=>item.type==='request-refresh'));assert.equal(h.reloads(),0)
})

test('a quick reply acknowledgement is bound to the originating native renderer and command',()=>{
  const h=setup();h.process.emit('message',{channel:'hellodog',type:'insert-draft',id:'draft-a',text:'Hello 👋'})
  assert.equal(h.ui[0][0],'hellodog:insert-draft')
  h.ipc.emit('hellodog:draft-inserted',{sender:{id:99}},{id:'draft-a'})
  h.ipc.emit('hellodog:draft-inserted',h.event,{id:'wrong'})
  assert.equal(h.sent.length,0)
  h.ipc.emit('hellodog:draft-inserted',h.event,{id:'draft-a'})
  assert.equal(h.sent[0].type,'draft-inserted');assert.equal(h.sent[0].error,false)
  assert.equal(h.reloads(),0);assert.deepEqual([...h.handlers.keys()].sort(),['hellodog:translate','hellodog:voice'])
})

test('native policy barrier ACK is private and bound to the exact live main frame and one token',()=>{
  const h=setup(),id='10000000-0000-4000-8000-000000000001'
  h.process.emit('message',{channel:'hellodog',type:'send-policy-invalidate',id})
  assert.deepEqual(h.ui,[['hellodog:send-policy-invalidate',id]])
  for(const event of [{sender:{id:1},senderFrame:h.contents.mainFrame},{sender:h.contents,senderFrame:{detached:false}}])h.ipc.emit('hellodog:send-policy-invalidated',event,id)
  h.ipc.emit('hellodog:send-policy-invalidated',{sender:h.contents,senderFrame:h.contents.mainFrame},'different')
  assert.equal(h.sent.length,0)
  h.ipc.emit('hellodog:send-policy-invalidated',{sender:h.contents,senderFrame:h.contents.mainFrame},id)
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].type,'send-policy-invalidated');assert.equal(h.sent[0].id,id);assert.equal(h.timers.size,0)
  h.ipc.emit('hellodog:send-policy-invalidated',{sender:h.contents,senderFrame:h.contents.mainFrame},id);assert.equal(h.sent.length,1)
})

test('native policy barrier rejects replaced frames, expired tokens and closed windows',()=>{
  for(const mode of ['navigation','timeout','closed']){
    const h=setup(),id='10000000-0000-4000-8000-000000000001'
    h.process.emit('message',{channel:'hellodog',type:'send-policy-invalidate',id});const frame=h.contents.mainFrame
    if(mode==='navigation')h.contents.mainFrame={detached:false}
    else if(mode==='timeout')for(const [timer,callback] of h.timers){h.timers.delete(timer);callback()}
    else h.window.emit('closed')
    h.ipc.emit('hellodog:send-policy-invalidated',{sender:h.contents,senderFrame:frame},id)
    assert.equal(h.sent.length,0);h.window.emit('closed');assert.equal(h.timers.size,0)
  }
})
