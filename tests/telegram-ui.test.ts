import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mainHarness } from './main-harness'
import { JSDOM } from 'jsdom'
import { telegramConversation, telegramMessageId } from '../src/shared/telegramIdentity'
const modules=mainHarness()
const { telegramInjectionScript } = modules.load('src/main/platforms/telegram/inject/script.ts') as typeof import('../src/main/platforms/telegram/inject/script')
const { installTelegramBootstrapGuard } = modules.load('src/main/platforms/telegram/bootstrapGuard.ts') as typeof import('../src/main/platforms/telegram/bootstrapGuard')
after(()=>{assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);rmSync(modules.directory,{recursive:true,force:true})})

const tick = () => new Promise(resolve => setTimeout(resolve, 15))
async function until(check: () => boolean) { for (let n=0;n<200;n++){ if(check())return;await tick() } assert.fail('Telegram UI did not settle') }
type Options = { original?: string; translation?: string; receipt?: boolean; clear?: boolean; preview?: boolean; history?: string; incoming?: boolean; delayTranslation?: boolean; caption?: boolean; closeCaption?: boolean; delaySettings?: boolean; blockCommit?: boolean; oldHistory?: boolean; tailOffscreen?: boolean; initiallyHidden?: boolean }
function harness(options: Options = {}) {
  const caption = options.caption ? '<div class="Modal"><img src="blob:photo-a"><div id="editable-message-text-modal" contenteditable="true">图片说明</div><button class="caption-send"><i class="icon-new-send"></i></button></div>' : ''
  const dom=new JSDOM('<div id="LeftColumn"></div><div id="MiddleColumn"><div class="chat-info"><div class="title">Example</div></div><div class="MessageList"><div class="Message" data-message-id="10"><div class="message-content"><div class="text-content">Hello<span class="MessageMeta">12:30</span></div></div></div></div><div class="Composer"><div id="editable-message-text" contenteditable="true"></div><button class="main-button send"><i class="icon-new-send"></i></button></div></div>'+caption,{url:'https://web.telegram.org/a/#12345',runScripts:'outside-only',pretendToBeVisual:true})
  const win=dom.window as any,document=win.document,composer=document.querySelector(options.caption?'#editable-message-text-modal':'#editable-message-text')
  if(options.initiallyHidden)Object.defineProperty(document,'hidden',{configurable:true,value:true})
  const list=document.querySelector('.MessageList'),container=document.createElement('div');container.className='messages-container';while(list.firstChild)container.append(list.firstChild);list.append(container)
  if(!options.oldHistory){const marker=document.createElement('div');marker.className='list-bottom-marker';container.append(marker)}
  const originalRect=win.HTMLElement.prototype.getBoundingClientRect
  win.HTMLElement.prototype.getBoundingClientRect=function(){if(this.matches('.MessageList'))return {x:0,y:0,top:0,left:0,right:800,bottom:600,width:800,height:600};if(this.matches('.list-bottom-marker')){const top=options.tailOffscreen?1000:590;return {x:0,y:top,top,left:0,right:1,bottom:top,width:1,height:0}}return originalRect.call(this)}
  composer.textContent=options.original??'你好'
  const button=document.querySelector(options.caption?'.caption-send':'.main-button')
  let nativeClicks=0,submits=0,prepares=0,cached=0,settingsCalls=0,translations=0,confirmedSent=0,confirmedNotSent=0,task:any,release!:()=>void,releaseSettings!:()=>void
  const payloads:any[]=[], originalTimeout=win.setTimeout.bind(win), gate=options.delayTranslation?new Promise<void>(resolve=>release=resolve):Promise.resolve(),settingsGate=options.delaySettings?new Promise<void>(resolve=>releaseSettings=resolve):Promise.resolve()
  win.setTimeout=(fn:any,ms:number)=>originalTimeout(fn,ms===180||ms===250?2:ms)
  const intervals:any[]=[];win.setInterval=(fn:any)=>{intervals.push(fn);return intervals.length};win.clearInterval=()=>{}
  document.execCommand=(_command:string,_ui:boolean,value:string)=>{composer.textContent=value;return true}
  win.realtimeTranslator={
    getRuntimeSettings:async()=>{settingsCalls++;await settingsGate;return {receiveAutoTranslate:options.incoming,groupTranslate:true,historyMode:options.history||'manual',previewSend:Boolean(options.preview)}},
    reportConversation:()=>{},reportStatus:()=>{},reportConnection:()=>{},reportUnread:()=>{},
    pendingSend:async()=>task&&!['sent','cancelled'].includes(task.state)?task:null,
    pendingSends:async()=>task&&!['sent','cancelled'].includes(task.state)?[structuredClone(task)]:[],
    confirmSent:async(id:string)=>{assert.equal(id,task.id);assert.equal(task.state,'uncertain');confirmedSent++;task.state='sent';return structuredClone(task)},
    confirmNotSent:async(id:string)=>{assert.equal(id,task.id);assert.equal(task.state,'uncertain');confirmedNotSent++;task.state='ready';return structuredClone(task)},
    prepareSend:async(value:any)=>{prepares++;task={...value,id:'tg-task-'+prepares,state:'draft',request:{text:value.text,targetLanguage:'en'},translated:options.translation||'Hello'};return task},
    translateSend:async()=>{translations++;await gate;task.state='ready';return task},
    editSendPreview:async(_id:string,value:string)=>{task.translated=value;return task},
    submitSend:async()=>{
      submits++;const args={...task,original:task.request.text,targetLanguage:'en'}
      if(!win.__RT_SEND_SELECT__(args))throw new Error('send selection rejected')
      assert.equal(win.__RT_EDIT_ATOMIC__({expected:composer.textContent,text:task.translated,targetKey:task.targetKey,conversationId:task.conversationId}),true)
      if(options.blockCommit)button.disabled=true
      const result=await win.__RT_SEND_COMMIT__(args);win.__RT_SEND_RELEASE__(task.id,result.dispatched===false)
      task.result=result;task.state=result.confirmed?'sent':result.dispatched===false?'ready':'uncertain';return structuredClone(task)
    },
    cachedIncoming:async()=>{cached++;return undefined},
    translateIncoming:async(value:any)=>{payloads.push(value);return '你好'},
    saveDraft:async()=>{},getDraft:async()=>'',
    translateVoiceMessage:async()=>{throw new Error('audio should require explicit user action')}
  }
  button.addEventListener('click',()=>{
    nativeClicks++;if(options.clear!==false)composer.textContent=''
    if(options.closeCaption)document.querySelector('.Modal')?.remove()
    if(options.receipt!==false){const row=document.createElement('div');row.className='Message own';row.dataset.messageId=String(100+nativeClicks);row.innerHTML='<div class="message-content"><div class="text-content"></div><span class="MessageMeta"><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></span></div>';row.querySelector('.text-content').textContent=task?.translated||'';document.querySelector('.MessageList').append(row)}
  })
  win.eval(telegramInjectionScript)
  const click=()=>button.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}))
  return {dom,win,document,composer,button,click,release:()=>release(),releaseSettings:()=>releaseSettings(),payloads,stats:()=>({nativeClicks,submits,prepares,cached,settingsCalls,translations,confirmedSent,confirmedNotSent}),task:()=>task,close:()=>{win.dispatchEvent(new win.PageTransitionEvent('pagehide'));win.close()}}
}

