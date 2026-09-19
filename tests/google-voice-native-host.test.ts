import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {mainHarness} from './main-harness.ts'
const {GoogleVoiceNativeWindowHost,discoverGoogleVoiceWindows}=mainHarness().load('src/main/platforms/googleVoice/nativeWindowHost.ts')
const HELPER='D:\\HelloDog\\native\\GoogleVoiceWindowHost.exe',EXE='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',PROFILE='D:\\HelloDog\\google-voice\\owner\\window\\chrome'
const configuration={parentHwnd:'100',parentPid:10,child:{hwnd:'200',pid:20,startTicks:'639000000000000000'},executable:EXE,profile:PROFILE}
class FakeChild extends EventEmitter {
 stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();commands='';kills=0
 constructor(){super();this.stdin.on('data',chunk=>this.commands+=String(chunk))}
 kill(){this.kills++;this.emit('close',1);return true}
 output(value:any){this.stdout.write(JSON.stringify(value)+'\n')}
}
function setup(action:(child:FakeChild)=>void=child=>child.output({event:'attached'})){
 const calls:any[]=[],children:FakeChild[]=[]
 const dependencies={timeoutMs:80,spawn:(file:string,args:string[],options:any)=>{const child=new FakeChild();calls.push({file,args:[...args],options:{...options}});children.push(child);queueMicrotask(()=>{child.emit('spawn');action(child)});return child}}
 const host=new GoogleVoiceNativeWindowHost(HELPER,dependencies)
 return{host,calls,children,dependencies}
}
test('native attachment uses only fixed helper arguments and a non-shell hidden helper',async()=>{
 const h=setup();await h.host.attach(configuration)
 assert.deepEqual(h.calls[0].args,['attach','100','10','200','20','639000000000000000',EXE,PROFILE])
 assert.equal(h.calls[0].options.shell,false);assert.equal(h.calls[0].options.windowsHide,true)
 h.host.setBounds({x:4,y:5,width:800,height:600});h.host.setVisible(true);h.host.focus();h.host.focus(true);h.host.setVisible(false)
 assert.equal(h.children[0].commands,'bounds 4 5 800 600\nshow\nfocus\nfocus-host\nhide\n')
 h.children[0].stdin.on('finish',()=>h.children[0].output({event:'detached',verified:true}))
 await h.host.detach();assert.equal(h.children[0].kills,0)
})
test('detachment requires an explicit verified acknowledgment and is coalesced',async()=>{
 const h=setup();await h.host.attach(configuration)
 const first=h.host.detach(),second=h.host.detach();assert.strictEqual(first,second)
 let finished=false;void first.then(()=>finished=true)
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false)
 h.children[0].output({event:'detached',verified:true});await first;await h.host.detach()
 assert.equal(h.children[0].commands,'detach\n');assert.equal(h.children[0].kills,0)
})
test('process exit without a detach acknowledgment does not falsely report restoration',async()=>{
 const h=setup();await h.host.attach(configuration)
 const detached=h.host.detach();h.children[0].emit('close',0)
 await assert.rejects(detached,/恢复尚未确认/);assert.equal(h.children[0].kills,0)
})

