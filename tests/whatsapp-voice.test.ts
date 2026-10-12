import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {relative,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {JSDOM,VirtualConsole} from 'jsdom'
import {mainHarness} from './main-harness.ts'
const modules=mainHarness(),{whatsappVoiceScript}=modules.load('src/main/platforms/whatsapp/inject/voiceMessages.ts')
after(()=>{assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(modules.directory,{recursive:true,force:true})})
const answer={text:'I will call tomorrow.',englishTranslation:'I will call tomorrow.',translation:'我明天打电话。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}
const row=(id='one',peer='123',audio=true)=>`<div id="${id}" class="message-in" data-id="false_${peer}@c.us_${id}"><button data-icon="audio-play">Play</button>${audio?`<audio src="blob:https://web.whatsapp.com/${id}"></audio>`:''}</div>`
const tick=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setTimeout(resolve,2))}
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
async function mount(options:{html?:string;translate?:(payload:any)=>any;decode?:()=>Promise<void>;chooseFile?:(input:HTMLInputElement,w:any)=>void;script?:string;beforeEval?:(w:any)=>void;expectedError?:RegExp}={}){
 const errors:string[]=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message))
 const dom=new JSDOM(`<div id="side"><button>Other chat</button></div><div id="main"><header><span title="Alex" dir="auto">Alex</span></header>${options.html??row()}</div>`,{url:'https://web.whatsapp.com',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window as any,d=w.document
 const requests:any[]=[],reads:string[]=[],created:string[]=[],revoked:string[]=[],pickers:HTMLInputElement[]=[];let plays=0,pauses=0,closed=0
 w.URL.createObjectURL=()=>{const url='blob:https://web.whatsapp.com/selected-'+created.length;created.push(url);return url};w.URL.revokeObjectURL=(url:string)=>revoked.push(url)
 w.HTMLInputElement.prototype.click=function(){pickers.push(this);if(options.chooseFile)options.chooseFile(this,w);else this.dispatchEvent(new w.Event('cancel'))}
 w.AbortSignal=AbortSignal;w.fetch=async(url:string)=>{reads.push(url);return new Response(new Uint8Array([1,2,3]))}
 w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve()};w.HTMLMediaElement.prototype.pause=function(){pauses++}
 w.AudioContext=class{async decodeAudioData(){await options.decode?.();return {duration:.15}}async close(){closed++}}
 w.OfflineAudioContext=class{count:number;destination={};constructor(_channels:number,count:number){this.count=count}createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData:()=>new Float32Array(this.count).fill(.2)}}}
 const timeout=w.setTimeout.bind(w);w.setTimeout=(fn:()=>void,ms:number)=>timeout(fn,ms===100?1:ms)
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:false}),translateVoiceMessage:async(payload:any)=>{requests.push(payload);return options.translate?options.translate(payload):answer}}
 options.beforeEval?.(w);if(options.expectedError)assert.throws(()=>w.eval(options.script??whatsappVoiceScript),options.expectedError);else w.eval(options.script??whatsappVoiceScript);await tick()
 return {w,d,requests,reads,errors,created,revoked,pickers,button:(id='one')=>d.querySelector('#'+id+' .rt-voice-translation button') as HTMLButtonElement,output:(id='one')=>d.querySelector('#'+id+' [data-voice-translation]') as HTMLElement,status:(id='one')=>d.querySelector('#'+id+' [role=status]')?.textContent,async click(id='one'){this.button(id).click();await tick()},get plays(){return plays},get pauses(){return pauses},get closed(){return closed},close:()=>dom.window.close()}
}
function selectFile(input:HTMLInputElement,w:any,size=4){Object.defineProperty(input,'files',{value:[new w.File([new Uint8Array(size)],'this-voice.ogg',{type:'audio/ogg'})]});input.dispatchEvent(new w.Event('change'))}