test('Telegram hidden tabs report unread without settings reads or mounting translations and resume on visibility',async()=>{
  const h=harness({initiallyHidden:true,incoming:true,history:'visible'});try{
    const unread:number[]=[];h.win.realtimeTranslator.reportUnread=(value:number)=>unread.push(value);h.document.title='(4) Telegram';h.document.body.classList.add('new-message');
    await until(()=>unread.includes(4));assert.equal(h.stats().settingsCalls,0);assert.equal(h.payloads.length,0);assert.equal(h.document.querySelector('[data-rt-ui="translation"]'),null);
    Object.defineProperty(h.document,'hidden',{configurable:true,value:false});h.document.dispatchEvent(new h.win.Event('visibilitychange'));
    await until(()=>h.payloads.length===1);assert.equal(h.stats().settingsCalls,1);
  }finally{h.close()}
})
test('Telegram an in-flight send can settle after its window becomes hidden',async()=>{
  const h=harness({delayTranslation:true});try{
    h.click();await until(()=>h.stats().prepares===1);Object.defineProperty(h.document,'hidden',{configurable:true,value:true});h.document.dispatchEvent(new h.win.Event('visibilitychange'));h.release();
    await until(()=>h.task()?.state==='sent');assert.equal(h.stats().nativeClicks,1);assert.equal(h.composer.textContent,'');
  }finally{h.close()}
})
const reconcileButton=(h:ReturnType<typeof harness>,sent:boolean)=>Array.from(h.document.querySelectorAll('[data-rt-ui="send-reconcile"] button') as NodeListOf<HTMLButtonElement>).find(item=>item.textContent===(sent?'我已核对，已经发送':'我已核对，尚未发送'))!
test('Telegram manual sent confirmation closes only the original task without any additional send or translation',async()=>{
  const h=harness({receipt:false});try{
    h.click();await until(()=>h.task()?.state==='uncertain'&&Boolean(reconcileButton(h,true)));const id=h.task().id;
    const panel=h.document.querySelector('[data-rt-ui="send-reconcile"]');assert.equal(panel.parentElement,h.document.body);assert.equal(panel.querySelectorAll('.hd-tg-reconcile-actions button').length,2);assert.ok(panel.querySelector('.hd-tg-reconcile-content'));assert.match(panel.textContent,/先查看当前 Telegram 官网聊天记录/);reconcileButton(h,true).click();await until(()=>h.task().state==='sent');
    assert.equal(h.task().id,id);assert.equal(h.stats().confirmedSent,1);assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().prepares,1);assert.equal(h.stats().translations,1);assert.equal(h.composer.textContent,'');
  }finally{h.close()}
})
test('Telegram manual not-sent confirmation restores the original and preserves task/translation without auto retry',async()=>{
  const h=harness({receipt:false});try{
    h.click();await until(()=>h.task()?.state==='uncertain'&&Boolean(reconcileButton(h,false)));const id=h.task().id;reconcileButton(h,false).click();await until(()=>h.task().state==='ready'&&h.composer.textContent==='你好');
    assert.equal(h.task().id,id);assert.equal(h.task().translated,'Hello');assert.equal(h.stats().confirmedNotSent,1);assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().prepares,1);assert.equal(h.stats().translations,1);assert.equal(h.stats().submits,1);
  }finally{h.close()}
})
test('Telegram a submitting task cannot be unlocked by a stale uncertain confirmation',async()=>{
  const h=harness({receipt:false});try{
    h.click();await until(()=>h.task()?.state==='uncertain'&&Boolean(reconcileButton(h,false)));const oldButton=reconcileButton(h,false);h.task().state='submitting';oldButton.click();await until(()=>/发送仍在处理中|仍在处理发送/.test(h.document.querySelector('[data-rt-ui="send-reconcile"]').textContent));
    assert.equal(h.stats().confirmedNotSent,0);assert.equal(h.task().state,'submitting');assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().translations,1);
  }finally{h.close()}
})
test('Telegram stale confirmation cannot restore drafts or update a task after changing conversation during its status check',async()=>{
  const h=harness({receipt:false});try{
    h.click();await until(()=>h.task()?.state==='uncertain'&&Boolean(reconcileButton(h,false)));const oldButton=reconcileButton(h,false);
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);h.win.realtimeTranslator.pendingSends=async()=>{await gate;return [structuredClone(h.task())]};oldButton.click();h.win.location.hash='#98765';h.win.dispatchEvent(new h.win.HashChangeEvent('hashchange'));h.composer.textContent='新聊天草稿';release();await tick();await tick();oldButton.click();await tick();
    assert.equal(h.stats().confirmedNotSent,0);assert.equal(h.stats().confirmedSent,0);assert.equal(h.task().state,'uncertain');assert.equal(h.composer.textContent,'新聊天草稿');assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().translations,1);
  }finally{h.close()}
})
test('Telegram numeric peer and thread identity never depends on chat names',()=>{
  assert.deepEqual(telegramConversation('#-10009_42'),{id:'telegram:-10009:42',peer:'-10009',route:'-10009_42',writable:true,group:true})
  assert.equal(telegramConversation('#123')?.id,'telegram:123:0')
  assert.equal(telegramConversation('#123_scheduled')?.writable,false)
  assert.equal(telegramConversation('#alice'),undefined)
  assert.equal(telegramConversation('#123_abc'),undefined)
  assert.equal(telegramConversation('#123?foo=bar')?.id,'telegram:123:0')
  assert.equal(telegramMessageId('-123'),undefined)
  assert.equal(telegramMessageId('12.5'),undefined)
  assert.equal(telegramMessageId('123'),'123')
})

