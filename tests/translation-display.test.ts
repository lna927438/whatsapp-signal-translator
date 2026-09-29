import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {JSDOM} from 'jsdom'
const {whatsappInjectionScript}=createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/script.ts')
async function until(check:()=>boolean){for(let n=0;n<300;n++){if(check())return;await new Promise(r=>setTimeout(r,5))}assert.fail('Display did not settle')}
const tick=()=>new Promise(r=>setTimeout(r,35))
function whatsapp(translate:(request:any)=>Promise<string>=async request=>'译文 '+request.text,options:{settings?:()=>Promise<any>;shortSettingsTimeout?:boolean;messages?:string}={}){
 const dom=new JSDOM('<div id="main"><header><span title="Fixture" dir="auto">Fixture</span></header><div class="message-in" data-id="false_fixture@c.us_one"><span class="selectable-text">hello</span></div><footer><div contenteditable="true" role="textbox"></div></footer></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'}),w=dom.window as any
 const settings:any={receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible',localLanguage:'zh-CN',translationsVisible:true},calls:any[]=[],cache=new Map<string,string>(),intervals:Function[]=[],statuses:any[]=[]
 if(options.messages) w.document.querySelector('.message-in').outerHTML=options.messages;
 w.setInterval=(fn:Function)=>{intervals.push(fn);return intervals.length}
 if(options.shortSettingsTimeout){const timeout=w.setTimeout.bind(w);w.setTimeout=(fn:Function,ms:number)=>timeout(fn,ms===5000?20:ms)}
 w.realtimeTranslator={getRuntimeSettings:options.settings||(async()=>({...settings})),reportConversation(){},reportStatus:(value:any)=>statuses.push(value),cachedIncoming:async(p:any)=>cache.get(p.messageId+':'+p.text),translateIncoming:async(p:any)=>{calls.push(p);const text=await translate(p);cache.set(p.messageId+':'+p.text,text);return text}}
 w.eval(whatsappInjectionScript)
 return{dom,w,settings,calls,cache,statuses,scan:async()=>{intervals.forEach(fn=>fn());await tick()},bubble:()=>w.document.querySelector('.message-in'),refresh:()=>w.__RT_REFRESH_TRANSLATIONS__()}
}

test('WhatsApp translates the reply body when only its quote has pre-plain-text, retaining image emoji',async()=>{
 const h=whatsapp(undefined,{messages:`<div class="message-in" data-id="false_fixture@c.us_reply" data-testid="reply-message">
  <div data-testid="quoted-message"><div data-pre-plain-text="You"><span class="selectable-text">Old quoted text</span><span data-icon="msg-check"></span></div></div>
  <span class="selectable-text">Thought about bitcoin at $1.00 <img alt="😬"><img alt="😬"><img alt="😬"></span>
 </div>`});
 try{await until(()=>h.bubble().querySelector('.rt-translation'));assert.equal(h.calls.length,1);assert.equal(h.calls[0].text,'Thought about bitcoin at $1.00 😬😬😬');assert.equal(h.calls[0].outgoing,false);assert.equal(h.bubble().querySelector('[data-testid="quoted-message"] .rt-translation'),null);await h.scan();assert.equal(h.calls.length,1)}finally{h.dom.window.close()}
})

test('WhatsApp reads nested formatted text once, preserving emoji sequences and excluding pure emoji from paid work',async()=>{
 const h=whatsapp(undefined,{messages:`<div class="message-in" data-id="false_fixture@c.us_mixed"><span class="selectable-text">Hello <b class="selectable-text">there</b><br>Good morning <img alt="👩🏽‍💻"><img alt="🇺🇸"><img alt="1️⃣"></span></div>
 <div class="message-in" data-id="false_fixture@c.us_emoji"><span class="selectable-text"><img alt="😂"><img alt="❤️"></span></div>`});
 try{await until(()=>h.bubble().querySelector('.rt-translation'));assert.equal(h.calls.length,1);assert.equal(h.calls[0].text,'Hello there Good morning 👩🏽‍💻🇺🇸1️⃣');await h.scan();assert.equal(h.calls.length,1)}finally{h.dom.window.close()}
})

