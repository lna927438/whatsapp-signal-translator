import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,writeFile} from 'node:fs/promises'
import {rmSync} from 'node:fs'
import {relative,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {mainHarness} from './main-harness.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const modules=mainHarness(),{whatsappVoiceScript}=modules.load('src/main/platforms/whatsapp/inject/voiceMessages.ts')
const folder=fileURLToPath(new URL('../verification/voice-whatsapp-20260928/',import.meta.url));await mkdir(folder,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],checks=[]
try{
 const page=await browser.newPage({viewport:{width:820,height:720}});page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
 await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#10181c;color:#e9edef;font:14px system-ui}#shell{display:flex;height:100vh}#side{width:140px;background:#182429;padding:22px}#main{flex:1;min-width:0}header{background:#202c33;padding:22px}.history{padding:26px}.message-in,.message-out{padding:14px 18px;margin-bottom:24px;border-radius:12px;max-width:390px;background:#202c33}.message-out{margin-left:auto;background:#075e54}audio{max-width:100%;height:38px}summary{color:#b9ccc7}.label{font-size:12px;color:#b3c2bd;margin-bottom:10px}button{font:inherit}#side button{padding:8px;background:#344a51;border:0;color:white;border-radius:7px}</style><div id="shell"><aside id="side"><p>HelloDog</p><button>其他会话</button></aside><div id="main"><header><span title="合成测试会话" dir="auto">合成测试会话</span></header><div class="history"><div id="received" class="message-in" data-id="false_123@c.us_received"><div class="label">收到的语音 · 合成测试</div><audio controls></audio></div><div id="sent" class="message-out" data-id="true_123@c.us_sent"><div class="label">发出的语音 · 合成测试</div><button data-icon="audio-play">播放</button></div></div></div></div>`)
 await page.evaluate(()=>{
  const count=4000,bytes=new Uint8Array(44+count*2),v=new DataView(bytes.buffer),label=(at,text)=>{for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i)}
  label(0,'RIFF');label(8,'WAVE');label(12,'fmt ');label(36,'data');v.setUint32(4,bytes.length-8,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/20)*8000),true)
  window.__url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));document.querySelector('#received audio').src=window.__url
  const fetchOriginal=window.fetch;window.__reads=[];window.fetch=(url,options)=>{window.__reads.push(String(url));return fetchOriginal(url,options)}
  window.__requests=[];window.__hold=false;window.__failed=false
  window.realtimeTranslator={translateVoiceMessage:async payload=>{window.__requests.push({messageId:payload.messageId,conversationId:payload.conversationId,bytes:payload.bytes.length,channels:new DataView(payload.bytes.buffer).getUint16(22,true),rate:new DataView(payload.bytes.buffer).getUint32(24,true)});if(window.__hold)return new Promise(resolve=>window.__finish=resolve);if(window.__failed)throw Error('语音识别暂时繁忙，请重试。');return{text:'Please call me tomorrow morning.',translation:'请明天上午给我打电话。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}}}
 })
 await page.addScriptTag({content:whatsappVoiceScript});assert.equal(await page.locator('.rt-voice-translation').count(),2);assert.equal(await page.evaluate(()=>window.__requests.length),0)
 await page.locator('#sent').getByRole('button',{name:'转为中文',exact:true}).click();await page.locator('#sent [role=status]').filter({hasText:'设置 → 语音翻译'}).waitFor();assert.equal(await page.evaluate(()=>window.__requests.length),0)
 checks.push('No owned player fails visibly without decoding or invoking recognition/translation; file-tool location is current')
 await page.locator('#received').getByRole('button',{name:'转为中文',exact:true}).click();await page.locator('#received [data-voice-translation]').waitFor({state:'visible'})
 assert.deepEqual(await page.evaluate(()=>window.__requests),[{messageId:'voice:false_123@c.us_received',conversationId:'peer:123@c.us',bytes:8044,channels:1,rate:16000}])
 assert.equal(await page.locator('#received details').evaluate(node=>node.open),false);assert.equal(await page.locator('#received audio').evaluate(audio=>audio.paused),true)
 assert.equal(await page.locator('#received [data-voice-translation]').textContent(),'请明天上午给我打电话。')
 await page.screenshot({path:folder+'one-click-chinese.png'})
 checks.push('Real Chromium decodes an in-memory WAV to canonical PCM; one click shows Chinese with original transcript folded and audio unplayed')
 await page.evaluate(()=>{const node=document.createElement('audio');node.src=window.__url;node.controls=true;document.querySelector('#sent').append(node);window.__failed=true})
 await page.locator('#sent').getByRole('button',{name:'重试转中文',exact:true}).click();await page.locator('#sent [role=status]').filter({hasText:'暂时繁忙'}).waitFor();await page.evaluate(()=>{window.__failed=false})
 await page.locator('#sent').getByRole('button',{name:'重试转中文',exact:true}).click();await page.locator('#sent [data-voice-translation]').waitFor({state:'visible'})
 const retry=await page.evaluate(()=>window.__requests.slice(-2));assert.deepEqual(retry[0],retry[1]);assert.equal(retry[1].messageId,'voice:true_123@c.us_sent')
 checks.push('An explicit retry preserves outgoing voice identity and the exact PCM characteristics')
 await page.evaluate(()=>{document.querySelector('#received').dataset.id='false_123@c.us_new';document.querySelector('#received audio').src=URL.createObjectURL(new Blob([new Uint8Array([1])]))})
 await page.waitForTimeout(150)
 // Restore a valid synthetic source under the replacement message, then hold the reply.
 await page.evaluate(()=>{document.querySelector('#received audio').src=window.__url;window.__hold=true})
 await page.locator('#received').getByRole('button',{name:'转为中文',exact:true}).click();await page.waitForFunction(()=>typeof window.__finish==='function')
 const before=await page.evaluate(()=>window.__requests.length);await page.evaluate(()=>document.querySelector('#received .rt-voice-translation button').click());assert.equal(await page.evaluate(()=>window.__requests.length),before)
 await page.locator('#side button').click();await page.evaluate(()=>window.__finish({text:'Old conversation transcript',translation:'不应显示的旧结果',audioId:'b'.repeat(64),targetLanguage:'zh-CN'}));await page.waitForTimeout(50)
 assert.equal(await page.locator('#received [data-voice-translation]').isVisible(),false);assert.doesNotMatch(await page.textContent('body'),/不应显示的旧结果|Old conversation transcript/);assert.equal(await page.locator('#received .rt-voice-translation button').isEnabled(),true)
 checks.push('Duplicate clicks do not start parallel work; navigation invalidates late reply and restores the retry control')
 assert.deepEqual(errors,[])
 const proof={passed:true,at:new Date().toISOString(),checks,pageErrors:errors,syntheticAudio:true,realBrowserAudioDecode:true,recognitionAndTranslationMocked:true,realMessagesRead:0,realMessagesSent:0,cloudRequests:0,limitations:['This fixture validates DOM ownership, real audio decoding, UI and navigation; it does not measure speech-recognition accuracy.','WhatsApp external players without a durable message ID remain unsupported and use explicit file selection.']}
 await writeFile(folder+'browser-results.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof))
}finally{await browser.close();assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(modules.directory,{recursive:true,force:true})}