test('one deliberate click shows English and Chinese directly and never changes or plays original audio',async()=>{
 const h=await mount();try{
  const audio=h.d.querySelector('audio'),before=audio.outerHTML
  assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.equal(h.button().textContent,'转为中文')
  await h.click();assert.equal(h.requests.length,1);assert.equal(h.requests[0].messageId,'voice:false_123@c.us_one');assert.equal(h.requests[0].conversationId,'peer:123@c.us')
  assert.equal(Object.hasOwn(h.requests[0],'text'),false);assert.equal(h.requests[0].bytes.length,4844)
  assert.equal(h.output().textContent,answer.translation);assert.equal(h.output().hidden,false)
  assert.equal(h.d.querySelector('#one [data-voice-english]').textContent,answer.englishTranslation);assert.equal(h.d.querySelector('#one [data-voice-english]').hidden,false)
  const details=h.d.querySelector('#one details');assert.equal(details.open,false);assert.equal(details.hidden,true)
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

test('WhatsApp mounts bilingual output inside the identified message bubble and retains nodes on rescans',async()=>{
 const h=await mount({html:'<div class="message-in" data-id="false_123@c.us_one" id="one"><div class="copyable-text"><audio src="blob:https://web.whatsapp.com/one"></audio></div></div>'});try{
  await h.click();const box=h.d.querySelector('.copyable-text .rt-voice-translation'),english=box.querySelector('[lang=en]');assert.ok(box)
  h.d.querySelector('header span').title='Alex renamed';await tick();assert.equal(h.d.querySelector('.copyable-text .rt-voice-translation'),box);assert.equal(box.querySelector('[lang=en]'),english);assert.equal(h.requests.length,1)
 }finally{h.close()}
})

test('an unowned external player is never assigned by click or playback recency',async()=>{
 const h=await mount({html:row('one','123',false)});try{
  const audio=h.d.createElement('audio');audio.src='blob:https://web.whatsapp.com/unrelated';h.d.body.append(audio);h.d.querySelector('#one button').click();await audio.play();await h.click()
  assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.match(h.status()!,/已取消选择/);assert.doesNotMatch(h.status()!,/设置|记录与恢复/);assert.equal(h.button().disabled,false);assert.equal(h.pickers.length,1)
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

test('lazy voice role controls and changed voice markers mount without needing an audio element',async()=>{
 for(const [attribute,value] of [['aria-label','Play voice note'],['aria-label','播放语音消息'],['data-icon','audio-download'],['data-testid','ptt-message']]){
  const h=await mount({html:'<div data-id="false_123@lid_one" id="one"><div class="message-in"><div role="button" id="lazy"></div></div></div>'});try{
   assert.equal(h.button(),null);h.d.querySelector('#lazy').setAttribute(attribute,value);await tick()
   assert.equal(h.button().textContent,'转为中文');assert.equal(h.d.querySelector('#one .message-in .rt-voice-translation'),h.button().parentElement)
   assert.equal(h.requests.length,0);assert.equal(h.reads.length,0)
   const box=h.button().parentElement;h.d.querySelector('#lazy').setAttribute('title','download-complete');await tick();assert.equal(h.button().parentElement,box);assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,1)
  }finally{h.close()}
 }
})

test('voice detection excludes quoted audio and generic video play controls',async()=>{
 const h=await mount({html:'<div id="one" class="message-in" data-id="false_123@c.us_one"><div data-testid="quoted-message"><button data-icon="audio-play"></button><audio src="blob:https://web.whatsapp.com/quote"></audio></div><button aria-label="Play video"><span data-icon="play"></span></button><video></video></div>'});try{
  assert.equal(h.button(),null);assert.equal(h.requests.length,0);assert.equal(h.reads.length,0)
 }finally{h.close()}
})

test('explicit per-bubble file selection renders both languages without reading the shared player or settings',async()=>{
 const h=await mount({html:row('one','123',false),chooseFile:selectFile});try{
  const audio=h.d.createElement('audio');audio.src='blob:https://web.whatsapp.com/global';h.d.body.append(audio)
  await h.click();assert.equal(h.pickers.length,1);assert.deepEqual(h.reads,h.created);assert.deepEqual(h.revoked,h.created);assert.equal(h.requests.length,1)
  assert.equal(h.requests[0].messageId,'voice:false_123@c.us_one');assert.equal(h.requests[0].conversationId,'peer:123@c.us');assert.equal(h.output().textContent,answer.translation);assert.equal(h.d.querySelector('#one [lang=en]').textContent,answer.englishTranslation)
  assert.equal(h.d.querySelector('input[type=file]'),null);assert.equal(h.plays,0);assert.equal(h.pauses,0)
  const output=h.output(),box=h.button().parentElement;h.d.querySelector('#one button[data-icon]').setAttribute('data-icon','audio-pause');await tick();assert.equal(h.output(),output);assert.equal(h.button().parentElement,box);assert.equal(output.hidden,false);assert.equal(h.requests.length,1)
 }finally{h.close()}
})

test('cancelled or oversized file selection makes no audio reads or paid requests and stays retryable',async()=>{
 for(const chooseFile of [undefined,(input:HTMLInputElement,w:any)=>selectFile(input,w,20*1024*1024+1)]){
  const h=await mount({html:row('one','123',false),chooseFile});try{await h.click();assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.equal(h.created.length,0);assert.equal(h.button().disabled,false);assert.match(h.status()!,/取消选择|20 MB/);assert.equal(h.d.querySelector('input[type=file]'),null)}finally{h.close()}
 }
})

test('navigation or recycled row while selecting a file cancels without decoding or billing',async()=>{
 for(const change of [(h:any)=>h.d.querySelector('#side button').dispatchEvent(new h.w.Event('pointerdown',{bubbles:true})),(h:any)=>h.d.querySelector('#one').dataset.id='false_123@c.us_recycled']){
  const h=await mount({html:row('one','123',false),chooseFile:()=>{}});try{
   await h.click();assert.equal(h.pickers.length,1);change(h);await tick();selectFile(h.pickers[0],h.w);await tick();assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.equal(h.created.length,0);assert.equal(h.button().disabled,false);assert.equal(h.d.querySelector('input[type=file]'),null)
  }finally{h.close()}
 }
})

test('selected-file decode and translation reject stale owners and always revoke the temporary media URL',async()=>{
 for(const phase of ['decode','translate']){
  const gate=deferred<any>(),h=await mount({html:row('one','123',false),chooseFile:selectFile,...(phase==='decode'?{decode:()=>gate.promise}:{translate:()=>gate.promise})});try{
   await h.click();assert.equal(h.created.length,1);h.d.querySelector('#side button').dispatchEvent(new h.w.Event('pointerdown',{bubbles:true}));gate.resolve(answer);await tick()
   assert.equal(h.requests.length,phase==='decode'?0:1);assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false);assert.deepEqual(h.revoked,h.created);assert.doesNotMatch(h.d.body.textContent,/我明天打电话/)
  }finally{h.close()}
 }
})

test('a failed owned decode exposes an explicit same-bubble file retry instead of repeatedly reading the unusable source',async()=>{
 let count=0;const h=await mount({chooseFile:selectFile,decode:async()=>{if(count++===0)throw Error('无法读取录音')}});try{
  await h.click();assert.equal(h.requests.length,0);const fileButton=h.d.querySelector('.rt-voice-translation button:nth-child(2)');assert.equal(fileButton.hidden,false);fileButton.click();await tick()
  assert.equal(h.requests.length,1);assert.equal(h.pickers.length,1);assert.equal(h.output().textContent,answer.translation);assert.deepEqual(h.reads,['blob:https://web.whatsapp.com/one',...h.created]);assert.deepEqual(h.revoked,h.created);assert.equal(fileButton.hidden,true)
 }finally{h.close()}
})

test('unloading a completed lazy audio player keeps its bilingual result without another paid request',async()=>{
 const h=await mount();try{
  await h.click();const box=h.button().parentElement,output=h.output();h.d.querySelector('audio').remove();await tick();assert.equal(h.output(),output);assert.equal(h.button().parentElement,box);assert.equal(output.hidden,false);assert.equal(h.button().hidden,true);assert.equal(h.requests.length,1)
 }finally{h.close()}
})

test('voice deletion on a connected same-ID row removes completed text and the obsolete entry',async()=>{
 const h=await mount();try{
  await h.click();h.d.querySelector('#one audio').remove();h.d.querySelector('#one > button').remove();h.d.querySelector('#one').append('This message was deleted');await tick()
  assert.equal(h.d.querySelector('#one .rt-voice-translation'),null);assert.doesNotMatch(h.d.querySelector('#one').textContent,/I will call tomorrow|我明天打电话/);assert.equal(h.requests.length,1)
 }finally{h.close()}
})

test('removing or replacing the selected voice control cancels file work even while row and message ID stay unchanged',async()=>{
 for(const phase of ['picker','decode','translate']){
  const gate=deferred<any>(),h=await mount({html:row('one','123',false),chooseFile:phase==='picker'?()=>{}:selectFile,...(phase==='decode'?{decode:()=>gate.promise}:phase==='translate'?{translate:()=>gate.promise}:{})});try{
   await h.click();const oldControl=h.d.querySelector('#one > button');oldControl.remove();await tick()
   if(phase==='picker')selectFile(h.pickers[0],h.w);else gate.resolve(answer);await tick()
   assert.equal(h.d.querySelector('#one .rt-voice-translation'),null);assert.equal(h.requests.length,phase==='translate'?1:0);assert.deepEqual(h.revoked,h.created);assert.doesNotMatch(h.d.querySelector('#one').textContent,/I will call tomorrow|我明天打电话/)
  }finally{h.close()}
 }
 const gate=deferred(),h=await mount({html:row('one','123',false),chooseFile:selectFile,translate:()=>gate.promise});try{
  await h.click();const button=h.d.querySelector('#one > button');button.replaceWith(button.cloneNode(true));await tick();gate.resolve(answer);await tick();assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false);assert.deepEqual(h.revoked,h.created)
 }finally{h.close()}
})

test('whole WhatsApp injection retains voice and send guards when sidebar or presence initialization fails',async()=>{
 for(const [path,name] of [['./sidebar','whatsappSidebarScript'],['./presence','whatsappPresenceScript']]){
  const fixture=mainHarness(undefined,undefined,{[path]:{[name]:'throw new Error("synthetic optional failure");'}});let h:Awaited<ReturnType<typeof mount>>|undefined
  try{
   const {whatsappInjectionScript}=fixture.load('src/main/platforms/whatsapp/inject/script.ts');h=await mount({script:whatsappInjectionScript})
   assert.equal(typeof h.w.__RT_SEND_SELECT__,'function');assert.equal(typeof h.w.__RT_SEND_COMMIT__,'function');assert.equal(h.button().textContent,'转为中文');await h.click();assert.equal(h.requests.length,1);assert.equal(h.output().textContent,answer.translation);assert.deepEqual(h.errors,[])
  }finally{h?.close();assert.match(relative(resolve(tmpdir()),resolve(fixture.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(fixture.directory,{recursive:true,force:true})}
 }
})

test('core bootstrap errors still propagate while optional voice can install, so core send readiness cannot be reported',async()=>{
 const {whatsappInjectionScript}=modules.load('src/main/platforms/whatsapp/inject/script.ts')
 const h=await mount({script:whatsappInjectionScript,expectedError:/synthetic media bootstrap failure/,beforeEval:w=>Object.defineProperty(w.navigator,'mediaDevices',{get(){throw Error('synthetic media bootstrap failure')}})});try{
  assert.equal(typeof h.w.__RT_SEND_SELECT__,'undefined');assert.equal(typeof h.w.__RT_SEND_COMMIT__,'undefined');assert.equal(h.button().textContent,'转为中文');await h.click();assert.equal(h.output().textContent,answer.translation)
 }finally{h.close()}
})

test('voice initialization failure cannot poison reinstall or disable the already installed text send guards',async()=>{
 const {whatsappInjectionScript}=modules.load('src/main/platforms/whatsapp/inject/script.ts');let failed=false,activeObservers=0
 const h=await mount({script:whatsappInjectionScript,beforeEval:w=>{const Original=w.MutationObserver;w.MutationObserver=class extends Original{active=false;observe(...args:any[]){if(!failed){failed=true;throw Error('synthetic voice observer failure')}super.observe(...args);if(!this.active){this.active=true;activeObservers++}}disconnect(){super.disconnect();if(this.active){this.active=false;activeObservers--}}}}});try{
  assert.equal(failed,true);assert.equal(h.w.__HD_VOICE_INSTALLED__,undefined);assert.equal(h.button(),null);assert.equal(typeof h.w.__RT_SEND_SELECT__,'function');assert.equal(typeof h.w.__RT_SEND_COMMIT__,'function');const before=activeObservers
  h.w.eval(whatsappInjectionScript);await tick();assert.equal(h.w.__HD_VOICE_INSTALLED__,true);assert.equal(h.button().textContent,'转为中文');assert.equal(activeObservers,before+1);h.w.eval(whatsappInjectionScript);await tick();assert.equal(activeObservers,before+1);assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,1);await h.click();assert.equal(h.requests.length,1);assert.equal(h.output().textContent,answer.translation)
 }finally{h.close()}
})

test('a late core bootstrap failure remains fail-closed on a second injection even when send functions already exist',async()=>{
 const {whatsappInjectionScript}=modules.load('src/main/platforms/whatsapp/inject/script.ts');let blocked=0
 const h=await mount({script:whatsappInjectionScript,expectedError:/synthetic input guard failure/,beforeEval:w=>{const add=w.document.addEventListener.bind(w.document);w.document.addEventListener=(type:string,...args:any[])=>{if(type==='compositionstart'){blocked++;throw Error('synthetic input guard failure')}return add(type,...args)}}});try{
  assert.equal(typeof h.w.__RT_SEND_SELECT__,'function');assert.equal(typeof h.w.__RT_SEND_COMMIT__,'function');assert.equal(h.w.__RT_TRANSLATOR_BOOTSTRAP_FAILED__,true)
  assert.throws(()=>h.w.eval(whatsappInjectionScript),/文字翻译组件未完成加载/);assert.equal(blocked,1);assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,1)
  // The adapter only announces readiness after executeJavaScript resolves.
  // Neither failed attempt can reach that check, while voice remains usable.
  await h.click();assert.equal(h.requests.length,1);assert.equal(h.output().textContent,answer.translation)
 }finally{h.close()}
})

const opaqueRow=(id='3EB0000000000000000001',domId='one')=>`<div id="${domId}" data-id="${id}"><div role="button" aria-label="Play voice note"></div></div>`
test('opaque official message IDs have separate stable voice identities without deriving a peer from the header name',async()=>{
 const h=await mount({html:opaqueRow()+opaqueRow('3EB0000000000000000002','two'),chooseFile:selectFile});try{
  assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,2);await h.click();await h.click('two');assert.equal(h.requests.length,2)
  assert.deepEqual(h.requests.map((p:any)=>[p.conversationId,p.messageId]),[['whatsapp-message:3EB0000000000000000001','voice:whatsapp-message:3EB0000000000000000001'],['whatsapp-message:3EB0000000000000000002','voice:whatsapp-message:3EB0000000000000000002']]);assert.equal(h.output().hidden,false);assert.equal(h.output('two').hidden,false);assert.equal(h.plays,0)
 }finally{h.close()}
})

test('legacy peer IDs and opaque IDs coexist without a generated container swallowing either voice entry',async()=>{
 const h=await mount({html:'<div data-id="generated-wrapper">'+row()+opaqueRow('3EB0000000000000000002','two')+'</div>',chooseFile:selectFile});try{
  assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,2);await h.click();await h.click('two');assert.equal(h.requests.length,2);assert.equal(h.requests[0].conversationId,'peer:123@c.us');assert.equal(h.requests[1].conversationId,'whatsapp-message:3EB0000000000000000002');assert.equal(h.output('two').textContent,answer.translation)
 }finally{h.close()}
})

test('opaque-ID retries retain exact identity and never merge different same-text voice rows',async()=>{
 let attempts=0;const h=await mount({html:opaqueRow(),chooseFile:selectFile,translate:()=>{if(!attempts++)throw Error('识别暂时繁忙');return answer}});try{
  await h.click();assert.equal(h.button().disabled,false);await h.click();assert.equal(h.requests.length,2);assert.equal(h.requests[0].messageId,h.requests[1].messageId);assert.equal(h.requests[0].conversationId,h.requests[1].conversationId);assert.deepEqual(h.requests[0].bytes,h.requests[1].bytes)
 }finally{h.close()}
})

test('opaque row recycling, same-name chat replacement, and A-B-A identity changes all reject late bilingual results',async()=>{
 for(const change of [(h:any)=>h.d.querySelector('#one').dataset.id='3EB0000000000000000002',(h:any)=>{const node=h.d.querySelector('#one');node.dataset.id='3EB0000000000000000002';node.dataset.id='3EB0000000000000000001'},(h:any)=>{const header=h.d.querySelector('header');header.replaceWith(header.cloneNode(true))}]){
  const gate=deferred(),h=await mount({html:opaqueRow(),chooseFile:selectFile,translate:()=>gate.promise});try{
   await h.click();change(h);await tick();gate.resolve(answer);await tick();assert.equal(h.output().hidden,true);assert.equal(h.button().disabled,false);assert.doesNotMatch(h.d.querySelector('#one').textContent,/我明天打电话/);assert.deepEqual(h.revoked,h.created)
  }finally{h.close()}
 }
})

test('invalid opaque IDs and quoted opaque audio do not create voice controls',async()=>{
 const h=await mount({html:opaqueRow('short')+opaqueRow('invalid_id@peer','two')+'<div data-id="3EB0000000000000000003"><div data-testid="quoted-message">'+opaqueRow('3EB0000000000000000004','quoted')+'</div>Actual text</div>'});try{assert.equal(h.d.querySelectorAll('.rt-voice-translation').length,0);assert.equal(h.requests.length,0)}finally{h.close()}
})

test('a native player whose current source still points to previous media is not decoded under its updated source',async()=>{
 const h=await mount();try{
  const audio=h.d.querySelector('audio');Object.defineProperty(audio,'currentSrc',{configurable:true,value:'blob:https://web.whatsapp.com/previous'});audio.src='blob:https://web.whatsapp.com/replacement';await tick();await h.click()
  assert.equal(h.requests.length,0);assert.equal(h.reads.length,0);assert.equal(h.pickers.length,1);assert.match(h.status()!,/已取消选择/)
  Object.defineProperty(audio,'currentSrc',{configurable:true,value:''});await h.click();assert.equal(h.requests.length,1);assert.deepEqual(h.reads,['blob:https://web.whatsapp.com/replacement'])
 }finally{h.close()}
})
