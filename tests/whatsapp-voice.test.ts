import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {relative,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {JSDOM,VirtualConsole} from 'jsdom'
import {mainHarness} from './main-harness.ts'
const modules=mainHarness(),{whatsappVoiceScript}=modules.load('src/main/platforms/whatsapp/inject/voiceMessages.ts')
after(()=>{assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(modules.directory,{recursive:true,force:true})})
const answer={text:'I will call tomorrow.',translation:'我明天打电话。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}
const row=(id='one',peer='123',audio=true)=>`<div id="${id}" class="message-in" data-id="false_${peer}@c.us_${id}"><button data-icon="audio-play">Play</button>${audio?`<audio src="blob:https://web.whatsapp.com/${id}"></audio>`:''}</div>`
const tick=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setTimeout(resolve,2))}
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
async function mount(options:{html?:string;translate?:(payload:any)=>any;decode?:()=>Promise<void>}={}){
 const errors:string[]=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message))
 const dom=new JSDOM(`<div id="side"><button>Other chat</button></div><div id="main"><header><span title="Alex" dir="auto">Alex</span></header>${options.html??row()}</div>`,{url:'https://web.whatsapp.com',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window as any,d=w.document
 const requests:any[]=[],reads:string[]=[];let plays=0,pauses=0,closed=0
 w.AbortSignal=AbortSignal;w.fetch=async(url:string)=>{reads.push(url);return new Response(new Uint8Array([1,2,3]))}
 w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve()};w.HTMLMediaElement.prototype.pause=function(){pauses++}
 w.AudioContext=class{async decodeAudioData(){await options.decode?.();return {duration:.15}}async close(){closed++}}
 w.OfflineAudioContext=class{count:number;destination={};constructor(_channels:number,count:number){this.count=count}createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData:()=>new Float32Array(this.count).fill(.2)}}}
 const timeout=w.setTimeout.bind(w);w.setTimeout=(fn:()=>void,ms:number)=>timeout(fn,ms===100?1:ms)
 w.realtimeTranslator={translateVoiceMessage:async(payload:any)=>{requests.push(payload);return options.translate?options.translate(payload):answer}}
 w.eval(whatsappVoiceScript);await tick()
 return {w,d,requests,reads,errors,button:(id='one')=>d.querySelector('#'+id+' .rt-voice-translation button') as HTMLButtonElement,output:(id='one')=>d.querySelector('#'+id+' [data-voice-translation]') as HTMLElement,status:(id='one')=>d.querySelector('#'+id+' [role=status]')?.textContent,async click(id='one'){this.button(id).click();await tick()},get plays(){return plays},get pauses(){return pauses},get closed(){return closed},close:()=>dom.window.close()}
}

test('one deliberate click renders Chinese first, folds the transcript, and never changes or plays original audio',async()=>{
 const h=await mount();try{
  const audio=h.d.querySelector('audio'),before=audio.outerHTML
  assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.equal(h.button().textContent,'转为中文')
  await h.click();assert.equal(h.requests.length,1);assert.equal(h.requests[0].messageId,'voice:false_123@c.us_one');assert.equal(h.requests[0].conversationId,'peer:123@c.us')
  assert.equal(Object.hasOwn(h.requests[0],'text'),false);assert.equal(h.requests[0].bytes.length,4844)
  assert.equal(h.output().textContent,answer.translation);assert.equal(h.output().hidden,false)
  const details=h.d.querySelector('#one details');assert.equal(details.open,false);assert.equal(details.hidden,false);assert.match(details.textContent,/识别原文I will call tomorrow/)
  assert.equal(audio.outerHTML,before);assert.equal(h.plays,0);assert.equal(h.pauses,0);assert.equal(h.closed,1)
  await h.click();assert.equal(h.requests.length,1);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})

test('pending duplicate clicks coalesce; a failed retry keeps exact durable message identity and PCM',async()=>{
 const gate=deferred(),h=await mount({translate:()=>gate.promise});try{
  await h.click();await h.click();assert.equal(h.requests.length,1);gate.reject(Error('识别暂时繁忙'));await tick();assert.equal(h.button().disabled,false);assert.match(h.status()!,/识别暂时繁忙/)
  h.w.realtimeTranslator.translateVoiceMessage=async(payload:any)=>{h.requests.push(payload);return answer};await h.click()
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].messageId,h.requests[0].messageId);assert.equal(h.requests[1].conversationId,h.requests[0].conversationId);assert.deepEqual(h.requests[1].bytes,h.requests[0].bytes);assert.equal(h.output().textContent,answer.translation)
 }finally{h.close()}
})

