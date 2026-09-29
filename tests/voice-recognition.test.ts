import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {mainHarness} from './main-harness.ts'

function wav(seconds=.15,amplitude=.2){
 const bytes=new Uint8Array(44+Math.round(seconds*16000)*2),view=new DataView(bytes.buffer)
 for(const [at,label] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const)for(let i=0;i<label.length;i++)bytes[at+i]=label.charCodeAt(i)
 view.setUint32(4,bytes.length-8,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,bytes.length-44,true)
 for(let i=44;i<bytes.length;i+=2)view.setInt16(i,Math.round(Math.sin(i/10)*32767*amplitude),true)
 return bytes
}
function safeRemove(directory:string){assert.match(relative(resolve(process.env.TEMP||''),resolve(directory)),/^hellodog-test-[a-zA-Z0-9]+$/);rmSync(directory,{recursive:true,force:true})}
function fixture(){
 const manifest={executable:'whisper-cli.exe',model:'ggml-base.bin',files:{'whisper-cli.exe':createHash('sha256').update('test-executable').digest('hex'),'ggml-base.bin':createHash('sha256').update('test-model').digest('hex')}},calls:any[]=[],children:any[]=[]
 let mode='success',holdRead=false,readingResult=false,finishRead:()=>void=()=>{},holdWrite=false,writing=false,finishWrite:()=>void=()=>{},holdCleanup=false,cleaning=false,finishCleanup:()=>void=()=>{}
 const h=mainHarness(undefined,undefined,{'../../../resources/voice/manifest.json':{default:manifest},'fs/promises':{...fsPromises,readFile:async(...args:any[])=>{
  const result=await (fsPromises.readFile as any)(...args)
  if(holdRead&&String(args[0]).endsWith('result.json')){readingResult=true;await new Promise<void>(resolve=>finishRead=resolve)}return result
 },writeFile:async(...args:any[])=>{
  await (fsPromises.writeFile as any)(...args)
  if(holdWrite){writing=true;await new Promise<void>(resolve=>finishWrite=resolve)}
 },rm:async(...args:any[])=>{
  if(holdCleanup){cleaning=true;await new Promise<void>(resolve=>finishCleanup=resolve)}
  await (fsPromises.rm as any)(...args)
 }},child_process:{spawn:(command:string,args:string[],options:any)=>{
  calls.push({command,args,options});const child:any=new EventEmitter();children.push(child);child.kill=()=>{child.killed=true;setImmediate(()=>child.emit('close',null));return true}
  const output=args[args.indexOf('-of')+1]
  if(mode!=='hold')setImmediate(()=>{if(mode==='error')child.emit('error',Error('sensitive native error must not escape'));else{writeFileSync(output+'.json',JSON.stringify({transcription:[{text:mode==='silence'?'[BLANK_AUDIO]':'Hello from a local fixture.'}]}));child.emit('close',0)}})
  return child
 }}}),resources=join(h.directory,'bin'),temporary=join(h.directory,'temporary')
 mkdirSync(resources);writeFileSync(join(resources,manifest.executable),'test-executable');writeFileSync(join(resources,manifest.model),'test-model')
 const {VoiceRecognition,voiceTranscript}=h.load('src/main/translation/voiceRecognition.ts'),{validateVoiceWav}=h.load('src/shared/voiceAudio.ts')
 return{...h,resources,temporary,voice:new VoiceRecognition(resources,temporary),voiceTranscript,validateVoiceWav,calls,children,setMode:(value:string)=>{mode=value},holdRead:()=>holdRead=true,get readingResult(){return readingResult},finishRead:()=>finishRead(),holdWrite:()=>holdWrite=true,get writing(){return writing},finishWrite:()=>finishWrite(),holdCleanup:()=>holdCleanup=true,get cleaning(){return cleaning},finishCleanup:()=>finishCleanup(),close:()=>safeRemove(h.directory)}
}
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),'fixture operation started')}

