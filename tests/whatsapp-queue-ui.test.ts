import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {JSDOM} from 'jsdom'
const {whatsappInjectionScript}=createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/script.ts')
const tick=()=>new Promise(resolve=>setTimeout(resolve,2))
async function until(check:()=>boolean){for(let n=0;n<200;n++){if(check())return;await tick()}assert.fail('Queued UI did not settle')}
function setup(options:{shortPrepareTimeout?:boolean}={}){
 const dom=new JSDOM('<div id="main"><header><span title="Alex" dir="auto">Alex</span></header><div class="message-in" data-id="false_peer-a@c.us_old"><span class="selectable-text">hi</span></div><footer><div contenteditable="true" role="textbox"></div><button aria-label="Send">send</button></footer></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only',pretendToBeVisual:true})
 const win=dom.window as any,composer=win.document.querySelector('[contenteditable]'),button=win.document.querySelector('button')
 const tasks=new Map<string,any>(),gates=new Map<string,{resolve:Function;reject:Function}>(),submits:string[]=[],translations:string[]=[],drafts:string[]=[],intervals:Function[]=[]
 win.setInterval=(fn:Function)=>{intervals.push(fn);return intervals.length}
 // jsdom has no native editing engine; the Electron/Lexical fixture exercises it.
 win.document.execCommand=(command:string,_ui:boolean,text:string)=>{composer.textContent=command==='delete'?'':text;return true}
 if(options.shortPrepareTimeout){const timeout=win.setTimeout.bind(win);win.setTimeout=(fn:Function,ms:number)=>timeout(fn,ms===8000?10:ms)}
 let current:any,counter=0
 const api:any={reportConversation(){},reportStatus(){},getRuntimeSettings:async()=>({receiveAutoTranslate:false}),cachedIncoming:async()=>undefined,pendingSend:async()=>null,getDraft:async()=>'',saveDraft:async(_target:any,text:string)=>{drafts.push(text)},pendingSends:async()=>[...tasks.values()].filter(task=>task.state!=='sent')}
 api.prepareQueuedSend=async(payload:any)=>{const task={...payload,id:'send-'+ ++counter,state:'draft',request:{text:payload.text},translate:true};tasks.set(task.id,task);return task}
 api.translateSend=(id:string)=>{translations.push(id);return new Promise((resolve,reject)=>gates.set(id,{resolve:(text:string)=>{const task=tasks.get(id);task.translated=text;task.state='ready';resolve(task)},reject}))}
 api.submitSend=async(id:string)=>{
  current=tasks.get(id);const args={...current,original:current.request.text}
  if(!win.__RT_SEND_SELECT__(args))throw Error('wrong conversation')
  composer.textContent=current.translated
  try{const receipt=await win.__RT_SEND_COMMIT__(args);assert.equal(receipt.confirmed,true);current.state='sent';submits.push(id);return {...current,result:receipt}}
  finally{await win.__RT_SEND_RELEASE__(id,false)}
 }
 button.addEventListener('click',()=>{composer.textContent='';const node=win.document.createElement('div');node.className='message-out';node.dataset.id='true_peer-a@c.us_'+current.id;const text=win.document.createElement('span');text.className='selectable-text';text.textContent=current.translated;node.appendChild(text);win.document.querySelector('#main').insertBefore(node,win.document.querySelector('footer'))})
 win.realtimeTranslator=api;win.eval(whatsappInjectionScript)
 const type=(text:string)=>{composer.textContent=text;composer.dispatchEvent(new win.InputEvent('input',{bubbles:true,data:text}))}
 const enter=()=>composer.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
 return {dom,win,composer,tasks,gates,submits,translations,drafts,intervals,type,enter,api}
}
test('WhatsApp burst translates concurrently, dispatches in order and preserves the next draft',async()=>{
 const h=setup();try{
  h.type('first');h.enter();h.enter();await until(()=>h.translations.length===1)
  assert.equal(h.composer.textContent,'');h.type('second');h.enter();await until(()=>h.translations.length===2)
  h.type('next draft');h.gates.get('send-2')!.resolve('second translated');await tick();assert.equal(h.submits.length,0)
  h.gates.get('send-1')!.resolve('first translated');await until(()=>h.submits.length===2)
  assert.deepEqual(h.submits,['send-1','send-2']);assert.equal(h.composer.textContent,'next draft');assert.equal(h.tasks.size,2)
  assert.equal(h.win.document.querySelector('#rt-send-status'),null)
  assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null)
 }finally{h.dom.window.close()}
})