test('Telegram sends translated text once and confirms only a new official receipt',async()=>{
  const h=harness();try{h.click();await until(()=>h.task()?.state==='sent');assert.equal(h.stats().nativeClicks,1);assert.equal(h.task().result.messageId,'telegram:12345:0:101');assert.equal(h.task().conversationId,'telegram:12345:0');assert.equal(h.task().request.text,'你好')}finally{h.close()}
})
test('Telegram preview is editable and nothing sends until explicit confirmation',async()=>{
  const h=harness({preview:true});try{h.click();await until(()=>Boolean(h.document.querySelector('.hd-tg-preview')));assert.equal(h.stats().nativeClicks,0);h.document.querySelector('textarea').value='How are you?';(Array.from(h.document.querySelectorAll('.hd-tg-preview button')).find((node:any)=>node.textContent==='发送译文') as HTMLButtonElement).dispatchEvent(new h.win.MouseEvent('click',{bubbles:true}));await until(()=>h.task()?.state==='sent');assert.equal(h.task().translated,'How are you?');assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram blocks Chinese left in English target translation',async()=>{
  const h=harness({translation:'你好 Hello'});try{h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('rejected'));assert.equal(h.stats().nativeClicks,0);assert.equal(h.composer.textContent,'你好')}finally{h.close()}
})
test('Telegram receipt uncertainty does not re-click send even when editor was cleared',async()=>{
  const h=harness({receipt:false});try{h.click();await until(()=>h.task()?.state==='uncertain');assert.equal(h.stats().nativeClicks,1);h.composer.textContent='你好';h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('不会自动重发'));assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().prepares,1)}finally{h.close()}
})
test('Telegram uncertainty blocks a translated draft left in the composer as well as its source',async()=>{
  const h=harness({receipt:false,clear:false});try{h.click();await until(()=>h.task()?.state==='uncertain');assert.equal(h.composer.textContent,'Hello');h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('不会自动重发'));assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().prepares,1)}finally{h.close()}
})
test('Telegram unresolved older send blocks a different source with the same potential translation before any new paid task',async()=>{
  const h=harness({receipt:false});try{
    h.click();await until(()=>h.task()?.state==='uncertain');const id=h.task().id;h.composer.textContent='您好';h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('上一条消息结果待确认'));
    const late=h.document.createElement('div');late.className='Message own';late.dataset.messageId='201';late.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></div>';h.document.querySelector('.MessageList').append(late);await tick();
    assert.equal(h.task().id,id);assert.equal(h.task().state,'uncertain');assert.equal(h.stats().nativeClicks,1);assert.equal(h.stats().prepares,1);assert.equal(h.stats().translations,1);assert.equal(h.composer.textContent,'您好');assert.ok(reconcileButton(h,true));
  }finally{h.close()}
})
test('Telegram restores original draft when the native send cannot begin after translated insertion',async()=>{
  const h=harness({blockCommit:true});try{h.click();await until(()=>h.task()?.result?.dispatched===false);assert.equal(h.composer.textContent,'你好');assert.equal(h.stats().nativeClicks,0);assert.equal(h.task().translated,'Hello')}finally{h.close()}
})
test('Telegram pending receipt is insufficient and a later server receipt can reconcile without sending',async()=>{
  const h=harness({receipt:false});try{h.click();await until(()=>h.task()?.state==='uncertain');const row=h.document.createElement('div');row.className='Message own';row.dataset.messageId='201';row.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-message-pending"></i></div></div>';h.document.querySelector('.MessageList').append(row);const probe={...h.task().result,translated:'Hello'};assert.equal(h.win.__RT_SEND_PROBE__(probe),null);row.querySelector('i').className='icon-check';assert.equal(h.win.__RT_SEND_PROBE__(probe).messageId,'telegram:12345:0:201');assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram older equal-text outgoing history is never accepted as the current send receipt',async()=>{
  const h=harness({receipt:false});try{h.click();await until(()=>h.task()?.state==='uncertain');const row=h.document.createElement('div');row.className='Message own';row.dataset.messageId='9';row.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></div>';h.document.querySelector('.MessageList').prepend(row);assert.equal(h.task().result.watermark,'10');assert.equal(h.win.__RT_SEND_PROBE__({...h.task().result,translated:'Hello'}),null);assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram older viewport cannot confirm a newer equal-text historical receipt loaded after sending',async()=>{
  const h=harness({oldHistory:true,receipt:false});try{h.click();await until(()=>h.task()?.state==='uncertain');assert.equal(h.task().result.atLatestTail,false);const row=h.document.createElement('div');row.className='Message own';row.dataset.messageId='500';row.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></div>';h.document.querySelector('.messages-container').append(row);const marker=h.document.createElement('div');marker.className='list-bottom-marker';h.document.querySelector('.messages-container').append(marker);assert.equal(h.win.__RT_SEND_PROBE__({...h.task().result,translated:'Hello'}),null);assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram latest marker offscreen cannot authorize automatic send confirmation',async()=>{
  const h=harness({tailOffscreen:true});try{h.click();await until(()=>h.task()?.state==='uncertain');assert.equal(h.task().result.atLatestTail,false);assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram receipt watermark is refreshed immediately before dispatch after a slow translation',async()=>{
  const h=harness({delayTranslation:true,receipt:false});try{h.click();await until(()=>Boolean(h.task()));const row=h.document.createElement('div');row.className='Message own';row.dataset.messageId='500';row.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></div>';h.document.querySelector('.messages-container').append(row);h.release();await until(()=>h.task()?.state==='uncertain');assert.equal(h.task().result.watermark,'500');assert.equal(h.task().result.atLatestTail,true);assert.equal(h.win.__RT_SEND_PROBE__({...h.task().result,translated:'Hello'}),null);assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram switching chat during translation preserves original and prevents sending',async()=>{
  const h=harness({delayTranslation:true});try{h.click();await until(()=>Boolean(h.task()));h.win.location.hash='#999';h.release();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('变化'));assert.equal(h.stats().nativeClicks,0);assert.equal(h.composer.textContent,'你好')}finally{h.close()}
})
test('Telegram changing a photo during caption translation prevents sending to changed attachments',async()=>{
  const h=harness({caption:true,delayTranslation:true});try{h.click();await until(()=>Boolean(h.task()));h.document.querySelector('.Modal img').src='blob:photo-b';h.release();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('变化'));assert.equal(h.stats().nativeClicks,0)}finally{h.close()}
})
test('Telegram caption uses its own editor and stays attached to official photo flow',async()=>{
  const h=harness({caption:true,original:'你好'});try{h.document.querySelector('#editable-message-text').textContent='另一个草稿';h.click();await until(()=>h.task()?.state==='sent');assert.match(h.task().targetKey,/editable-message-text-modal$/);assert.equal(h.document.querySelector('#editable-message-text').textContent,'另一个草稿');assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram confirms an image caption after the official modal closes',async()=>{
  const h=harness({caption:true,closeCaption:true});try{h.click();await until(()=>h.task()?.state==='sent');assert.equal(h.document.querySelector('.Modal'),null);assert.equal(h.task().result.messageId,'telegram:12345:0:101');assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram reconciles an uncertain image caption after modal dismissal without resending',async()=>{
  const h=harness({caption:true,closeCaption:true,receipt:false});try{h.click();await until(()=>h.task()?.state==='uncertain');const row=h.document.createElement('div');row.className='Message own';row.dataset.messageId='221';row.innerHTML='<div class="message-content"><div class="text-content">Hello</div><div class="MessageOutgoingStatus"><i class="icon-check"></i></div></div>';h.document.querySelector('.MessageList').append(row);assert.equal(h.win.__RT_SEND_PROBE__({...h.task().result,translated:'Hello'}).messageId,'telegram:12345:0:221');assert.equal(h.stats().nativeClicks,1)}finally{h.close()}
})
test('Telegram preserves intentional authored line breaks without adding paragraphs',async()=>{
  const h=harness({original:'第一行\n第二行',translation:'First line\nSecond line'});try{h.click();await until(()=>h.task()?.state==='sent');assert.equal(h.task().request.text,'第一行\n第二行');assert.equal(h.task().translated,'First line\nSecond line')}finally{h.close()}
})
test('Telegram receive translation preserves different message IDs for identical text',async()=>{
  const h=harness({incoming:true,history:'visible'});try{await until(()=>h.payloads.length===1);const row=h.document.querySelector('.Message').cloneNode(true);row.dataset.messageId='11';row.querySelector('[data-rt-ui]')?.remove();h.document.querySelector('.MessageList').append(row);await until(()=>h.payloads.length===2);assert.notEqual(h.payloads[0].messageId,h.payloads[1].messageId);assert.equal(h.payloads[0].text,'Hello');assert.equal(h.payloads[1].text,'Hello');await tick();await tick();assert.equal(h.payloads.length,2)}finally{h.close()}
})
test('Telegram new-only translation skips initial history and translates later rows only',async()=>{
  const h=harness({incoming:true,history:'new'});try{await until(()=>Boolean(h.document.querySelector('[data-rt-ui="translation"]')));await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(h.payloads.length,0);const row=h.document.querySelector('.Message').cloneNode(true);row.dataset.messageId='12';row.querySelector('[data-rt-ui]')?.remove();h.document.querySelector('.MessageList').append(row);await until(()=>h.payloads.length===1);assert.equal(h.payloads[0].messageId,'telegram:12345:0:12')}finally{h.close()}
})
test('Telegram new-only mode does not bill delayed initial history or older scrollback',async()=>{
  const h=harness({incoming:true,history:'new'});try{
    const list=h.document.querySelector('.MessageList'),row=list.querySelector('.Message').cloneNode(true);list.textContent='';await tick();await tick();assert.equal(h.payloads.length,0)
    list.append(row);await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(h.payloads.length,0)
    const older=row.cloneNode(true);older.dataset.messageId='8';older.querySelector('[data-rt-ui]')?.remove();list.prepend(older);await tick();await tick();assert.equal(h.payloads.length,0)
    const newer=row.cloneNode(true);newer.dataset.messageId='12';newer.querySelector('[data-rt-ui]')?.remove();list.append(newer);await until(()=>h.payloads.length===1);assert.equal(h.payloads[0].messageId,'telegram:12345:0:12')
  }finally{h.close()}
})
test('Telegram own bubbles never trigger paid automatic back translation before receipt persistence',async()=>{
  const h=harness({incoming:true,history:'visible'});try{
    await until(()=>h.payloads.length===1);const row=h.document.querySelector('.Message').cloneNode(true);row.dataset.messageId='99';row.classList.add('own');row.querySelector('[data-rt-ui]')?.remove();h.document.querySelector('.MessageList').append(row);await until(()=>Boolean(row.querySelector('[data-rt-ui="translation"] button')));await tick();assert.equal(h.payloads.length,1)
    row.querySelector('[data-rt-ui="translation"] button').click();await until(()=>h.payloads.length===2);assert.equal(h.payloads[1].outgoing,true);assert.equal(h.payloads[1].manual,true)
  }finally{h.close()}
})
test('Telegram an edited message removes its stale translation and submits changed text under the same durable message ID',async()=>{
  const h=harness({incoming:true,history:'visible'});try{await until(()=>h.payloads.length===1);h.document.querySelector('.Message .text-content').firstChild.textContent='How are you?';await until(()=>h.payloads.length===2);assert.equal(h.payloads[0].messageId,h.payloads[1].messageId);assert.equal(h.payloads[1].text,'How are you?');assert.equal(h.document.querySelectorAll('[data-rt-ui="translation"]').length,1)}finally{h.close()}
})
test('Telegram stale message list after a route change cannot be billed or used as a send target',async()=>{
  const h=harness({incoming:true,history:'visible'});try{await until(()=>h.payloads.length===1);h.win.location.hash='#999';await tick();await tick();assert.equal(h.payloads.length,1);h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('无法确认'));assert.equal(h.stats().prepares,0);assert.equal(h.stats().nativeClicks,0);const next=h.document.querySelector('.MessageList').cloneNode(true);next.querySelector('[data-rt-ui]')?.remove();h.document.querySelector('.MessageList').replaceWith(next);await until(()=>h.payloads.length===2);assert.equal(h.payloads[1].conversationId,'telegram:999:0')}finally{h.close()}
})
test('Telegram binds initial list before slow runtime settings so a route change cannot claim old DOM',async()=>{
  const h=harness({incoming:true,history:'visible',delaySettings:true});try{assert.equal(h.stats().settingsCalls,1);h.win.location.hash='#999';await tick();h.releaseSettings();await tick();await tick();assert.equal(h.payloads.length,0);h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('无法确认'));assert.equal(h.stats().prepares,0)}finally{h.close()}
})
test('Telegram canonical and thread route aliases share the same list owner',async()=>{
  const h=harness();try{h.win.location.hash='#12345_thread';await tick();h.composer.textContent='';assert.equal(h.win.__RT_INSERT_DRAFT__('Hello'),true);assert.equal(h.composer.textContent,'Hello')}finally{h.close()}
})
test('Telegram quick reply never overwrites an existing draft and fills an empty editor only',async()=>{
  const h=harness();try{assert.equal(h.win.__RT_INSERT_DRAFT__('快捷回复'),false);assert.equal(h.composer.textContent,'你好');h.composer.textContent='';assert.equal(h.win.__RT_INSERT_DRAFT__('快捷回复'),true);assert.equal(h.composer.textContent,'快捷回复');assert.equal(h.stats().nativeClicks,0)}finally{h.close()}
})
test('Telegram connection reports use the main-process accepted status vocabulary',async()=>{
  const h=harness();try{const states:string[]=[];h.win.realtimeTranslator.reportConnection=(value:string)=>states.push(value);const auth=h.document.createElement('div');auth.className='Auth';h.document.body.append(auth);await until(()=>states.includes('login-required'));auth.remove();await until(()=>states.includes('page-ready'));Object.defineProperty(h.win.navigator,'onLine',{value:false});h.win.__RT_RESUME_TRANSLATIONS__();await until(()=>states.includes('offline'))}finally{h.close()}
})
test('Telegram voice action stays inside bubble and never starts automatically',async()=>{
  const h=harness();try{const row=h.document.querySelector('.Message');row.querySelector('.text-content').remove();const audio=h.document.createElement('div');audio.className='Audio';audio.innerHTML='<div class="waveform"></div><div class="voice-duration">0:18</div>';row.querySelector('.message-content').append(audio);await until(()=>Boolean(row.querySelector('[data-rt-ui="voice"]')));const box=row.querySelector('[data-rt-ui="voice"]');assert.equal(box.parentElement.className,'message-content');assert.equal(box.querySelector('button').textContent,'转为中文');assert.ok(box.querySelector('[data-voice-english]'));assert.ok(box.querySelector('[data-voice-chinese]'));await tick();assert.equal(row.querySelectorAll('[data-rt-ui="voice"]').length,1)}finally{h.close()}
})
test('Telegram IME Enter never sends and Shift Enter remains native newline',async()=>{
  const h=harness();try{h.composer.dispatchEvent(new h.win.CompositionEvent('compositionstart',{bubbles:true}));h.composer.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}));await tick();assert.equal(h.stats().prepares,0);h.composer.dispatchEvent(new h.win.CompositionEvent('compositionend',{bubbles:true}));const event=new h.win.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});h.composer.dispatchEvent(event);assert.equal(event.defaultPrevented,false);assert.equal(h.stats().prepares,0)}finally{h.close()}
})

test('Telegram owned audio produces English and Chinese inside its voice bubble exactly once',async()=>{
  const h=harness();try{
    const row=h.document.querySelector('.Message');row.querySelector('.text-content').remove();row.querySelector('.message-content').innerHTML='<div class="Audio"><div class="waveform"></div><audio src="blob:https://web.telegram.org/owned-voice"></audio></div>'
    h.win.AbortSignal=AbortSignal
    h.win.fetch=async()=>{let sent=false;return {ok:true,headers:{get:()=>null},body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:new Uint8Array([1,2,3])}),cancel:async()=>{}})}}}
    h.win.AudioContext=class{decodeAudioData(){return Promise.resolve({duration:1})}close(){return Promise.resolve()}}
    h.win.OfflineAudioContext=class{destination={};createBufferSource(){return {connect(){},start(){}}}startRendering(){return Promise.resolve({getChannelData:()=>new Float32Array(16000).fill(.05)})}}
    const calls:any[]=[]
    h.win.realtimeTranslator.translateVoiceMessage=async(value:any)=>{calls.push(value);return {text:'Hello',englishTranslation:'Hello',translation:'你好',targetLanguage:'zh-CN',audioId:'a'.repeat(64)}}
    await until(()=>Boolean(row.querySelector('[data-rt-ui="voice"]')))
    row.querySelector('[data-rt-ui="voice"] button').click()
    await until(()=>row.querySelector('[data-voice-chinese]')?.textContent==='中文：你好')
    assert.equal(calls.length,1);assert.equal(calls[0].conversationId,'telegram:12345:0');assert.equal(calls[0].messageId,'voice:telegram:12345:0:10');assert.equal(calls[0].bytes.byteLength,32044)
    assert.equal(row.querySelector('[data-voice-english]').textContent,'English: Hello')
    assert.equal(row.querySelector('[data-rt-ui="voice"]').parentElement.className,'message-content')
    await tick();assert.equal(calls.length,1)
  }finally{h.close()}
})