test('voice PCM accepts only bounded canonical mono 16k signed PCM and copies renderer input',()=>{
 const h=fixture();try{
  const input=wav(),copy=h.validateVoiceWav(input);assert.deepEqual(copy,input);input[44]^=255;assert.notEqual(copy[44],input[44])
  for(const offset of [0,4,8,12,16,20,22,24,28,32,34,36,40]){const invalid=wav();invalid[offset]^=1;assert.throws(()=>h.validateVoiceWav(invalid),/格式校验/)}
  for(const invalid of [null,[1,2],new Uint8Array(3200),wav(300.01),wav(.15,0),wav(.15,.0001)])assert.throws(()=>h.validateVoiceWav(invalid))
  assert.equal(h.calls.length,0)
 }finally{h.close()}
})
test('voice transcripts reject silence, malformed and oversized results without leaking native output',()=>{
 const h=fixture();try{
  assert.equal(h.voiceTranscript({transcription:[{text:' Hello'},{text:' world.'}]}),'Hello world.')
  for(const invalid of [null,{}, {transcription:'text'},{transcription:Array(2001).fill({text:'ok'})},{transcription:[{text:'[BLANK_AUDIO] [silence] 123'}]},{transcription:[{text:'a'.repeat(12001)}]}])assert.throws(()=>h.voiceTranscript(invalid))
 }finally{h.close()}
})
test('local recognition verifies components, uses a hidden shell-free process and removes audio/result on success',async()=>{
 const h=fixture();try{
  assert.equal(await h.voice.recognize(wav(),()=>true),'Hello from a local fixture.')
  assert.equal(h.calls.length,1);const call=h.calls[0];assert.equal(call.command,join(h.resources,'whisper-cli.exe'));assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.stdio,'ignore');assert.equal(call.options.cwd,h.resources)
  assert.ok(call.args.includes('-ng'));assert.equal(call.args[call.args.indexOf('-l')+1],'auto');assert.equal(call.args[call.args.indexOf('-t')+1],'2')
  assert.deepEqual(readdirSync(h.temporary),[])
 }finally{h.close()}
})
test('recognition denies logged-out or invalid audio without launching a subprocess',async()=>{
 const h=fixture();try{await assert.rejects(h.voice.recognize(wav(),()=>false),/登录/);await assert.rejects(h.voice.recognize(wav(.15,0),()=>true),/人声|听见/);assert.equal(h.calls.length,0)}finally{h.close()}
})
test('manifest tampering and unlisted native DLLs fail before execution; a repaired directory recovers',async()=>{
 const h=fixture();try{
  writeFileSync(join(h.resources,'whisper-cli.exe'),'modified');await assert.rejects(h.voice.recognize(wav(),()=>true),/校验失败/);assert.equal(h.calls.length,0)
  writeFileSync(join(h.resources,'whisper-cli.exe'),'test-executable');writeFileSync(join(h.resources,'unexpected.dll'),'not trusted');await assert.rejects(h.voice.recognize(wav(),()=>true),/未通过验证/);assert.equal(h.calls.length,0)
  rmSync(join(h.resources,'unexpected.dll'));assert.equal(await h.voice.recognize(wav(),()=>true),'Hello from a local fixture.')
 }finally{h.close()}
})
test('components are reverified for every job, including DLLs added after an earlier successful recognition',async()=>{
 const h=fixture();try{
  await h.voice.recognize(wav(),()=>true);writeFileSync(join(h.resources,'whisper-cli.exe'),'modified after validation')
  await assert.rejects(h.voice.recognize(wav(),()=>true),/校验失败/);assert.equal(h.calls.length,1)
  writeFileSync(join(h.resources,'whisper-cli.exe'),'test-executable');writeFileSync(join(h.resources,'added.dll'),'new untrusted dll')
  await assert.rejects(h.voice.recognize(wav(),()=>true),/未通过验证/);assert.equal(h.calls.length,1)
 }finally{h.close()}
})
test('only one native job runs; an account change kills it, removes temporary audio and releases the next job',async()=>{
 const h=fixture();let authorized=true
 try{
  h.setMode('hold');const pending=h.voice.recognize(wav(),()=>authorized),rejected=assert.rejects(pending,/登录状态已变化/);await until(()=>h.calls.length===1)
  await assert.rejects(h.voice.recognize(wav(),()=>true),/上一条语音/);authorized=false;await rejected;assert.equal(h.children[0].killed,true);assert.deepEqual(readdirSync(h.temporary),[])
  h.setMode('success');assert.equal(await h.voice.recognize(wav(),()=>true),'Hello from a local fixture.');assert.equal(h.calls.length,2)
 }finally{h.close()}
})
test('native failure and inaudible result both clean temporary files and allow the next voice',async()=>{
 const h=fixture();try{
  h.setMode('error');await assert.rejects(h.voice.recognize(wav(),()=>true),/无法启动语音组件/);assert.deepEqual(readdirSync(h.temporary),[])
  h.setMode('silence');await assert.rejects(h.voice.recognize(wav(),()=>true),/清晰的人声/);assert.deepEqual(readdirSync(h.temporary),[])
  h.setMode('success');await h.voice.recognize(wav(),()=>true);assert.equal(h.calls.length,3)
 }finally{h.close()}
})
test('an owner change during final asynchronous result reading cannot return the prior owner transcript',async()=>{
 const h=fixture();let authorized=true
 try{
  h.holdRead();const pending=h.voice.recognize(wav(),()=>authorized),rejected=assert.rejects(pending,/登录状态已变化/)
  await until(()=>h.readingResult);authorized=false;h.finishRead();await rejected;assert.deepEqual(readdirSync(h.temporary),[])
 }finally{h.close()}
})
test('native timeout terminates the job, removes audio and releases the busy state',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout','setInterval']});const h=fixture()
 try{
  h.setMode('hold');const pending=h.voice.recognize(wav(),()=>true),rejected=assert.rejects(pending,/超时/)
  while(!h.calls.length)await new Promise(resolve=>setImmediate(resolve))
  context.mock.timers.tick(180001);await rejected;assert.equal(h.children[0].killed,true);assert.deepEqual(readdirSync(h.temporary),[])
  h.setMode('success');await h.voice.recognize(wav(),()=>true);assert.equal(h.calls.length,2)
 }finally{context.mock.timers.reset();h.close()}
})

