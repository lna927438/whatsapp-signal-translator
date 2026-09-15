import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
const require=createRequire(import.meta.url),{_electron}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright'),root=fileURLToPath(new URL('../',import.meta.url)),h=mainHarness()
const {voiceAudioWav,validateVoiceWav}=h.load('src/shared/voiceAudio.ts'),config=await readFile(join(root,'electron.vite.config.ts'),'utf8'),csp=config.match(/'Content-Security-Policy', content: "([^"]+)"/)?.[1];assert.ok(csp)
const directory=join(root,'verification/release-0.5.12/voice-csp');await mkdir(directory,{recursive:true})
const withoutBlob=csp.replace(/connect-src ([^;]+)/,(_,values)=>'connect-src '+values.split(' ').filter(value=>value!=='blob:').join(' ')),withBlob=withoutBlob.replace('connect-src ',"connect-src blob: ")
for(const [name,policy] of [['original-no-blob',withoutBlob],['allow-blob',withBlob],['production',csp]])await writeFile(join(directory,name+'.html'),'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+policy+'"></head><body>Local voice CSP test</body></html>')
await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(__dirname,'original-no-blob.html'));});`)
const electron=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[join(directory,'main.cjs')],env:{...process.env,TEMP:'D:/UserAppData/Temp',TMP:'D:/UserAppData/Temp'},timeout:30000}),checks=[]
try{
 const page=await electron.firstWindow(),requests=[];page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())})
 await page.waitForURL(pathToFileURL(join(directory,'original-no-blob.html')).href,{waitUntil:'load'})
 for(const name of ['original-no-blob','allow-blob','production']){
  await page.goto(pathToFileURL(join(directory,name+'.html')).href,{waitUntil:'load'})
  // DevTools supplies the test function; fetch and WebAudio still execute under
  // the actual file-page CSP. No fetch/AudioContext/decoder mocks are installed.
  await page.evaluate(()=>{
   const samples=3200,bytes=new Uint8Array(44+samples*2),view=new DataView(bytes.buffer)
   for(const [at,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i)
   view.setUint32(4,bytes.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,samples*2,true)
   for(let i=0;i<samples;i++)view.setInt16(44+i*2,Math.round(Math.sin(i*.09)*12000),true)
   window.__voiceUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));window.__violations=[];document.addEventListener('securitypolicyviolation',event=>window.__violations.push({directive:event.effectiveDirective,blockedUri:event.blockedURI}))
  })
  const result=await page.evaluate(`(async()=>{const decode=${voiceAudioWav.toString()};try{const decoded=await decode(window.__voiceUrl);return{success:true,bytes:Array.from(decoded),violations:window.__violations,nodeIntegration:typeof window.require}}catch(error){await new Promise(resolve=>setTimeout(resolve,25));return{success:false,error:error.message,violations:window.__violations,nodeIntegration:typeof window.require}}finally{URL.revokeObjectURL(window.__voiceUrl)}})()`)
  if(result.success){const bytes=new Uint8Array(result.bytes);validateVoiceWav(bytes);result.bytes=undefined;result.canonicalPcmValidated=true;result.byteLength=bytes.length}
  checks.push({name,...result})
 }
 assert.deepEqual(requests,[]);assert.equal(checks[1].success,true);assert.equal(checks[1].nodeIntegration,'undefined')
 const result={at:new Date().toISOString(),passed:checks[2].success===true,productionCsp:csp,checks,isolatedElectron:true,realBlobFetch:true,realWebAudioDecode:true,nativeRecognizerCalled:false,providerCalls:0,realChatSends:0}
 await writeFile(join(directory,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1
}finally{await electron.close();rmSync(h.directory,{recursive:true,force:true})}