test('Telegram detached global audio is never assigned to an unrelated voice message',async()=>{
  const h=harness();try{
    const row=h.document.querySelector('.Message');row.querySelector('.text-content').remove();row.querySelector('.message-content').innerHTML='<div class="Audio"><div class="waveform"></div></div>'
    const global=h.document.createElement('audio');global.src='blob:https://web.telegram.org/other-message';h.document.body.append(global)
    let fetched=0;h.win.fetch=async()=>{fetched++;throw new Error('must not read global audio')}
    h.win.HTMLInputElement.prototype.click=function(){this.dispatchEvent(new h.win.Event('cancel'))}
    await until(()=>Boolean(row.querySelector('[data-rt-ui="voice"]')));row.querySelector('[data-rt-ui="voice"] button').click()
    await until(()=>row.querySelector('[data-rt-ui="voice"]').textContent.includes('已取消'))
    assert.equal(fetched,0)
  }finally{h.close()}
})

test('Telegram bootstrap blocks text and caption send until the translator is installed',()=>{
  const dom=new JSDOM('<div class="Composer"><div id="editable-message-text" contenteditable="true">你好</div><button class="main-button send"></button><button class="main-button record"></button></div><div class="Modal"><div id="editable-message-text-modal" contenteditable="true">说明</div><button class="caption"><i class="icon-new-send"></i></button></div>',{url:'https://web.telegram.org/a/',runScripts:'outside-only'})
  const win=dom.window as any;let blocked=0;win.__ready=false;win.__blocked=()=>blocked++
  try{
    win.eval('('+installTelegramBootstrapGuard.toString()+')(()=>window.__ready,window.__blocked)')
    for(const selector of ['.main-button.send','.caption']){const event=new win.MouseEvent('click',{bubbles:true,cancelable:true});win.document.querySelector(selector).dispatchEvent(event);assert.equal(event.defaultPrevented,true)}
    const recording=new win.MouseEvent('click',{bubbles:true,cancelable:true});win.document.querySelector('.record').dispatchEvent(recording);assert.equal(recording.defaultPrevented,false)
    const enter=new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});win.document.querySelector('#editable-message-text').dispatchEvent(enter);assert.equal(enter.defaultPrevented,true);assert.equal(blocked,3)
    win.__ready=true;const ready=new win.MouseEvent('click',{bubbles:true,cancelable:true});win.document.querySelector('.send').dispatchEvent(ready);assert.equal(ready.defaultPrevented,false)
  }finally{win.close()}
})

test('Telegram unknown send icons fail closed while known pure-photo sending remains native',async()=>{
  const h=harness();try{h.button.className='new-unknown-send';let propagated=0;h.button.addEventListener('click',()=>propagated++);h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('暂不支持'));assert.equal(propagated,0);assert.equal(h.stats().nativeClicks,0)}finally{h.close()}
  const media=harness({caption:true,original:''});try{media.click();await tick();assert.equal(media.stats().nativeClicks,1);assert.equal(media.stats().prepares,0)}finally{media.close()}
})
test('Telegram icon-free edit, scheduled and paid caption submission buttons cannot bypass translation protection',async()=>{
  for(const label of ['Save','Next','⭐ 10']){
    const h=harness({caption:true});try{h.button.innerHTML=label;h.button.className='_send_abc_42';h.click();await until(()=>h.document.querySelector('.hd-tg-status')?.textContent.includes('暂不支持'));assert.equal(h.stats().nativeClicks,0);assert.equal(h.composer.textContent,'你好')}finally{h.close()}
  }
})
