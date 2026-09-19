import {spawn} from 'node:child_process'
import {mkdir, writeFile, stat} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {createInterface} from 'node:readline'
import assert from 'node:assert/strict'
import {mainHarness} from './main-harness.ts'

const {discoverGoogleVoiceWindows,GoogleVoiceNativeWindowHost}=mainHarness().load('src/main/platforms/googleVoice/nativeWindowHost.ts')
const root=resolve('..'), evidence=join(root,'verification/google-voice-embedded-20260918'), helper=join(root,'resources/native/GoogleVoiceWindowHost.exe')
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const parent=spawn(join(evidence,'TestParent.exe'),[],{shell:false,windowsHide:false,stdio:['pipe','pipe','pipe']})
const lines=createInterface({input:parent.stdout}), queued:any[]=[], pending:Array<(value:any)=>void>=[]
lines.on('line',line=>{const value=JSON.parse(line);const next=pending.shift();next?next(value):queued.push(value)})
function read():Promise<any>{return queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('parent response timeout')),5000);pending.push(value=>{clearTimeout(timer);resolve(value)})})}
async function inspect(hwnd:string){parent.stdin.write('inspect '+hwnd+'\n');return read()}
// Browser-owned modal dialogs may asynchronously toggle WS_DISABLED. The host
// must preserve it rather than claiming it owns or dismissing official dialogs.
const structural=(value:any)=>({...value,style:value.style&~0x08000000})
const host=await read(),results:any[]=[]
try{
 for(const [name,exe] of [['chrome','C:/Program Files/Google/Chrome/Application/chrome.exe'],['edge','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]){
  if(!(await stat(exe).catch(()=>null)))continue
  const profile=join(evidence,'isolated-'+name+'-'+Date.now());await mkdir(profile,{recursive:true})
  const browser=spawn(exe,['--app=https://voice.google.com/','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check'],{shell:false,windowsHide:false,stdio:'ignore',detached:true});browser.unref()
  let windows:any[]=[]
  for(let attempt=0;attempt<25&&!windows.length;attempt++){windows=await discoverGoogleVoiceWindows(helper,exe,profile);if(!windows.length)await delay(400)}
  assert.equal(windows.length,1,name+' single dedicated app window')
  const window=windows[0], before=await inspect(window.hwnd), native=new GoogleVoiceNativeWindowHost(helper,{spawn:(...args:Parameters<typeof spawn>)=>{const child=spawn(...args);child.stdout?.on('data',chunk=>console.log('helper',String(chunk).trim()));child.stderr?.on('data',chunk=>console.log('helper-detail',String(chunk).trim()));return child}})
  try{
   assert.equal((await discoverGoogleVoiceWindows(helper,exe,profile+'-wrong')).length,0)
   await native.attach({parentHwnd:host.hwnd,parentPid:host.pid,child:window,executable:exe,profile})
   native.setBounds({x:18,y:24,width:640,height:420});native.setVisible(true);await delay(250)
   const attached=await inspect(window.hwnd);assert.notEqual(attached.parent,host.hwnd);assert.notEqual(attached.parent,'0');assert.equal(attached.width,640);assert.equal(attached.height,420);assert.equal(attached.visible,true)
   native.setVisible(false);await delay(100);assert.equal((await inspect(window.hwnd)).visible,false)
   native.setVisible(true);native.focus();await delay(100)
   await native.detach();const after=await inspect(window.hwnd)
   assert.equal(after.parent,'0');assert.equal(structural(after).style,structural(before).style);assert.equal(after.exstyle,before.exstyle);assert.equal(after.visible,true)
   assert.equal(after.width,before.width);assert.equal(after.height,before.height)
   const rejected=new GoogleVoiceNativeWindowHost(helper)
   await assert.rejects(rejected.attach({parentHwnd:host.hwnd,parentPid:host.pid,child:{...window,startTicks:String(BigInt(window.startTicks)+1n)},executable:exe,profile}),/无法确认/)
   await rejected.detach();assert.deepEqual(structural(await inspect(window.hwnd)),structural(after))
   const differentDpiParent=spawn(join(evidence,'TestParent.exe'),['-1'],{shell:false,windowsHide:false,stdio:['pipe','pipe','pipe']})
   const differentDpiLines=createInterface({input:differentDpiParent.stdout})
   try{
    const differentDpi=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('DPI parent timeout')),5000);differentDpiLines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line))})})
    const separatePane=new GoogleVoiceNativeWindowHost(helper)
    // The actual native parent is now our independently matched DPI pane; the
    // unrelated outer main-window DPI no longer forces a cross-DPI SetParent.
    await separatePane.attach({parentHwnd:differentDpi.hwnd,parentPid:differentDpi.pid,child:window,executable:exe,profile})
    await separatePane.detach();assert.deepEqual(structural(await inspect(window.hwnd)),structural(after))
   }finally{differentDpiParent.stdin.end('close\n');differentDpiLines.close()}
   const eof=spawn(helper,['attach',host.hwnd,String(host.pid),window.hwnd,String(window.pid),window.startTicks,exe,profile],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})
   const eofLines=createInterface({input:eof.stdout}),eofEvents:any[]=[]
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('EOF recovery timeout')),8000);eofLines.on('line',line=>{const event=JSON.parse(line);eofEvents.push(event);if(event.event==='attached')eof.stdin.end();if(event.event==='detached'){clearTimeout(timer);event.verified?resolve():reject(new Error('EOF recovery failed'))}});eof.once('error',reject)})
   eofLines.close();assert.deepEqual(structural(await inspect(window.hwnd)),structural(after))
   results.push({browser:name,profile,identity:window,before,attached,after,eofEvents,rejectedStaleProcess:true,independentPaneSupportsDifferentMainDpi:true,passed:true})
  }finally{await native.detach().catch(()=>{});parent.stdin.write('close-child '+window.hwnd+'\n');await read()}
 }
 await writeFile(join(evidence,'native-browser-results.json'),JSON.stringify({testedAt:new Date().toISOString(),parent:host,results,limit:'No login, messaging, calls, microphone, authentication dialogs or real user browser profiles were exercised.'},null,2))
 console.log(JSON.stringify({passed:results.length,results:results.map(result=>({browser:result.browser,passed:result.passed}))}))
}finally{parent.stdin.end('close\n');lines.close()}