test('20 rapid messages keep distinct identities and dispatch in order even when translations finish backwards',async()=>{
 const h=setup();try{
  for(let n=1;n<=20;n++){h.type('message '+n);h.enter();h.enter();await until(()=>h.translations.length===n)}
  h.type('next unsent draft')
  for(let n=20;n>=1;n--)h.gates.get('send-'+n)!.resolve('translated '+n)
  await until(()=>h.submits.length===20)
  assert.deepEqual(h.submits,Array.from({length:20},(_,n)=>'send-'+(n+1)))
  assert.equal(h.composer.textContent,'next unsent draft');assert.equal(h.tasks.size,20)
 }finally{h.dom.window.close()}
})
test('a following Enter is accepted while the previous cleared-draft save is still pending',async()=>{
 const h=setup();try{
  const saves:Array<()=>void>=[];h.api.saveDraft=(_target:any,text:string)=>text===''?new Promise<void>(resolve=>saves.push(resolve)):Promise.resolve();
  h.type('first saved message');h.enter();await until(()=>h.composer.textContent==='');
  await tick();h.type('second independent message');h.enter();await until(()=>h.tasks.size===2);
  assert.deepEqual([...h.tasks.values()].map(t=>t.request.text),['first saved message','second independent message']);
  await until(()=>saves.length===2);saves.forEach(save=>save());
  await until(()=>h.translations.length===2);h.gates.get('send-1')!.resolve('first');h.gates.get('send-2')!.resolve('second');
  await until(()=>h.submits.length===2);
 }finally{h.dom.window.close()}
})

test('a ready translation waits for a brief typing pause before borrowing the composer',async()=>{
 const h=setup();try{
  h.type('message');h.enter();await until(()=>h.translations.length===1);
  h.type('next draft');h.gates.get('send-1')!.resolve('translated message');
  await new Promise(r=>setTimeout(r,40));assert.equal(h.submits.length,0);assert.equal(h.composer.textContent,'next draft');
  await until(()=>h.submits.length===1);assert.equal(h.composer.textContent,'next draft');
 }finally{h.dom.window.close()}
})

test('20 safe refresh preparations preserve the exact current draft and never create a translation or send',async()=>{
 const h=setup();try{
  h.type('draft with emoji 🐶 and link https://example.test')
  for(let n=0;n<20;n++){const result=await h.win.__RT_SAVE_WORKSPACE__();assert.equal(result.busy,true)}
  assert.equal(h.composer.textContent,'draft with emoji 🐶 and link https://example.test')
  assert.equal(h.translations.length,0);assert.equal(h.submits.length,0)
  h.api.saveDraft=async()=>{throw Error('disk unavailable')};await assert.rejects(h.win.__RT_SAVE_WORKSPACE__(),/disk/)
 }finally{h.dom.window.close()}
})
test('one failed translation does not deadlock the next message or lose either original',async()=>{
 const h=setup();try{
  h.type('first');h.enter();await until(()=>h.translations.length===1);h.type('second');h.enter();await until(()=>h.translations.length===2)
  h.gates.get('send-1')!.reject(Error('network timeout'));h.gates.get('send-2')!.resolve('second translated');await until(()=>h.submits.length===1)
  assert.deepEqual(h.submits,['send-2']);assert.equal(h.tasks.get('send-1').request.text,'first');assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null);assert.equal(h.composer.textContent,'first')
 }finally{h.dom.window.close()}
})

test('a refused native draft edit preserves the original and never starts translation or send',async()=>{
 const h=setup();try{
  const statuses:any[]=[];h.api.reportStatus=(s:any)=>statuses.push(s);h.win.document.execCommand=()=>false;
  h.type('keep this original');h.enter();await until(()=>statuses.some(s=>s.state==='error'));
  assert.equal(h.composer.textContent,'keep this original');assert.equal(h.translations.length,0);assert.equal(h.submits.length,0);
  assert.equal([...h.tasks.values()][0].request.text,'keep this original');
 }finally{h.dom.window.close()}
})

test('records retry keeps the original task identity without recreating a chat overlay',async()=>{
 const h=setup();try{
  h.type('retry original');h.enter();await until(()=>h.translations.length===1);h.gates.get('send-1')!.reject(Error('offline'));await tick();await tick();
  assert.equal(await h.win.__RT_RETRY_QUEUED_SEND__('send-1'),true);await until(()=>h.translations.length===2);
  h.gates.get('send-1')!.resolve('translated');await until(()=>h.submits.length===1);
  assert.equal(h.tasks.size,1);assert.deepEqual(h.translations,['send-1','send-1']);assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null);
  assert.equal(h.composer.textContent,'');
 }finally{h.dom.window.close()}
})