test('process creation failure leaves the browser untouched and does not block shutdown',async()=>{
 const child=new FakeChild()
 const host=new GoogleVoiceNativeWindowHost(HELPER,{timeoutMs:80,spawn:()=>{
  queueMicrotask(()=>{child.emit('error',Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'}));child.emit('close',-4058)})
  return child
 }})
 await assert.rejects(host.attach(configuration),/无法启动/)
 await host.detach();assert.equal(child.commands,'');assert.equal(child.kills,0)
})

test('an error after process creation still requires verified window restoration',async()=>{
 const h=setup(child=>{child.emit('error',new Error('started helper failed'));child.emit('close',1)})
 await assert.rejects(h.host.attach(configuration),/无法启动/)
 await assert.rejects(h.host.detach(),/恢复尚未确认/);assert.equal(h.children[0].kills,0)
})
test('failed restoration or timeout rejects, never kills browser or attached helper',async()=>{
 const failed=setup();await failed.host.attach(configuration)
 const operation=failed.host.detach();failed.children[0].output({event:'detached',verified:false})
 await assert.rejects(operation,/未能确认/);assert.equal(failed.children[0].kills,0)
 const timed=setup();await timed.host.attach(configuration);await assert.rejects(timed.host.detach(),/恢复超时/);assert.equal(timed.children[0].kills,0)
})
test('an identity change while helper is attaching triggers recovery before reporting success',async()=>{
 let allowed=true
 const h=setup(child=>{allowed=false;child.stdin.on('finish',()=>child.output({event:'detached',verified:true}));child.output({event:'attached'})})
 await assert.rejects(h.host.attach(configuration,()=>allowed),/登录状态已变化/)
 await new Promise(resolve=>setImmediate(resolve));await h.host.detach();assert.equal(h.children[0].commands,'detach\n')
})
test('disconnected listeners fire once for verified detachment and can unsubscribe',async()=>{
 const h=setup();let count=0;const off=h.host.onDisconnected(()=>count++)
 await h.host.attach(configuration);h.children[0].output({event:'detached',verified:true});h.children[0].emit('close',0)
 assert.equal(count,1);off()
})
test('untrusted paths, identity values and revoked authorization never spawn',async()=>{
 for(const value of [{...configuration,executable:'evil.exe'},{...configuration,profile:'\\\\server\\share'},{...configuration,child:{...configuration.child,hwnd:'2\nshow'}},{...configuration,parentPid:20}]){
  const h=setup();await assert.rejects(h.host.attach(value));assert.equal(h.calls.length,0)
 }
 const h=setup();await assert.rejects(h.host.attach(configuration,()=>false));assert.equal(h.calls.length,0)
})
test('invalid layouts cannot create extra native commands',async()=>{
 const h=setup();await h.host.attach(configuration)
 for(const value of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:0,y:0,width:100.5,height:10},{x:0,y:0,width:64001,height:10}])assert.throws(()=>h.host.setBounds(value))
 assert.equal(h.children[0].commands,'');h.children[0].output({event:'detached',verified:true})
})

test('unchanged resize and visibility notifications do not flood the native helper',async()=>{
 const h=setup();await h.host.attach(configuration)
 for(let i=0;i<1000;i++){h.host.setBounds({x:4,y:5,width:800,height:600});h.host.setVisible(true)}
 assert.equal(h.children[0].commands,'bounds 4 5 800 600\nshow\n')
 h.host.setVisible(false);h.host.setVisible(false);h.host.setBounds({x:4,y:5,width:801,height:600})
 assert.equal(h.children[0].commands,'bounds 4 5 800 600\nshow\nhide\nbounds 4 5 801 600\n')
 h.children[0].output({event:'detached',verified:true})
})

test('a later verified recovery acknowledgment remains usable after initial recovery failure',async()=>{
 const h=setup();await h.host.attach(configuration)
 const operation=h.host.detach();h.children[0].output({event:'detached',verified:false})
 await assert.rejects(operation,/未能确认/)
 h.children[0].output({event:'detached',verified:true});await h.host.detach();assert.equal(h.children[0].kills,0)
})
test('a pre-attachment rejection can explicitly confirm that the window was untouched',async()=>{
 const h=setup(child=>{child.output({event:'error',reason:'dpi'});child.output({event:'detached',verified:true,untouched:true});child.emit('close',3)})
 await assert.rejects(h.host.attach(configuration),/显示缩放模式/);await h.host.detach();assert.equal(h.children[0].kills,0)
})
test('discovery validates typed identities and never accepts arbitrary helper output',async()=>{
 const good=setup(child=>{child.output({windows:[configuration.child]});child.emit('close',0)})
 const windows=await discoverGoogleVoiceWindows(HELPER,EXE,PROFILE,good.dependencies)
 assert.deepEqual(JSON.parse(JSON.stringify(windows)),[configuration.child]);assert.equal(good.calls[0].args[0],'discover')
 const bad=setup(child=>{child.output({windows:[{...configuration.child,pid:'20'}]});child.emit('close',0)})
 await assert.rejects(discoverGoogleVoiceWindows(HELPER,EXE,PROFILE,bad.dependencies))
})
test('read-only discovery timeout may stop only the metadata helper',async()=>{
 const h=setup(()=>{})
 await assert.rejects(discoverGoogleVoiceWindows(HELPER,EXE,PROFILE,h.dependencies));assert.equal(h.children[0].kills,1)
})
