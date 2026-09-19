import {spawn,execFileSync} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createInterface} from 'node:readline'
import assert from 'node:assert/strict'
import {mainHarness} from './main-harness.ts'
const {discoverGoogleVoiceWindows,GoogleVoiceNativeWindowHost}=mainHarness().load('src/main/platforms/googleVoice/nativeWindowHost.ts')
const root=resolve('..'),evidence=join(root,'verification/google-voice-embedded-20260918'),helper=join(root,'resources/native/GoogleVoiceWindowHost.exe'),probe=join(evidence,'WindowProbe.exe')
const inspect=(hwnd:string)=>JSON.parse(execFileSync(probe,[hwnd],{windowsHide:true,encoding:'utf8'}))
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const exe='C:/Program Files/Google/Chrome/Application/chrome.exe',profile='D:/UserAppData/Temp/hellodog-gv-owner-'+Date.now(),results:any[]=[]
await mkdir(profile,{recursive:true})
const browser=spawn(exe,['--app=https://voice.google.com/','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check'],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});browser.unref()
let windows:any[]=[]
for(let i=0;i<25&&!windows.length;i++){windows=await discoverGoogleVoiceWindows(helper,exe,profile);if(!windows.length)await wait(250)}
assert.equal(windows.length,1,'single verified empty-profile Chrome window');const child=windows[0]
try{
 for(const mode of ['close','crash','electron-close','electron-crash','helper-crash']){
  const electron=mode.startsWith('electron'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const parent=spawn(electron?join(root,'node_modules/electron/dist/electron.exe'):join(evidence,'TestParent.exe'),electron?[join(evidence,'electron-parent.cjs')]:['-3'],{shell:false,windowsHide:false,env,stdio:['pipe','pipe','pipe']}),lines=createInterface({input:parent.stdout})
  const hostIdentity=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('parent timeout')),8000);lines.on('line',line=>{if(!line.startsWith('{'))return;clearTimeout(timer);resolve(JSON.parse(line))})})
  let helperProcess:ReturnType<typeof spawn>|undefined
  const native=new GoogleVoiceNativeWindowHost(helper,{spawn:(...args:Parameters<typeof spawn>)=>helperProcess=spawn(...args)});const disconnected:any[]=[];native.onDisconnected((error?:Error)=>disconnected.push({error:error?.message}))
  await native.attach({parentHwnd:hostIdentity.hwnd,parentPid:hostIdentity.pid,child,executable:exe,profile});native.setBounds({x:20,y:40,width:640,height:420});native.setVisible(true);await wait(200)
  const before=inspect(child.hwnd),pane=inspect(before.parent);assert.equal(pane.owner,'0');assert.equal(pane.childStyle,false);assert.equal(pane.perMonitorV2,true);assert.equal(inspect(hostIdentity.hwnd).perMonitorV1,true)
  // Only the dedicated synthetic parent is closed/killed, never a user process.
  if(mode==='helper-crash')helperProcess!.kill();else if(mode.endsWith('crash'))parent.kill();else parent.stdin.end('close\n')
  if(mode!=='helper-crash')await new Promise<void>(resolve=>parent.once('exit',()=>resolve()));await wait(750)
  const after=inspect(child.hwnd),paneAfter=inspect(before.parent)
  results.push({mode,parent:hostIdentity,before,pane,after,paneAfter,disconnected})
  await writeFile(join(evidence,'unowned-pane-lifecycle-results.json'),JSON.stringify({testedAt:new Date().toISOString(),results},null,2))
  if(mode==='helper-crash'){
   // This deliberately bypasses every finally block. Record the actual OS
   // result rather than promising recovery from an uncatchable process kill.
   parent.stdin.end('close\n');await native.detach().catch(()=>undefined)
  }else{assert.equal(after.exists,true,'browser survives '+mode);assert.equal(after.parent,'0','browser restored after '+mode);assert.equal(after.visible,true);await native.detach()}
  lines.close()
 }
 console.log(JSON.stringify({passed:true,scenarios:results.map(value=>value.mode)}))
}finally{try{execFileSync(probe,[child.hwnd,'close'],{windowsHide:true})}catch{}}