test('final disposal kills the native child synchronously and waits for temporary cleanup before allowing exit',async()=>{
 const h=fixture()
 try{
  h.setMode('hold');h.holdCleanup()
  const pending=h.voice.recognize(wav(),()=>true),rejected=assert.rejects(pending,/登录状态已变化/)
  await until(()=>h.calls.length===1);assert.equal(h.voice.busy,true)
  const stopped=h.voice.dispose();let completed=false;void stopped.then(()=>{completed=true})
  assert.equal(h.children[0].killed,true,'do not wait for the 250ms authorization poll')
  assert.equal(h.voice.dispose(),stopped,'repeated shutdown shares one completion')
  await until(()=>h.cleaning);assert.equal(completed,false);assert.equal(h.voice.busy,true);assert.equal(readdirSync(h.temporary).length,1)
  h.finishCleanup();await stopped;await rejected
  assert.equal(completed,true);assert.equal(h.voice.busy,false);assert.deepEqual(readdirSync(h.temporary),[])
  await assert.rejects(h.voice.recognize(wav(),()=>true),/已关闭/);assert.equal(h.calls.length,1)
 }finally{h.finishCleanup();h.close()}
})

test('disposal during asynchronous WAV creation cleans it and never starts a child afterward',async()=>{
 const h=fixture()
 try{
  h.holdWrite();const pending=h.voice.recognize(wav(),()=>true),rejected=assert.rejects(pending,/登录状态已变化/)
  await until(()=>h.writing);const stopped=h.voice.dispose();h.finishWrite();await stopped;await rejected
  assert.equal(h.calls.length,0);assert.deepEqual(readdirSync(h.temporary),[]);assert.equal(h.voice.busy,false)
 }finally{h.finishWrite();h.close()}
})

test('disposal during final result reading cannot return the transcript and still waits for cleanup',async()=>{
 const h=fixture()
 try{
  h.holdRead();const pending=h.voice.recognize(wav(),()=>true),rejected=assert.rejects(pending,/登录状态已变化/)
  await until(()=>h.readingResult);const stopped=h.voice.dispose();h.finishRead();await stopped;await rejected
  assert.deepEqual(readdirSync(h.temporary),[]);assert.equal(h.voice.busy,false)
 }finally{h.finishRead();h.close()}
})