test('one failed historical message never pauses other history or a subsequent incoming message',async()=>{
 const h=whatsapp(async p=>{if(p.text==='unavailable')throw new Error('本次翻译未成功，云端已确认未扣费。');return '已翻译';},{messages:`<div class="message-in" data-id="false_fixture@c.us_bad"><span class="selectable-text">unavailable</span></div>`});
 try{
  await until(()=>h.bubble().querySelector('[data-rt-history-action]'));
  const newest=h.w.document.createElement('div');newest.className='message-in';newest.dataset.id='false_fixture@c.us_newest';newest.innerHTML='<span class="selectable-text">New reply 😃</span>';h.w.document.querySelector('#main').insertBefore(newest,h.w.document.querySelector('footer'));
  await h.scan();await until(()=>newest.querySelector('.rt-translation'));assert.equal(h.calls.length,2);assert.equal(h.bubble().querySelector('button').textContent,'重试翻译');
 }finally{h.dom.window.close()}
})

test('WhatsApp a hung display-settings read times out and refresh can recover translation',async()=>{
 let reads=0;
 const h=whatsapp(undefined,{shortSettingsTimeout:true,settings:()=>++reads===1?new Promise(()=>{}):Promise.resolve({receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible',localLanguage:'zh-CN'})});
 try{
  await until(()=>h.statuses.some(value=>value.state==='error'));
  assert.equal(h.calls.length,0);h.refresh();await until(()=>h.bubble().querySelector('.rt-translation'));
  assert.equal(h.calls.length,1);assert.ok(reads>=2);
 }finally{h.dom.window.close()}
})
test('WhatsApp restores a React-replaced annotation from cache without another paid request',async()=>{
 const h=whatsapp();try{await until(()=>h.bubble().querySelector('.rt-translation'));h.bubble().querySelector('.selectable-text').innerHTML='hello';await h.scan();await until(()=>h.bubble().querySelector('.rt-translation'));assert.equal(h.calls.length,1)}finally{h.dom.window.close()}
})

test('WhatsApp a stalled historical translation leaves a slot for a newly received message',async()=>{
 let release:(s:string)=>void=()=>{};
 const h=whatsapp(request=>request.text==='hello'?new Promise(r=>{release=r}):Promise.resolve('最新译文'));
 try{
  await until(()=>h.calls.length===1);
  const recent=h.w.document.createElement('div');recent.className='message-in';recent.dataset.id='false_fixture@c.us_recent';recent.innerHTML='<span class="selectable-text">recent message</span>';
  h.w.document.querySelector('#main').insertBefore(recent,h.w.document.querySelector('footer'));
  await h.scan();await until(()=>recent.querySelector('.rt-translation')?.textContent==='最新译文');
  assert.equal(h.calls.length,2);assert.equal(h.bubble().querySelector('.rt-translation'),null);
  release('历史译文');await until(()=>h.bubble().querySelector('.rt-translation'));
 }finally{h.dom.window.close()}
})
test('WhatsApp recycled bubble IDs/text and nested receipt wrappers do not reuse another translation',async()=>{
 const h=whatsapp();try{await until(()=>h.calls.length===1&&h.bubble().querySelector('.rt-translation'));const b=h.bubble();b.setAttribute('data-id','false_fixture@c.us_two');b.querySelector('.selectable-text').firstChild.textContent='different';await h.scan();await until(()=>h.calls.length===2&&b.textContent.includes('译文 different'));assert.equal(h.calls[1].messageId,'false_fixture@c.us_two');assert.equal(h.calls[1].text,'different');assert.equal(b.querySelectorAll('.rt-translation').length,1);
 const wrapper=h.w.document.createElement('div');wrapper.setAttribute('data-id','false_fixture@c.us_two');b.replaceWith(wrapper);wrapper.appendChild(b);await h.scan();assert.equal(h.calls.length,2);assert.equal(wrapper.querySelectorAll('.rt-translation').length,1)
 }finally{h.dom.window.close()}
})
test('WhatsApp ignores an old response after hide/settings refresh and restores only current display',async()=>{
 let release:(s:string)=>void=()=>{};const h=whatsapp(()=>new Promise(r=>{release=r}));try{await until(()=>h.calls.length===1);h.settings.translationsVisible=false;h.refresh();release('旧译文');await tick();await h.scan();assert.equal(h.w.document.querySelectorAll('.rt-translation').length,0);h.settings.translationsVisible=true;h.refresh();await until(()=>h.w.document.querySelector('.rt-translation'));assert.equal(h.calls.length,1)}finally{h.dom.window.close()}
})
test('WhatsApp immediate display toggle invalidates an in-flight result before the next scan',async()=>{
 let release:(s:string)=>void=()=>{};const h=whatsapp(()=>new Promise(r=>{release=r}));try{await until(()=>h.calls.length===1);h.settings.translationsVisible=false;h.w.__RT_APPLY_SETTINGS__({translationsVisible:false});release('must stay hidden');await tick();assert.equal(h.w.document.querySelectorAll('.rt-translation').length,0)}finally{h.dom.window.close()}
})
test('WhatsApp restores outgoing history and offers manual history translation while auto receive is off',async()=>{
 const h=whatsapp();try{await until(()=>h.bubble().querySelector('.rt-translation'));const b=h.bubble();b.className='message-out';b.setAttribute('data-id','true_fixture@c.us_out');b.innerHTML='<span class="selectable-text">sent english</span>';h.settings.receiveAutoTranslate=false;h.cache.set('true_fixture@c.us_out:sent english','发送原文');h.refresh();await until(()=>b.querySelector('.rt-translation'));assert.equal(b.querySelector('.rt-translation').textContent,'发送原文');assert.equal(h.calls.length,1);
 b.setAttribute('data-id','true_fixture@c.us_other');b.innerHTML='<span class="selectable-text">from phone</span>';await h.scan();await until(()=>b.querySelector('[data-rt-history-action]'));b.querySelector('button').click();await until(()=>b.querySelector('.rt-translation'));assert.equal(h.calls[1].outgoing,true);assert.equal(h.calls[1].text,'from phone')
 }finally{h.dom.window.close()}
})
function signal(translate:(request:any)=>Promise<any>,options:{shortTranslationTimeout?:boolean;language?:string}={}){
 const dom=new JSDOM('<div data-hellodog-id="m1"><div class="module-message__text">hello</div></div>',{runScripts:'outside-only'}),w=dom.window as any,events=new Map(),calls:any[]=[],exports:any={},intervals:Function[]=[]
 Object.defineProperty(w.navigator,'language',{value:options.language||'zh-CN'});
 w.HTMLElement.prototype.getBoundingClientRect=()=>({top:10,bottom:90,left:0,right:300})
 const message={id:'m1',attributes:{body:'hello',type:'outgoing',conversationId:'c1',sent_at:1,sendStateByConversationId:{peer:{status:'Sent'}}} as any,get(key:string){return this.attributes[key]}}
 w.MessageCache={getById:(id:string)=>id===message.id?message:undefined};w.ConversationController={get:()=>({getTitle:()=> 'Fixture',get:()=> 'direct'})}
 const code=ts.transpileModule(readFileSync(new URL('../integrations/hellodog-source/hellodog.preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 // Text-display fixtures isolate voice mounting, which has its own DOM/IPC tests.
 runInNewContext(code,{exports,Date,window:w,document:w.document,innerHeight:700,process:{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}},MutationObserver:w.MutationObserver,setTimeout:(f:any,ms:number)=>w.setTimeout(f,ms===400?10:options.shortTranslationTimeout&&ms===45000?30:ms),clearTimeout:w.clearTimeout.bind(w),setInterval:(fn:Function)=>{intervals.push(fn);return intervals.length},require:(name:string)=>name==='electron'?{ipcRenderer:{on:(name:string,fn:Function)=>events.set(name,fn),send(){},invoke:async(_:string,r:any)=>{calls.push(r);return translate(r)}}}:name==='./hellodog.voice.preload.ts'?{startHelloDogVoiceMessages(){}}:{}})
 exports.startHelloDogMessages()
 return {dom,w,calls,message,intervals,refresh:()=>events.get('hellodog:refresh')(),node:()=>w.document.querySelector('.hellodog-translation')}
}

test('Signal retries stationary visible history after cooldown without scrolling or new messages',async()=>{
 const realNow=Date.now;let clock=realNow(),available=false;Date.now=()=>clock;
 const h=signal(async()=>{if(!available)throw Error('temporarily busy');return{enabled:true,text:'自动恢复译文'}});
 try{
  await until(()=>h.w.document.querySelector('button')?.textContent==='重试翻译');
  available=true;clock+=15001;h.intervals.forEach(fn=>fn());
  await until(()=>h.node()?.textContent==='自动恢复译文');assert.equal(h.calls.length,2);
  h.intervals.forEach(fn=>fn());await tick();assert.equal(h.calls.length,2);
 }finally{Date.now=realNow;h.dom.window.close()}
})

test('Signal a stalled history translation becomes retryable with the same message and ignores its late result',async()=>{
 let release:(value:any)=>void=()=>{},first=true;
 const h=signal(async()=>{if(first){first=false;return new Promise(resolve=>{release=resolve})}return{enabled:true,text:'恢复后的译文'}},{shortTranslationTimeout:true});
 try{
  await until(()=>h.w.document.querySelector('button')?.textContent==='重试翻译');
  assert.equal(h.calls.length,1);h.w.document.querySelector('button').click();await until(()=>h.node()?.textContent==='恢复后的译文');
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].id,h.calls[1].id);
  release({enabled:true,text:'过期结果'});await tick();assert.equal(h.node().textContent,'恢复后的译文');
 }finally{h.dom.window.close()}
})
test('Signal translates phone-synced outgoing history instead of silently skipping it',async()=>{
 const h=signal(async()=>({enabled:true,text:'历史译文'}));try{await until(()=>h.node());assert.equal(h.node().textContent,'历史译文');assert.equal(h.calls[0].id,'m1');assert.equal(h.calls[0].direction,'incoming')}finally{h.dom.window.close()}
})

test('Signal queued and failed outgoing originals never create a paid incoming translation',async()=>{
 const h=signal(async()=>({enabled:true,text:'historical translation'}));
 h.message.attributes.sendStateByConversationId={peer:{status:'Pending'}};
 try{
  await tick();assert.equal(h.calls.length,0);assert.equal(h.node(),null);
  h.message.attributes.sendStateByConversationId.peer.status='Failed';h.refresh();await tick();assert.equal(h.calls.length,0);
  h.message.attributes.sendStateByConversationId.peer.status='Sent';h.refresh();await until(()=>h.node());
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].direction,'incoming');
 }finally{h.dom.window.close()}
})

test('Signal pending sends use their persisted original annotation without translating it again',async()=>{
 const h=signal(async()=>({enabled:true}));
 h.message.attributes.sendStateByConversationId={peer:{status:'Pending'}};
 try{
  await tick();assert.equal(h.calls.length,0);
  h.message.attributes.helloDogTranslation={original:'HD-123 原文',translated:'hello',requestId:'original-send'};
  h.refresh();await until(()=>h.node());assert.equal(h.node().textContent,'HD-123 原文');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].direction,'display');assert.equal(h.calls[0].text,'');
 }finally{h.dom.window.close()}
})

