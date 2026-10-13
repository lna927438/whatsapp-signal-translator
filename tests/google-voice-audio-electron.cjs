const {app,BrowserWindow,ipcMain,session}=require('electron')
const {join}=require('node:path')
const {writeFileSync,mkdtempSync}=require('node:fs')
const assert=require('node:assert/strict')
const folder=process.argv[2],profile=mkdtempSync('D:/UserAppData/Temp/hellodog-voice-direct-')
app.setPath('userData',profile)
const calls=[],errors=[],checks=[]
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let window
const page=code=>window.webContents.executeJavaScript(code)
const isolated=code=>window.webContents.executeJavaScriptInIsolatedWorld(999,[{code}])
async function until(predicate,label){for(let n=0;n<100;n++){if(await predicate())return;await wait(50)}throw Error('Timed out: '+label)}
const result={text:'Hello from synthetic voice.',englishTranslation:'Hello from synthetic voice.',translation:'这是合成语音。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}
ipcMain.handle('google-voice:voice-audio',async(_event,value)=>{
 assert.deepEqual(Object.keys(value).sort(),['bytes','conversationId','messageId'])
 assert.equal(value.bytes instanceof Uint8Array,true);assert.equal(value.bytes.byteLength,32044)
 assert.equal(String.fromCharCode(...value.bytes.slice(0,4)),'RIFF')
 assert.match(value.conversationId,/^google-voice-audio:[a-f0-9]{64}$/);assert.match(value.messageId,/^voice:google-voice:[a-f0-9]{64}$/)
 calls.push({size:value.bytes.byteLength,conversationId:value.conversationId,messageId:value.messageId});return result
})
ipcMain.handle('google-voice:translate-request',async()=>({ok:true,result:{connected:true,receiveAutoTranslate:false,sendAutoTranslate:false,historyMode:'manual'}}))
ipcMain.handle('google-voice:runtime-health',()=>undefined)
ipcMain.handle('google-voice:unread',()=>undefined)
const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px Arial;padding:20px}gv-voicemail-thread{display:block;border-radius:12px;padding:12px;background:#eff4ef;width:440px;margin:12px}gv-audio-player{display:flex;gap:15px;align-items:center}button{padding:12px}audio{display:none}[role=slider]{width:180px;height:8px;background:#87a891}</style><div id="fixtures"></div><script>
window.fixtureWav=()=>{const bytes=new Uint8Array(32044),v=new DataView(bytes.buffer),text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i))};text(0,'RIFF');v.setUint32(4,32036,true);text(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,32000,true);for(let n=0;n<16000;n++)v.setInt16(44+n*2,Math.sin(n*2*Math.PI*440/16000)*4000,true);return bytes};
window.fixture=(id,lazy)=>{const row=document.createElement('gv-voicemail-thread');row.dataset.voicemailId=id;row.innerHTML='<gv-audio-player><button aria-label="Play voicemail">Play</button><span>0:01</span><div role="slider"></div></gv-audio-player>';document.querySelector('#fixtures').append(row);const control=row.querySelector('button'),audio=new Audio();audio.muted=true;let loaded=!lazy,playing=false;window.lastAudio=audio;window.nativeClicks=0;audio.addEventListener('pause',()=>{playing=false;control.setAttribute('aria-label','Play voicemail')});const play=()=>{audio.src=URL.createObjectURL(new Blob([fixtureWav()],{type:'audio/wav'}));playing=true;control.setAttribute('aria-label','Pause voicemail');void audio.play().catch(()=>{})};control.onclick=()=>{window.nativeClicks++;if(playing){audio.pause();playing=false;control.setAttribute('aria-label','Play voicemail')}else if(loaded)play();else setTimeout(()=>{loaded=true;play()},25)};return row};
</script>`
app.whenReady().then(async()=>{
 try{
  const own=session.fromPartition('direct-voice-'+Date.now());own.protocol.handle('https',()=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}))
  window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{session:own,preload:join(folder,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  window.webContents.on('preload-error',(_event,_path,error)=>errors.push(error.message));window.webContents.setFrameRate(30);window.webContents.startPainting()
  await window.loadURL('https://voice.google.com/u/0/voicemail')
  assert.deepEqual(await page('({require:typeof require,ipc:typeof ipcRenderer,bridge:typeof realtimeTranslator,roots:typeof __voiceFixtureRoots})'),{require:'undefined',ipc:'undefined',bridge:'undefined',roots:'undefined'})
  checks.push('sandboxed isolated preload exposes no Node, IPC or fixture roots to official page')
  for(const lazy of [false,true]){
   await page(`fixture(${JSON.stringify(lazy?'first-load':'ready')},${lazy})`)
   await until(()=>isolated('__voiceFixtureRoots.some(root=>root.host.isConnected&&root.querySelector("button")&&!root.querySelector("button").disabled&&root.querySelector("[lang=en]").textContent=== "")'),'voice entry')
   // Let the offscreen compositor publish the newly mounted shadow controls
   // before a trusted coordinate click, just as a visible frame would do.
   await wait(150)
   const coordinate=await isolated('(()=>{const root=__voiceFixtureRoots.filter(root=>root.host.isConnected).at(-1),r=root.querySelector("button").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
   window.webContents.sendInputEvent({type:'mouseMove',...coordinate})
   window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...coordinate});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...coordinate})
   await until(()=>isolated('__voiceFixtureRoots.filter(root=>root.host.isConnected).at(-1)?.querySelector("[lang=zh-CN]")?.textContent==="这是合成语音。"'),'bilingual voice result')
   assert.equal(await page('nativeClicks'),lazy?3:1);assert.equal(await page('lastAudio.paused'),true)
   assert.equal(await page('document.querySelectorAll("[data-hellodog-audio-request],[data-hellodog-audio-control],input[type=file]").length'),0)
   assert.equal(await isolated('__voiceFixtureRoots.filter(root=>root.host.isConnected).at(-1).querySelector("[lang=en]").textContent'),'Hello from synthetic voice.')
   checks.push((lazy?'first asynchronous load':'ready detached media')+' crosses real isolated preload, webFrame main world, ArrayBuffer return and private PCM IPC')
  }
  assert.equal(calls.length,2);assert.notEqual(calls[0].messageId,calls[1].messageId);assert.deepEqual(errors,[])
  writeFileSync(join(folder,'electron-audio-results.json'),JSON.stringify({passed:true,syntheticOnly:true,cloudCalls:0,realAccountsAccessed:false,realMessagesSent:false,profile,checks,calls,limitations:['Synthetic main-world players use the observed official-control pattern; real current accounts were unavailable.','The first asynchronous load can briefly play the selected original until its own Pause control is observed; this fixture mutes synthetic tones.']},null,2))
  console.log(JSON.stringify({passed:true,checks:checks.length,voiceCalls:calls.length}));app.quit()
 }catch(error){const diagnostic=window&&!window.isDestroyed()?await isolated('({panels:__voiceFixtureRoots.map(root=>root.textContent),bridgeError:globalThis.__voiceFixtureBridgeError})').catch(()=>null):null;writeFileSync(join(folder,'electron-audio-results.json'),JSON.stringify({passed:false,error:String(error.stack||error),errors,calls,profile,diagnostic},null,2));console.error(error);app.exit(1)}
})