test('Enter on an untouched recovered draft retries the same task and does not leave a duplicate draft',async()=>{
 const h=setup();try{
  h.type('recover me');h.enter();await until(()=>h.translations.length===1);h.gates.get('send-1')!.reject(Error('offline'));
  await until(()=>h.composer.textContent==='recover me');await tick();h.enter();await until(()=>h.translations.length===2);
  assert.equal(h.tasks.size,1);h.gates.get('send-1')!.resolve('recovered');await until(()=>h.submits.length===1);assert.equal(h.composer.textContent,'');
 }finally{h.dom.window.close()}
})
test('freshly composed identical messages use distinct send intents while repeated Enter coalesces',async()=>{
 const h=setup();try{
  h.type('same');h.enter();h.enter();await until(()=>h.translations.length===1)
  h.type('same');h.enter();await until(()=>h.translations.length===2)
  assert.notEqual(h.tasks.get('send-1').intentId,h.tasks.get('send-2').intentId)
  h.gates.get('send-1')!.resolve('same');h.gates.get('send-2')!.resolve('same');await until(()=>h.submits.length===2)
 }finally{h.dom.window.close()}
})

test('the next draft is preserved even when it is identical to the preceding translation',async()=>{
 const h=setup();try{
  h.type('first');h.enter();await until(()=>h.translations.length===1)
  h.type('same translated text');h.gates.get('send-1')!.resolve('same translated text');await until(()=>h.submits.length===1)
  assert.equal(h.composer.textContent,'same translated text')
 }finally{h.dom.window.close()}
})

test('switching contacts while translating retains the message without sending to the new contact',async()=>{
 const h=setup();try{
  h.type('for Alex');h.enter();await until(()=>h.translations.length===1)
  const header=h.win.document.querySelector('header span');header.title='Blake';header.textContent='Blake'
  h.win.document.querySelector('.message-in').dataset.id='false_peer-b@c.us_old';h.type('Blake draft')
  h.gates.get('send-1')!.resolve('translated for Alex');await tick();await tick()
  assert.equal(h.submits.length,0);assert.equal(h.composer.textContent,'Blake draft');assert.equal(h.tasks.get('send-1').request.text,'for Alex')
  assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null)
 }finally{h.dom.window.close()}
})

test('restored unknown sends are not dispatched and do not block a new composed message',async()=>{
 const h=setup();try{
  h.tasks.set('send-restored',{id:'send-restored',state:'uncertain',request:{text:'old original'},conversationId:'Alex',targetKey:'peer:peer-a@c.us'})
  for(const interval of h.intervals)interval()
  await tick();await tick();assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null)
  assert.equal(h.translations.length,0);assert.equal(h.submits.length,0);assert.equal(h.win.document.querySelector('[data-rt-retry="send-restored"]'),null)
  h.type('new original');h.enter();await until(()=>h.translations.length===1)
  h.gates.get('send-1')!.resolve('new translated');await until(()=>h.submits.length===1)
  assert.deepEqual(h.submits,['send-1']);assert.equal(h.tasks.get('send-restored').state,'uncertain')
 }finally{h.dom.window.close()}
})

test('a local save timeout releases the input and retry retains the unacknowledged operation identity',async()=>{
 const h=setup({shortPrepareTimeout:true});try{
  const intents:string[]=[],statuses:any[]=[],prepare=h.api.prepareQueuedSend
  h.api.reportStatus=(value:any)=>statuses.push(value)
  h.api.prepareQueuedSend=(payload:any)=>{intents.push(payload.intentId);return intents.length===1?new Promise(()=>{}):prepare(payload)}
  h.type('saved original');h.enter();await until(()=>statuses.some(value=>value.state==='error' && value.message.includes('本地保存')))
  assert.equal(h.composer.textContent,'saved original');assert.equal(h.translations.length,0)
  h.enter();await until(()=>h.translations.length===1);assert.equal(intents.length,2);assert.equal(intents[0],intents[1])
  h.gates.get('send-1')!.resolve('translated original');await until(()=>h.submits.length===1)
 }finally{h.dom.window.close()}
})

test('IME composition and legacy Windows key code 229 never enqueue a translation',async()=>{
 for(const options of [{isComposing:true},{keyCode:229}]){
  const h=setup();try{
   h.type('正在选词');
   const event=new h.win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});
   h.composer.dispatchEvent(event);await tick();
   assert.equal(event.defaultPrevented,false);assert.equal(h.tasks.size,0);assert.equal(h.composer.textContent,'正在选词');
  }finally{h.dom.window.close()}
 }
})