test('an acknowledged outgoing body identical to its saved original can still display a local-language translation',async()=>{
 const h=signal(async()=>({enabled:true,text:'你好'}));
 h.message.attributes.helloDogTranslation={original:'hello',translated:'hello',requestId:'send-copy'};
 try{await until(()=>h.node());assert.equal(h.node().textContent,'你好');assert.equal(h.calls[0].direction,'incoming')}finally{h.dom.window.close()}
})

test('Signal custom history controls follow the configured interface language without translating message text',async()=>{
 let language='en';
 const h=signal(async r=>r.manual?{enabled:true,text:'手动原样译文',uiLanguage:language}:{enabled:false,manual:true,uiLanguage:language},{language:'zh-CN'});
 try{
  await until(()=>h.w.document.querySelector('button')?.textContent==='Translate');
  assert.equal(h.w.document.querySelector('.module-message__text')?.firstChild?.textContent,'hello');
  language='zh-CN';h.refresh();await until(()=>h.w.document.querySelector('button')?.textContent==='翻译');
  assert.ok(h.calls.every(r=>!r.manual));
  h.w.document.querySelector('button').click();await until(()=>h.node()?.textContent==='手动原样译文');
  assert.equal(h.calls.filter(r=>r.manual).length,1);
 }finally{h.dom.window.close()}
})