test('an unowned external player is never assigned by click or playback recency',async()=>{
 const h=await mount({html:row('one','123',false)});try{
  const audio=h.d.createElement('audio');audio.src='blob:https://web.whatsapp.com/unrelated';h.d.body.append(audio);h.d.querySelector('#one button').click();await audio.play();await h.click()
  assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.match(h.status()!,/设置 → 语音翻译/);assert.doesNotMatch(h.status()!,/记录与恢复/);assert.equal(h.button().disabled,false)
 }finally{h.close()}
})

test('an external player needs one exact durable message owner; multiple matching players are ambiguous',async()=>{
 const h=await mount({html:row('one','123',false)});try{
  const wrapper=h.d.createElement('div');wrapper.dataset.id='false_123@c.us_one';wrapper.innerHTML='<audio src="blob:https://web.whatsapp.com/exact"></audio>';h.d.body.append(wrapper);await h.click();assert.equal(h.requests.length,1);assert.deepEqual(h.reads,['blob:https://web.whatsapp.com/exact'])
 }finally{h.close()}
 const ambiguous=await mount();try{
  ambiguous.d.querySelector('#one').insertAdjacentHTML('beforeend','<audio src="blob:https://web.whatsapp.com/another"></audio>');await ambiguous.click();assert.equal(ambiguous.requests.length,0);assert.equal(ambiguous.reads.length,0)
 }finally{ambiguous.close()}
})

test('a recycled row cannot attribute the unchanged old audio blob to its replacement message',async()=>{
 const h=await mount();try{
  h.d.querySelector('#one').dataset.id='false_123@c.us_replacement';await tick();await h.click();assert.equal(h.requests.length,0);assert.equal(h.reads.length,0)
  h.d.querySelector('audio').src='blob:https://web.whatsapp.com/replacement';await tick();await h.click();assert.equal(h.requests.length,1);assert.equal(h.requests[0].messageId,'voice:false_123@c.us_replacement')
 }finally{h.close()}
})

test('navigation during decoding prevents any recognition or paid request and restores retry',async()=>{
 const gate=deferred<void>(),h=await mount({decode:()=>gate.promise});try{
  await h.click();h.d.querySelector('#side button').dispatchEvent(new h.w.Event('pointerdown',{bubbles:true}));gate.resolve();await tick()
  assert.equal(h.requests.length,0);assert.equal(h.button().disabled,false);assert.equal(h.output().hidden,true);assert.match(h.status()!,/页面或语音已变化/)
  await h.click();assert.equal(h.requests.length,1);assert.equal(h.output().textContent,answer.translation)
 }finally{h.close()}
})

test('late results do not appear after changing chats even if the same row returns before completion',async()=>{
 const gate=deferred(),h=await mount({translate:()=>gate.promise});try{
  await h.click();const node=h.d.querySelector('#one');node.remove();h.d.querySelector('#main').appendChild(node);await tick();gate.resolve(answer);await tick()
  assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false);assert.doesNotMatch(h.d.body.textContent,/I will call tomorrow|我明天打电话/)
 }finally{h.close()}
})

test('a same-tick A to B to A message identity change cancels old translation',async()=>{
 const gate=deferred(),h=await mount({translate:()=>gate.promise});try{
  await h.click();const node=h.d.querySelector('#one');node.dataset.id='false_456@c.us_other';node.dataset.id='false_123@c.us_one';await tick();gate.resolve(answer);await tick()
  assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false)
 }finally{h.close()}
})

