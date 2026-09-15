import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
import {voiceMediaBundle} from './voice-browser-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright'),h=mainHarness()
const {whatsappVoiceScript}=h.load('src/main/platforms/whatsapp/inject/voiceMessages.ts'),{voiceAudioWav}=h.load('src/shared/voiceAudio.ts')
const bundle=await voiceMediaBundle(),directory=fileURLToPath(new URL('../verification/translation-stability-20260916/voice/',import.meta.url));await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[]
async function prepare(page,html){
 await page.route('**/*',route=>route.abort());page.on('pageerror',error=>errors.push(error.message));await page.setContent(html)
 await page.evaluate(()=>{
  window.__read=[];window.__recognitions=[];window.__translations=[];window.__decodeHold=false;window.__recognizeHold=false;window.__translateHold=false;window.__duration=.15;window.__closed=0
  HTMLMediaElement.prototype.play=function(){return Promise.resolve()}
  window.fetch=async url=>{window.__read.push(String(url));return new Response(new Uint8Array([1,2,3]),{status:200})}
  window.AudioContext=class{async decodeAudioData(){if(window.__decodeHold)await new Promise(resolve=>window.__finishDecode=resolve);return{duration:window.__duration}}async close(){window.__closed++}}
  window.OfflineAudioContext=class{constructor(channels,count,rate){this.count=count;this.destination={}}createBufferSource(){return{connect(){},start(){}}}async startRendering(){const samples=new Float32Array(this.count);for(let i=0;i<this.count;i++)samples[i]=i%4===0?NaN:Math.sin(i/10)*1.2;return{getChannelData:()=>samples}}}
  window.__recognize=async(...args)=>{window.__recognitions.push(args);if(window.__recognizeHold)return new Promise(resolve=>window.__finishRecognize=resolve);return{text:'I will call tomorrow.',audioId:'a'.repeat(64)}}
  window.__translate=async(...args)=>{window.__translations.push(args);if(window.__translateHold)return new Promise(resolve=>window.__finishTranslate=resolve);return '我明天打电话。'}
  window.realtimeTranslator={recognizeVoice:window.__recognize,translateIncoming:window.__translate}
  window.desktopAPI={signalMediaUrl:async()=> 'hellodog-media://authorized/attachment',recognizeVoice:window.__recognize,translateVoice:window.__translate}
  window.IntersectionObserver=class{constructor(callback){this.callback=callback}observe(){this.callback([{isIntersecting:true}])}disconnect(){}}
 })
}
try{
 const page=await browser.newPage({viewport:{width:780,height:750}})
 await prepare(page,'<div id="main"><header><span data-rt-ui="contact-details" title="Wrong note title"></span><span title="Alex" dir="auto">Alex</span></header><div id="a" class="message-in" data-id="false_123@c.us_one"><button data-icon="audio-play">Play A</button><audio src="blob:https://web.whatsapp.com/owned-a"></audio></div><div id="b" class="message-in" data-id="false_123@c.us_two"><button data-icon="audio-play">Play B</button><button id="menu">Menu</button></div></div><audio id="external" src="blob:https://web.whatsapp.com/unrelated"></audio>')
 await page.addScriptTag({content:whatsappVoiceScript});assert.equal(await page.locator('.rt-voice-translation').count(),2);assert.equal(await page.evaluate(()=>window.__recognitions.length),0)
 await page.locator('#menu').click();await page.evaluate(()=>document.querySelector('#external').play());await page.locator('#b').getByRole('button',{name:'翻译语音',exact:true}).click()
 await page.locator('#b [role=status]').filter({hasText:'语音文件翻译'}).waitFor();assert.equal(await page.evaluate(()=>window.__read.length),0)
 checks.push('Unrelated global audio never attaches to a recently clicked message; no native media prototype override')
 await page.locator('#a').getByRole('button',{name:'翻译语音',exact:true}).click();await page.locator('#a textarea').waitFor()
 assert.deepEqual(await page.evaluate(()=>window.__read),['blob:https://web.whatsapp.com/owned-a']);assert.equal(await page.evaluate(()=>window.__translations.length),0)
 await page.locator('#a textarea').fill('I will call you tomorrow.');await page.evaluate(()=>{window.__translateHold=true})
 await page.locator('#a').getByRole('button',{name:'确认并翻译',exact:true}).click();await page.evaluate(()=>document.querySelector('#a [data-voice-review] button').click())
 assert.equal(await page.evaluate(()=>window.__translations.length),1);const request=await page.evaluate(()=>window.__translations[0][0]);assert.equal(request.text,'I will call you tomorrow.');assert.equal(request.messageId,'voice:false_123@c.us_one');assert.equal(request.conversationId,'wa:alex');assert.equal(request.conversationName,'Alex');assert.equal(request.outgoing,false);assert.equal(request.manual,true)
 await page.evaluate(()=>window.__finishTranslate('我明天给你打电话。'));await page.locator('#a').getByText('语音翻译完成',{exact:true}).waitFor();await page.screenshot({path:directory+'/whatsapp-reviewed-voice.png'})
 checks.push('Local recognition needs user confirmation before translation, uses corrected text and coalesces clicks while pending')
 await page.evaluate(()=>{window.__recognizeHold=true;document.querySelector('#a').setAttribute('data-id','false_123@c.us_three')});await page.waitForTimeout(240)
 assert.equal(await page.locator('#a textarea').count(),0);await page.locator('#a').getByRole('button',{name:'翻译语音',exact:true}).click();await page.waitForFunction(()=>typeof window.__finishRecognize==='function')
 await page.evaluate(()=>{document.querySelector('#main').innerHTML='<div class="message-in" data-id="false_456@c.us_new"><button data-icon="audio-play">New message</button></div>';window.__finishRecognize({text:'Private previous message'})});await page.waitForTimeout(240)
 assert.equal(await page.locator('textarea').count(),0);assert.doesNotMatch(await page.textContent('body'),/Private previous message/)
 checks.push('Reused virtual message IDs discard old review, and late recognition never appears in another conversation')
 await page.addScriptTag({content:'window.__decode='+voiceAudioWav.toString()})
 const validation=await page.evaluate(async()=>{
  const read=window.__read.length;let denied=0;for(const url of ['https://evil.invalid/audio','file:///D:/private.wav','data:audio/wav;base64,AA','javascript:alert(1)'])try{await window.__decode(url)}catch{denied++}
  const noRead=window.__read.length===read;const bytes=await window.__decode('blob:https://web.whatsapp.com/synthetic'),view=new DataView(bytes.buffer)
  window.__duration=301;let oversize=false;try{await window.__decode('blob:https://web.whatsapp.com/long')}catch{oversize=true}
  return{denied,noRead,channels:view.getUint16(22,true),rate:view.getUint32(24,true),length:bytes.length,oversize,closed:window.__closed}
 });assert.equal(validation.denied,4);assert.equal(validation.noRead,true);assert.equal(validation.channels,1);assert.equal(validation.rate,16000);assert.equal(validation.length,4844);assert.equal(validation.oversize,true)
 checks.push('Renderer decoder rejects remote/local paths before fetching and emits bounded canonical PCM, closing audio contexts')
 const signal=await browser.newPage({viewport:{width:600,height:800}});await prepare(signal,'<div id="app"></div>');await signal.addScriptTag({content:bundle});await signal.getByRole('button',{name:'翻译语音',exact:true}).click();await signal.getByRole('textbox',{name:'语音识别文字'}).waitFor()
 await signal.getByRole('textbox',{name:'语音识别文字'}).fill('Hello from Signal.');await signal.getByRole('button',{name:'确认并翻译',exact:true}).click();await signal.locator('.voice-output').waitFor()
 let signalCall=await signal.evaluate(()=>window.__translations[0]);assert.equal(signalCall[0],'fixture-signal');assert.equal(signalCall[1],'+12025550123');assert.equal(signalCall[2],'voice:["+12025550123","attachment",100]')
 await signal.evaluate(()=>window.__setProps({timestamp:101}));await signal.getByRole('textbox',{name:'语音识别文字'}).waitFor({state:'detached'});assert.equal(await signal.locator('.voice-output').count(),0)
 await signal.evaluate(()=>window.__recognizeHold=true);await signal.getByRole('button',{name:'翻译语音',exact:true}).click();await signal.waitForFunction(()=>typeof window.__finishRecognize==='function')
 await signal.evaluate(()=>{window.__setProps({peer:'+12025550456',timestamp:102})});await signal.waitForTimeout(20);await signal.evaluate(()=>window.__finishRecognize({text:'Old peer audio'}));await signal.waitForTimeout(40)
 assert.equal(await signal.getByRole('textbox',{name:'语音识别文字'}).count(),0);assert.doesNotMatch(await signal.textContent('body'),/Old peer audio/)
 await signal.evaluate(()=>window.__recognizeHold=false);await signal.getByRole('button',{name:'翻译语音',exact:true}).click();await signal.getByRole('textbox',{name:'语音识别文字'}).waitFor();await signal.getByRole('button',{name:'确认并翻译',exact:true}).click();await signal.locator('.voice-output').waitFor()
 signalCall=await signal.evaluate(()=>window.__translations.at(-1));assert.equal(signalCall[2],'voice:["+12025550456","attachment",102]');await signal.screenshot({path:directory+'/signal-compatible-reviewed-voice.png'})
 checks.push('Compatible Signal audio identities include peer and timestamp, reject late old-peer results, and require explicit translation')
 assert.deepEqual(errors,[])
 const result={passed:true,at:new Date().toISOString(),checks,pageErrors:errors,syntheticAudio:true,nativeRecognitionMocked:true,network:'blocked except synthetic media fetch',realMessagesSent:0,limitations:['Direct WhatsApp voice requires an audio element with the exact message ID; unowned external players use explicit file selection.','Signal bubble controls validated only for compatible mode; native Signal uses file workflow.','Recognition accuracy on actual voice was verified separately by root; this fixture checks routing, permissions and safe state.']}
 await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close();rmSync(h.directory,{recursive:true,force:true})}