test('WhatsApp interface-language changes restore cached history without another translation request',async()=>{
 const h=whatsapp();try{
  await until(()=>h.bubble().querySelector('.rt-translation'));
  h.settings.uiLanguage='en';h.refresh();await until(()=>h.bubble().querySelector('.rt-translation'));
  assert.equal(h.calls.length,1);assert.equal(h.bubble().querySelector('.rt-translation').textContent,'译文 hello');
  h.bubble().setAttribute('data-id','false_fixture@c.us_manual');h.bubble().innerHTML='<span class="selectable-text">new untranslated history</span>';
  h.settings.receiveAutoTranslate=false;h.refresh();await until(()=>h.bubble().querySelector('[data-rt-history-action]'));
  assert.equal(h.bubble().querySelector('button').textContent,'Translate message');
  assert.equal(h.calls.length,1);
 }finally{h.dom.window.close()}
})
test('Signal manual history action translates the original message identity once',async()=>{
 const h=signal(async r=>r.manual?{enabled:true,text:'手动译文'}:{enabled:false,manual:true});try{await until(()=>h.w.document.querySelector('button'));h.w.document.querySelector('button').click();await until(()=>h.node());assert.equal(h.calls.length,2);assert.equal(h.calls[1].id,'m1');assert.equal(h.calls[1].manual,true)}finally{h.dom.window.close()}
})
test('Signal keeps original send text without translation and restores React-removed annotations',async()=>{
 const h=signal(async()=>({enabled:true}));h.message.attributes.helloDogTranslation={original:'原文',translated:'hello',requestId:'saved'};try{await until(()=>h.node());h.node().remove();await until(()=>h.node());assert.equal(h.node().textContent,'原文');assert.ok(h.calls.every(r=>r.direction==='display'));assert.equal(h.calls.length,1)}finally{h.dom.window.close()}
})
test('Signal discards stale results on settings change and removes translations for erased messages',async()=>{
 let release:(r:any)=>void=()=>{};let first=true;const h=signal(async()=>{if(first){first=false;return new Promise(r=>{release=r})}return{enabled:true,text:'新译文',color:'#123456'}});try{await until(()=>h.calls.length===1);h.refresh();release({enabled:true,text:'旧译文'});await until(()=>h.node()?.textContent==='新译文');assert.equal(h.node().style.color,'rgb(18, 52, 86)');h.message.attributes.isErased=true;h.w.document.querySelector('.module-message__text').textContent='deleted';await tick();assert.equal(h.node(),null)}finally{h.dom.window.close()}
})