test('changed header, owning audio node or media URL rejects the old result without a stuck control',async()=>{
 for(const mutate of [(h:any)=>h.d.querySelector('header').replaceWith(h.d.querySelector('header').cloneNode(true)),(h:any)=>h.d.querySelector('audio').replaceWith(h.d.querySelector('audio').cloneNode(true)),(h:any)=>h.d.querySelector('audio').src='blob:https://web.whatsapp.com/changed']){
  const gate=deferred(),h=await mount({translate:()=>gate.promise});try{await h.click();mutate(h);await tick();gate.resolve(answer);await tick();assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false)}finally{h.close()}
 }
})

test('malformed or wrong-language responses stay retryable and response markup is displayed as text',async()=>{
 for(const bad of [{...answer,targetLanguage:'en-US'},{...answer,translation:''},{...answer,audioId:'other'},{...answer,text:''}]){
  const h=await mount({translate:()=>bad});try{await h.click();assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false);assert.match(h.status()!,/完整的中文/)}finally{h.close()}
 }
 const h=await mount({translate:()=>({...answer,translation:'中文 <img src=x onerror=alert(1)>'})});try{await h.click();assert.equal(h.output().querySelector('img'),null);assert.match(h.output().textContent!,/中文 <img/)}finally{h.close()}
})

test('an already displayed translation is invalidated when the same message receives a different audio source',async()=>{
 const h=await mount();try{
  await h.click();assert.equal(h.output().hidden,false);assert.equal(h.button().hidden,true)
  h.d.querySelector('audio').src='blob:https://web.whatsapp.com/updated';await tick()
  assert.equal(h.output().hidden,true);assert.equal(h.output().textContent,'');assert.equal(h.button().hidden,false);assert.equal(h.button().disabled,false);assert.equal(h.d.querySelector('#one details').hidden,true)
  await h.click();assert.equal(h.requests.length,2);assert.equal(h.requests[1].messageId,h.requests[0].messageId)
 }finally{h.close()}
})

test('missing bridge or audio decode failure is explicit, retryable, and never invokes translation',async()=>{
 const h=await mount();try{delete h.w.realtimeTranslator.translateVoiceMessage;await h.click();assert.match(h.status()!,/尚未准备好/);assert.equal(h.requests.length,0);assert.equal(h.button().disabled,false)}finally{h.close()}
 const failed=await mount({decode:async()=>{throw Error('无法读取录音')}});try{await failed.click();assert.equal(failed.requests.length,0);assert.match(failed.status()!,/无法读取录音/);assert.equal(failed.closed,1);assert.equal(failed.button().disabled,false)}finally{failed.close()}
})

test('concurrent distinct voices retain separate IDs and outputs; reinjection never duplicates controls',async()=>{
 const jobs=new Map<string,ReturnType<typeof deferred>>(),h=await mount({html:row()+row('two'),translate:p=>{const job=deferred();jobs.set(p.messageId,job);return job.promise}});try{
  h.w.eval(whatsappVoiceScript);assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,2);await h.click();await h.click('two');assert.equal(h.requests.length,2)
  jobs.get('voice:false_123@c.us_two')!.resolve({...answer,translation:'第二条'});await tick();jobs.get('voice:false_123@c.us_one')!.resolve({...answer,translation:'第一条'});await tick()
  assert.equal(h.output().textContent,'第一条');assert.equal(h.output('two').textContent,'第二条');assert.deepEqual(h.errors,[])
 }finally{h.close()}
})


test('page teardown stops voice observers and rejects late results without mounting or sending again',async()=>{
 const gate=deferred(),h=await mount({translate:()=>gate.promise});try{
  await h.click();assert.equal(h.requests.length,1)
  h.w.dispatchEvent(new h.w.Event('pagehide'))
  h.d.querySelector('#main').insertAdjacentHTML('beforeend',row('after-close'))
  gate.resolve(answer);await tick()
  assert.equal(h.output().hidden,true)
  assert.equal(h.d.querySelector('#after-close .rt-voice-translation'),null)
  h.button().click();await tick();assert.equal(h.requests.length,1)
  assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
