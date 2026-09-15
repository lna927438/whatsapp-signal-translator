import {test} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {createRequire} from 'node:module'
const {whatsappInjectionScript}=createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/script.ts');
const wait=async(check:()=>boolean)=>{for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,5))}assert.fail('History did not settle')};

test('successful manual recovery clears an earlier account pause and translates subsequent messages',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="Peer">Peer</span></header><div class="message-in" data-id="false_peer@c.us_a"><span class="selectable-text">Hello there!</span></div></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any,calls:string[]=[],statuses:any[]=[];let available=false;w.setInterval=()=>0;
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible'}),cachedIncoming:async()=>undefined,
  translateIncoming:async(p:any)=>{calls.push(p.text);if(!available)throw new Error('登录状态已过期，请重新登录。');return '已恢复的译文'},reportConversation(){},reportStatus(s:any){statuses.push(s)}};
 try{
  w.eval(whatsappInjectionScript);await wait(()=>Boolean(w.document.querySelector('[data-rt-history-action]')));
  available=true;w.document.querySelector('[data-rt-history-action]').click();await wait(()=>Boolean(w.document.querySelector('.rt-translation')));
  w.document.querySelector('#main').insertAdjacentHTML('beforeend','<div class="message-in" data-id="false_peer@c.us_b"><span class="selectable-text">How was your afternoon?</span></div>');
  await wait(()=>w.document.querySelectorAll('.rt-translation').length===2);
  assert.equal(calls.filter(text=>text==='How was your afternoon?').length,1);assert.ok(statuses.some(s=>s.state==='ready'&&s.message==='翻译已恢复'));
 }finally{dom.window.close()}
});

test('a direct contact with a comma still translates captions and fallback bodies while real groups remain disabled',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="George, California" dir="auto">George, California</span></header><div class="message-in" data-id="false_peer@c.us_a"><span data-testid="media-caption">What a beautiful picture! 😍</span></div><div class="message-in" data-id="false_peer@c.us_b"><div data-pre-plain-text="time"><div>Hello there!<time>12:01</time></div></div></div><footer><div contenteditable="true" role="textbox"></div></footer></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any,calls:string[]=[],intervals:Function[]=[];w.setInterval=(fn:Function)=>{intervals.push(fn);return intervals.length};
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:false,localLanguage:'zh-CN',historyMode:'visible'}),cachedIncoming:async()=>undefined,translateIncoming:async(p:any)=>{calls.push(p.text);return '这是译文'},reportConversation(){},reportStatus(){}};
 try{w.eval(whatsappInjectionScript);await wait(()=>w.document.querySelectorAll('.rt-translation').length===2);
  assert.deepEqual(calls.sort(),['Hello there!','What a beautiful picture! 😍'].sort());
  w.document.querySelectorAll('[data-id]').forEach((el:any)=>el.setAttribute('data-id',el.getAttribute('data-id').replace('peer@c.us','group@g.us')));
  w.__RT_REFRESH_TRANSLATIONS__();await wait(()=>w.document.querySelector('[data-rt-history-action]'));assert.equal(calls.length,2);
 }finally{dom.window.close()}
});

test('same English text with curly quotes never appears as a duplicated translation',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="Peer">Peer</span></header><div class="message-out" data-id="true_peer@c.us_a"><span class="selectable-text">You\'re very direct, George!</span></div></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any;w.setInterval=()=>0;w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:true}),cachedIncoming:async()=>"You’re very direct, George！",reportConversation(){},reportStatus(){}};
 try{w.eval(whatsappInjectionScript);await wait(()=>w.document.querySelector('[data-rt-translated="done"]'));assert.equal(w.document.querySelector('.rt-translation'),null)}finally{dom.window.close()}
});

test('a stale authentication pause rechecks access after cooldown without a manual click',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="Peer">Peer</span></header><div class="message-in" data-id="false_peer@c.us_a"><span class="selectable-text">Hello there!</span></div></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any;let clock=Date.now(),available=false,calls=0;w.Date.now=()=>clock;w.setInterval=()=>0;
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible'}),cachedIncoming:async()=>undefined,
  translateIncoming:async()=>{calls++;if(!available)throw Error('登录状态已过期，请重新登录。');return '恢复后的译文'},reportConversation(){},reportStatus(){}};
 try{
  w.eval(whatsappInjectionScript);await wait(()=>Boolean(w.document.querySelector('[data-rt-history-action]')));
  available=true;clock+=60001;
  // A normal DOM update triggers the same periodic scanner, not the recovery action.
  w.document.querySelector('#main').appendChild(w.document.createElement('aside'));
  await wait(()=>Boolean(w.document.querySelector('.rt-translation')));assert.equal(calls,2);
 }finally{w.close()}
});

test('empty translation results remain retryable and cannot silently mark a history message done',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="Peer">Peer</span></header><div class="message-in" data-id="false_peer@c.us_a"><span class="selectable-text">Hello there!</span></div></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any;let available=false;w.setInterval=()=>0;
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible'}),cachedIncoming:async()=>undefined,
  translateIncoming:async()=>available?'有效译文':undefined,reportConversation(){},reportStatus(){}};
 try{
  w.eval(whatsappInjectionScript);await wait(()=>Boolean(w.document.querySelector('[data-rt-history-action]')));
  assert.equal(w.document.querySelector('[data-rt-translated="done"]'),null);
  available=true;w.document.querySelector('[data-rt-history-action]').click();await wait(()=>Boolean(w.document.querySelector('.rt-translation')));
 }finally{w.close()}
});

test('a failed visible message does not starve other history and retries automatically after cooldown',async()=>{
 const dom=new JSDOM('<div id="main"><header><span title="Peer">Peer</span></header>'+Array.from({length:7},(_,i)=>'<div class="message-in" data-id="false_peer@c.us_'+i+'"><span class="selectable-text">History message '+i+'</span></div>').join('')+'</div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'});
 const w=dom.window as any,calls:string[]=[];let available=false,clock=Date.now();w.Date.now=()=>clock;w.setInterval=()=>0;
 w.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:true,groupTranslate:true,historyMode:'visible'}),cachedIncoming:async()=>undefined,
  translateIncoming:async(p:any)=>{calls.push(p.messageId);if(p.messageId.endsWith('_6')&&!available)throw Error('翻译服务暂时繁忙，本次未扣费。');return '历史译文'},reportConversation(){},reportStatus(){}};
 try{
  w.eval(whatsappInjectionScript);await wait(()=>w.document.querySelectorAll('.rt-translation').length===6);
  available=true;clock+=60001;w.document.querySelector('#main').appendChild(w.document.createElement('aside'));
  await wait(()=>w.document.querySelectorAll('.rt-translation').length===7);
  assert.equal(calls.length,8);assert.equal(calls.filter(id=>id.endsWith('_6')).length,2);
 }finally{w.close()}
});
