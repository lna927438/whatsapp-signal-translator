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
const folder=fileURLToPath(new URL('../verification/voice-direct-20261013/whatsapp/',import.meta.url));await mkdir(folder,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],checks=[]
try{
 const page=await browser.newPage({viewport:{width:820,height:900}});let filePickers=0;page.on('filechooser',()=>{filePickers++});page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
 await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#10181c;color:#e9edef;font:14px system-ui}#shell{display:flex;height:100vh}#side{width:140px;background:#182429;padding:22px}#main{flex:1;min-width:0}header{background:#202c33;padding:22px}.history{padding:26px}.message-in,.message-out{padding:14px 18px;margin-bottom:24px;border-radius:12px;max-width:390px;background:#202c33}.message-out{margin-left:auto;background:#075e54}audio{max-width:100%;height:38px}summary{color:#b9ccc7}.label{font-size:12px;color:#b3c2bd;margin-bottom:10px}button{font:inherit}#side button{padding:8px;background:#344a51;border:0;color:white;border-radius:7px}</style><div id="shell"><aside id="side"><p>HelloDog</p><button>其他会话</button></aside><div id="main"><header><span title="合成测试会话" dir="auto">合成测试会话</span></header><div class="history"><div id="received" class="message-in" data-id="false_123@c.us_received"><div class="label">收到的语音 · 合成测试</div><audio controls></audio></div><div id="sent" class="message-out" data-id="true_123@c.us_sent"><div class="label">发出的语音 · 合成测试</div><button data-icon="audio-play">播放</button></div></div></div></div>`)
 await page.evaluate(()=>{
  const count=4000,bytes=new Uint8Array(44+count*2),v=new DataView(bytes.buffer),label=(at,text)=>{for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i)}
  label(0,'RIFF');label(8,'WAVE');label(12,'fmt ');label(36,'data');v.setUint32(4,bytes.length-8,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/20)*8000),true)
  window.__wav=Array.from(bytes);window.__url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));document.querySelector('#received audio').src=window.__url
  const fetchOriginal=window.fetch;window.__reads=[];window.fetch=(url,options)=>{window.__reads.push(String(url));return fetchOriginal(url,options)}
  window.__requests=[];window.__hold=false;window.__failed=false
  window.realtimeTranslator={translateVoiceMessage:async payload=>{window.__requests.push({messageId:payload.messageId,conversationId:payload.conversationId,bytes:payload.bytes.length,channels:new DataView(payload.bytes.buffer).getUint16(22,true),rate:new DataView(payload.bytes.buffer).getUint32(24,true)});if(window.__hold)return new Promise(resolve=>window.__finish=resolve);if(window.__failed)throw Error('语音识别暂时繁忙，请重试。');return{text:'Please call me tomorrow morning.',englishTranslation:'Please call me tomorrow morning.',translation:'请明天上午给我打电话。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}}}
 })
 await page.addScriptTag({content:whatsappVoiceScript});assert.equal(await page.locator('.rt-voice-translation').count(),2);assert.equal(await page.evaluate(()=>window.__requests.length),0)
 await page.locator('#sent').getByRole('button',{name:'转为中文',exact:true}).click();await page.locator('#sent [role=status]').filter({hasText:'无法读取这条语音'}).waitFor();assert.equal(await page.evaluate(()=>window.__requests.length),0);assert.equal(filePickers,0)
 checks.push('Missing owned model or audio gives an in-bubble retry without a file picker, decoding or billing')
 await page.locator('#received').getByRole('button',{name:'转为中文',exact:true}).click();await page.locator('#received [data-voice-translation]').waitFor({state:'visible'})
 assert.deepEqual(await page.evaluate(()=>window.__requests),[{messageId:'voice:false_123@c.us_received',conversationId:'peer:123@c.us',bytes:8044,channels:1,rate:16000}])
 assert.equal(await page.locator('#received details').evaluate(node=>node.open),false);assert.equal(await page.locator('#received audio').evaluate(audio=>audio.paused),true)
 assert.equal(await page.locator('#received [data-voice-translation]').textContent(),'请明天上午给我打电话。')
 assert.equal(await page.locator('#received [data-voice-english]').textContent(),'Please call me tomorrow morning.')
 checks.push('Real Chromium decodes an in-memory WAV to canonical PCM; one click shows English and Chinese with audio unplayed')
 await page.evaluate(()=>{
  window.__models=new Map();window.__downloads=[];window.__model=(id,shortId,lazy=false)=>{
   const blob=new Blob([new Uint8Array(window.__wav)],{type:'audio/wav'}),model={id:{_serialized:id,id:shortId},type:'ptt',filehash:'synthetic-'+id,mediaData:{}};
   const cached=()=>{model.mediaData.mediaBlob={forceToBlob:()=>blob}};
   model.downloadMedia=async options=>{window.__downloads.push({id,options});await new Promise(resolve=>setTimeout(resolve,30));cached()};if(!lazy)cached();window.__models.set(id,model);return model;
  };
  window.require=name=>name==='WAWebCollections'?{Msg:{get:id=>window.__models.get(id)}}:undefined;
  document.querySelector('.history').insertAdjacentHTML('beforeend','<div id="file" data-id="3EB0000000000000000001" style="margin-bottom:24px"><div class="message-in" style="background:transparent;padding:0"><div class="painted" style="display:flex;background:#f7faf8;color:#173026;border-radius:10px;max-width:390px"><div class="audio-controls" style="display:flex;align-items:center;width:100%;padding:14px;box-sizing:border-box"><div role="button" id="lazy" style="flex:1">▶ 0:18</div><span aria-hidden="true">●</span></div></div></div></div>');
  document.querySelector('#file').__reactProps$fixture={message:window.__model('false_123@c.us_3EB0000000000000000001','3EB0000000000000000001')};
 });
 assert.equal(await page.locator('#file .rt-voice-translation').count(),0);await page.locator('#lazy').evaluate(node=>node.setAttribute('aria-label','Play voice note'));await page.locator('#file .rt-voice-translation').waitFor()
 await page.locator('#file').getByRole('button',{name:'转为中文',exact:true}).click();await page.locator('#file [data-voice-translation]').waitFor({state:'visible'})
 const selected=await page.evaluate(()=>window.__requests.at(-1));assert.deepEqual(selected,{messageId:'voice:whatsapp-message:3EB0000000000000000001',conversationId:'whatsapp-message:3EB0000000000000000001',bytes:8044,channels:1,rate:16000})
 assert.equal(await page.locator('#file .painted > .rt-voice-translation').count(),1);assert.equal(await page.locator('#file [lang=en]').isVisible(),true);assert.equal(await page.locator('#file [lang=zh-CN]').isVisible(),true);assert.equal(filePickers,0)
 await page.locator('#file .rt-voice-translation').evaluate(node=>window.__originalBox=node);await page.locator('#lazy').evaluate(node=>node.setAttribute('aria-label','Pause voice note'));await page.waitForTimeout(150);assert.equal(await page.locator('#file .rt-voice-translation').evaluate(node=>node===window.__originalBox),true)
 for(const width of [390,820,1200]){
  await page.setViewportSize({width,height:900});const layout=await page.evaluate(()=>{const bubble=document.querySelector('#file .painted').getBoundingClientRect(),controls=document.querySelector('#file .audio-controls').getBoundingClientRect(),box=document.querySelector('#file .rt-voice-translation').getBoundingClientRect();return{inside:box.left>=bubble.left-1&&box.right<=bubble.right+1&&box.bottom<=bubble.bottom+1,below:box.top>=controls.bottom-1}});assert.equal(layout.inside,true,'inside painted bubble at '+width);assert.equal(layout.below,true,'below native audio controls at '+width);await page.screenshot({path:folder+'voice-bilingual-in-bubble-'+width+'.png',fullPage:true})
 }
 await page.setViewportSize({width:820,height:900});checks.push('Opaque row-bound message cache decodes directly and keeps both translations below controls inside the painted flex bubble at 390, 820 and 1200 pixel widths')
 await page.evaluate(()=>{window.__model('true_123@c.us_sent','sent',true);window.__failed=true})
 await page.locator('#sent').getByRole('button',{name:'重试转中文',exact:true}).click();await page.locator('#sent [role=status]').filter({hasText:'暂时繁忙'}).waitFor();await page.evaluate(()=>{window.__failed=false})
 await page.locator('#sent').getByRole('button',{name:'重试转中文',exact:true}).click();await page.locator('#sent [data-voice-translation]').waitFor({state:'visible'})
 const retry=await page.evaluate(()=>window.__requests.slice(-2));assert.deepEqual(retry[0],retry[1]);assert.equal(retry[1].messageId,'voice:true_123@c.us_sent')
 assert.equal(await page.evaluate(()=>window.__downloads.length),1);assert.equal(await page.evaluate(()=>window.__downloads[0].id),'true_123@c.us_sent');assert.equal(filePickers,0)
 checks.push('Lazy official message load continues to bilingual translation, and retry reuses the exact outgoing identity and PCM without repeating the media download')
 await page.evaluate(()=>{document.querySelector('#received').dataset.id='false_123@c.us_new';document.querySelector('#received audio').src=URL.createObjectURL(new Blob([new Uint8Array([1])]))})
 await page.waitForTimeout(150)
 // Restore a valid synthetic source under the replacement message, then hold the reply.
 await page.evaluate(()=>{document.querySelector('#received audio').src=window.__url;window.__hold=true})
 await page.locator('#received').getByRole('button',{name:'转为中文',exact:true}).click();await page.waitForFunction(()=>typeof window.__finish==='function')
 const before=await page.evaluate(()=>window.__requests.length);await page.evaluate(()=>document.querySelector('#received .rt-voice-translation button').click());assert.equal(await page.evaluate(()=>window.__requests.length),before)
 await page.locator('#side button').click();await page.evaluate(()=>window.__finish({text:'Old conversation transcript',englishTranslation:'Old conversation transcript',translation:'不应显示的旧结果',audioId:'b'.repeat(64),targetLanguage:'zh-CN'}));await page.waitForTimeout(50)
 assert.equal(await page.locator('#received [data-voice-translation]').isVisible(),false);assert.doesNotMatch(await page.textContent('body'),/不应显示的旧结果|Old conversation transcript/);assert.equal(await page.locator('#received .rt-voice-translation button').first().isEnabled(),true)
 checks.push('Duplicate clicks do not start parallel work; navigation invalidates late reply and restores the retry control')
 assert.deepEqual(errors,[])
 assert.equal(filePickers,0);assert.equal(await page.locator('input[type=file]').count(),0)
 const proof={passed:true,at:new Date().toISOString(),checks,pageErrors:errors,filePickers,syntheticAudio:true,realBrowserAudioDecode:true,recognitionAndTranslationMocked:true,officialModelFixture:true,realMessagesRead:0,realMessagesSent:0,cloudRequests:0,limitations:['Synthetic official-style model fixtures validate ownership, real browser decoding, layout and navigation; current logged-in WhatsApp media module compatibility still needs account acceptance.']}
 await writeFile(folder+'browser-results.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof))
}finally{await browser.close();assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(modules.directory,{recursive:true,force:true})}