test('composition events guard an unflagged Enter and paragraph event without blocking the next deliberate send',async()=>{
 const h=setup();try{
  h.type('你好');h.composer.dispatchEvent(new h.win.CompositionEvent('compositionstart',{bubbles:true}));
  h.enter();
  const paragraph=new h.win.InputEvent('beforeinput',{inputType:'insertParagraph',bubbles:true,cancelable:true});
  h.composer.dispatchEvent(paragraph);await tick();
  assert.equal(paragraph.defaultPrevented,false);assert.equal(h.tasks.size,0);assert.equal(h.composer.textContent,'你好');
  h.composer.dispatchEvent(new h.win.CompositionEvent('compositionend',{bubbles:true,data:'你好'}));
  h.composer.dispatchEvent(new h.win.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
  h.enter();await until(()=>h.translations.length===1);
  h.gates.get('send-1')!.resolve('Hello');await until(()=>h.submits.length===1);
 }finally{h.dom.window.close()}
})

test('Shift+Enter paragraph input remains a newline and a later plain Enter sends once',async()=>{
 const h=setup();try{
  h.type('line one');h.composer.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
  const paragraph=new h.win.InputEvent('beforeinput',{inputType:'insertParagraph',bubbles:true,cancelable:true});
  h.composer.dispatchEvent(paragraph);await tick();
  assert.equal(paragraph.defaultPrevented,false);assert.equal(h.tasks.size,0);
  h.composer.dispatchEvent(new h.win.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
  h.type('line one\nline two');h.enter();await until(()=>h.translations.length===1);
  assert.equal(h.tasks.get('send-1').request.text,'line one\nline two');
 }finally{h.dom.window.close()}
})

test('a delayed saved draft cannot reappear after the user types and clears the current input',async()=>{
 const h=setup();try{
  let release:(text:string)=>void=()=>{},reads=0;const insertions:string[]=[],insert=h.win.__RT_INSERT_DRAFT__;
  h.win.__RT_INSERT_DRAFT__=(text:string)=>{insertions.push(text);return insert(text)};
  h.api.getDraft=()=>{reads++;return new Promise(resolve=>{release=resolve})};
  for(const interval of h.intervals)interval();await until(()=>reads===1);
  h.type('new input');h.type('');release('old saved draft');await tick();await tick();
  assert.equal(insertions.length,0);assert.equal(h.composer.textContent,'');assert.equal(h.tasks.size,0);
 }finally{h.dom.window.close()}
})

test('a ready translation waits for the next draft IME selection and then preserves the committed text',async()=>{
 const h=setup();try{
  h.type('first original');h.enter();await until(()=>h.translations.length===1);
  h.type('ni hao');h.composer.dispatchEvent(new h.win.CompositionEvent('compositionstart',{bubbles:true}));
  h.gates.get('send-1')!.resolve('first translated');await tick();await tick();
  assert.equal(h.submits.length,0);assert.equal(h.composer.textContent,'ni hao');
  h.type('你好');h.composer.dispatchEvent(new h.win.CompositionEvent('compositionend',{bubbles:true,data:'你好'}));
  await until(()=>h.submits.length===1);assert.equal(h.composer.textContent,'你好');assert.equal(h.tasks.size,1);
 }finally{h.dom.window.close()}
})

test('a stalled draft-clear acknowledgement keeps the original task and releases later sends',async()=>{
 const h=setup({shortPrepareTimeout:true});try{
  let clears=0;const statuses:any[]=[];
  h.api.reportStatus=(value:any)=>statuses.push(value);
  h.api.saveDraft=async(_target:any,text:string)=>{if(!text&&++clears===1)return new Promise(()=>{})};
  h.type('first original');h.enter();await until(()=>statuses.some(value=>value.state==='error'));
  assert.equal(h.tasks.get('send-1').request.text,'first original');assert.equal(h.translations.length,0);
  h.type('second original');h.enter();await until(()=>h.translations.length===1);
  assert.equal(h.translations[0],'send-2');h.gates.get('send-2')!.resolve('second translated');await until(()=>h.submits.length===1);
  assert.deepEqual(h.submits,['send-2']);
 }finally{h.dom.window.close()}
})

test('dismissing an explicitly enabled preview keeps the queued original and the next draft',async()=>{
 const h=setup();try{
  h.api.getRuntimeSettings=async()=>({receiveAutoTranslate:false,previewSend:true})
  h.type('preview original');h.enter();await until(()=>h.translations.length===1)
  h.type('next draft');h.gates.get('send-1')!.resolve('preview translated')
  await until(()=>Boolean(h.win.document.querySelector('[data-rt-ui="send-preview"]')))
  const button=Array.from(h.win.document.querySelectorAll('[data-rt-ui="send-preview"] button')).find((node:any)=>node.textContent==='暂不发送') as any
  button.click();await tick();await tick();assert.equal(h.win.document.querySelector('[data-rt-ui="outbox"]'),null)
  assert.equal(h.submits.length,0);assert.equal(h.tasks.get('send-1').state,'ready');assert.equal(h.composer.textContent,'next draft');assert.equal(h.tasks.get('send-1').request.text,'preview original')
 }finally{h.dom.window.close()}
})
