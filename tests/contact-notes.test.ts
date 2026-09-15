import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {mainHarness} from './main-harness.ts'
import {JSDOM} from 'jsdom'
import {createRequire} from 'node:module'
const {whatsappContactScript,parseWhatsAppPresence}=createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/contactDetails.ts')
const settle=()=>new Promise(resolve=>setTimeout(resolve,120))
test('contact notes are encrypted, account/owner/peer scoped, revision checked and independent from account notes',async()=>{
 const h=mainHarness();try{const {ContactNotes}=h.load('src/main/storage/contactNotes.ts'),{AccountManager}=h.load('src/main/accounts/accountManager.ts'),s=new ContactNotes(),a=new AccountManager()
  const account=await a.add('whatsapp','Work',undefined,{note:'Alias',caption:'Red account note'})
  await s.save('owner',account.id,'peer:123@c.us','Contact-specific red note',0)
  assert.equal((await s.get('other',account.id,'peer:123@c.us')).text,'');assert.equal((await s.get('owner','other','peer:123@c.us')).text,'');assert.equal((await s.get('owner',account.id,'peer:456@c.us')).text,'')
  await assert.rejects(s.save('owner',account.id,'peer:123@c.us','stale',0),/另一处/)
  const saved=(await a.list())[0];assert.equal(saved.note,'Alias');assert.equal(saved.caption,'Red account note')
  assert.equal((await new ContactNotes().get('owner',account.id,'peer:123@c.us')).text,'Contact-specific red note')
  assert.ok(readFileSync(join(h.directory,'contact-notes-v1.json'),'utf8').startsWith('hellodog-encrypted-v1:'))
  await s.save('owner',account.id,'peer:123@c.us','',1);assert.equal((await s.get('owner',account.id,'peer:123@c.us')).text,'')
  assert.throws(()=>s.save('owner',account.id,'title:Alex','wrong identity',0));assert.throws(()=>s.save('owner',account.id,'peer:123@c.us','a'.repeat(501),2))
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('presence recognizes native states without interpreting names or group members as online status',()=>{
 assert.equal(parseWhatsAppPresence('typing...').text,'正在输入…');assert.equal(parseWhatsAppPresence('online').kind,'online');assert.equal(parseWhatsAppPresence('last seen today at 01:36').text,'最后上线：今天 01:36')
 assert.equal(parseWhatsAppPresence('Online sales group'),undefined);assert.equal(parseWhatsAppPresence('Alex, Ben, me'),undefined);assert.equal(parseWhatsAppPresence(''),undefined)
})
test('contact header updates note and presence, clears removed/hidden state and never reuses a note for a renamed or switched peer',async()=>{
 const dom=new JSDOM('<div id="main"><header><div class="title"><span title="Alex" dir="auto">Alex</span><span class="presence">online</span></div><button>Call</button></header><div data-id="false_123@c.us_one">Hello</div></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only',pretendToBeVisual:true})
 const w=dom.window as any,notes=new Map([['peer:123@c.us',{text:'Likes hiking',revision:1}]]),calls:any[]=[]
 w.realtimeTranslator={getRuntimeSettings:async()=>({uiLanguage:'zh-CN'}),getContactNote:async(key:string)=>notes.get(key)||{text:'',revision:0},saveContactNote:async(key:string,text:string,revision:number)=>{calls.push({key,text,revision});const result={text,revision:revision+1};notes.set(key,result);return result}}
 try{
  w.eval(whatsappContactScript);await settle();assert.equal(w.document.querySelector('[data-hd-presence]').textContent,'在线');assert.equal(w.document.querySelector('[data-rt-ui="contact-details"] button').textContent,'Likes hiking')
  const native=w.document.querySelector('.presence');native.textContent='typing...';await settle();assert.equal(w.document.querySelector('[data-hd-presence]').textContent,'正在输入…')
  native.textContent='last seen today at 01:36';await settle();assert.match(w.document.querySelector('[data-hd-presence]').textContent,/01:36/)
  native.hidden=true;await settle();assert.equal(w.document.querySelector('[data-hd-presence]').textContent,'')
  native.hidden=false;await settle();assert.match(w.document.querySelector('[data-hd-presence]').textContent,/01:36/)
  native.style.display='none';await settle();assert.equal(w.document.querySelector('[data-hd-presence]').textContent,'')
  native.remove();await settle();assert.equal(w.document.querySelector('[data-hd-presence]').textContent,'')
  w.document.querySelector('[data-rt-ui="contact-details"] button').click();w.document.querySelector('textarea').value='<img src=x onerror=alert(1)> red note';w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle()
  assert.equal(calls.length,1);assert.equal(calls[0].key,'peer:123@c.us');assert.equal(w.document.querySelector('[data-rt-ui="contact-details"] img'),null)
  const title=w.document.querySelector('span[title]');title.title='Renamed';title.textContent='Renamed';w.__HD_SYNC_CONTACT_DETAILS__();await settle();assert.match(w.document.querySelector('[data-rt-ui="contact-details"] button').textContent,/red note/)
  w.document.querySelector('[data-id]').setAttribute('data-id','false_456@c.us_other');w.__HD_SYNC_CONTACT_DETAILS__();await settle();assert.equal(w.document.querySelector('[data-rt-ui="contact-details"] button').textContent,'＋联系人备注')
  assert.equal(w.document.querySelectorAll('[data-rt-ui="contact-details"]').length,1)
 }finally{dom.window.close()}
})

function contactList(options:{keys?:string[];active?:string;notes?:[string,{text:string;revision:number}][]}={}) {
 const keys=options.keys||['123@c.us','456@c.us'],active=options.active||'123@c.us'
 const dom=new JSDOM('<div id="side"><div id="pane-side" role="grid">'+keys.map((key,index)=>
  '<div role="row"'+(key?' data-id="'+key+'"':'')+' aria-selected="'+(index===0)+'" style="height:72px;display:flex">'+
  '<div data-testid="cell-frame-main" style="display:flex;flex-direction:column;gap:2px;justify-content:center">'+
  '<div class="title-line" style="display:flex"><span title="Alex" dir="auto">Alex</span><span class="time">10:30</span></div>'+
  '<div class="last-message">Original preview '+index+'</div></div><button class="native-menu">Menu</button></div>').join('')+
  '</div></div><div id="main"><header style="min-height:64px;display:flex"><div style="display:flex;flex-direction:column"><span title="Alex" dir="auto">Alex</span><span class="presence">online</span></div><button class="call">Call</button></header><div class="message" data-id="false_'+active+'_one">Hello</div></div>',
  {url:'https://web.whatsapp.com',runScripts:'outside-only',pretendToBeVisual:true})
 const w=dom.window as any,notes=new Map(options.notes||[['peer:123@c.us',{text:'First contact note',revision:1}],['peer:456@c.us',{text:'Second contact note',revision:2}]]),reads:string[]=[],writes:any[]=[],navigations:number[]=[]
 const rows=Array.from(w.document.querySelectorAll('[role="row"]')) as HTMLElement[]
 for(const [index,row] of rows.entries())row.addEventListener('click',()=>navigations.push(index))
 w.realtimeTranslator={getRuntimeSettings:async()=>({uiLanguage:'zh-CN'}),getContactNote:async(peer:string)=>{reads.push(peer);return notes.get(peer)||{text:'',revision:0}},
  saveContactNote:async(peer:string,text:string,revision:number)=>{if((notes.get(peer)?.revision||0)!==revision)throw new Error('备注已在另一处修改，请重新打开查看后再保存。');const value={text:text.trim(),revision:revision+1};writes.push({peer,text,revision});notes.set(peer,value);return value}}
 return {dom,w,rows,notes,reads,writes,navigations,install:()=>w.eval(whatsappContactScript),sync:()=>w.__HD_SYNC_CONTACT_DETAILS__(),
  note:(index:number)=>rows[index].querySelector('[data-rt-ui="contact-list-note"] button') as HTMLButtonElement,
  headerNote:()=>w.document.querySelector('[data-rt-ui="contact-details"] button') as HTMLButtonElement,
  select:(index:number,peer:string)=>{rows.forEach((row,i)=>row.setAttribute('aria-selected',String(i===index)));w.document.querySelector('.message').setAttribute('data-id','false_'+peer+'_message')},
  save:async(text:string)=>{const area=w.document.querySelector('textarea');assert.ok(area,'note editor must be open');area.value=text;w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle()}}
}

test('each same-name contact gets a separate red list note below the name; saving synchronizes its own header',async()=>{
 const h=contactList();try{
  const nativeMenu=h.rows[0].querySelector('.native-menu'),preview=h.rows[0].querySelector('.last-message'),call=h.w.document.querySelector('.call')
  h.install();await settle()
  assert.equal(h.note(0).textContent,'First contact note');assert.equal(h.note(1).textContent,'Second contact note')
  assert.equal(h.headerNote().textContent,'First contact note')
  assert.equal(h.w.getComputedStyle(h.note(0)).color,'rgb(255, 133, 141)')
  const root=h.note(0).parentElement!,titleLine=h.rows[0].querySelector('.title-line')!
  assert.equal(titleLine.nextElementSibling,root);assert.equal(root.nextElementSibling,preview)
  h.note(0).click();assert.deepEqual(h.navigations,[]);await h.save('Shared first contact note')
  assert.equal(h.note(0).textContent,'Shared first contact note');assert.equal(h.headerNote().textContent,'Shared first contact note');assert.equal(h.note(1).textContent,'Second contact note')
  h.note(1).click();await h.save('Independent second contact note')
  assert.equal(h.note(1).textContent,'Independent second contact note');assert.equal(h.headerNote().textContent,'Shared first contact note')
  assert.deepEqual(h.writes.map(write=>write.peer),['peer:123@c.us','peer:456@c.us']);assert.deepEqual(h.navigations,[])
  assert.equal(h.rows[0].querySelector('.native-menu'),nativeMenu);assert.equal(h.rows[0].querySelector('.last-message'),preview);assert.equal(h.w.document.querySelector('.call'),call)
  assert.equal(preview!.textContent,'Original preview 0');assert.equal(h.w.document.querySelector('[data-hd-presence]').textContent,'在线')
 }finally{h.dom.window.close()}
})

test('saving from the header updates the matching list row and clearing removes only that contact note',async()=>{
 const h=contactList();try{
  h.install();await settle();h.headerNote().click();await h.save('Header edit')
  assert.equal(h.note(0).textContent,'Header edit');assert.equal(h.note(1).textContent,'Second contact note')
  h.headerNote().click();await h.save('')
  assert.equal(h.note(0).textContent,'＋联系人备注');assert.equal(h.headerNote().textContent,'＋联系人备注');assert.equal(h.note(1).textContent,'Second contact note')
 }finally{h.dom.window.close()}
})

test('virtual row reuse changes stable identity, closes a stale editor and never attaches its previous note',async()=>{
 const h=contactList();try{
  h.install();await settle();h.note(1).click();assert.ok(h.w.document.querySelector('dialog'))
  h.notes.set('peer:789@c.us',{text:'Third contact',revision:1})
  h.rows[1].setAttribute('data-id','789@c.us');h.sync();await settle()
  assert.equal(h.w.document.querySelector('dialog'),null);assert.equal(h.note(1).textContent,'Third contact');assert.equal(h.note(1).getAttribute('data-hd-note-peer'),'peer:789@c.us')
  assert.equal(h.rows[1].querySelectorAll('[data-rt-ui="contact-list-note"]').length,1);assert.equal(h.headerNote().textContent,'First contact note')
  assert.equal(h.writes.length,0)
  h.rows[1].remove();h.sync();assert.equal(h.w.document.querySelectorAll('[data-rt-ui="contact-list-note"]').length,1)
 }finally{h.dom.window.close()}
})

test('a delayed note read cannot overwrite a reused row after a different contact has loaded',async()=>{
 const h=contactList({active:'999@c.us'}),pending:Array<(value:any)=>void>=[]
 const get=h.w.realtimeTranslator.getContactNote
 h.w.realtimeTranslator.getContactNote=(peer:string)=>peer==='peer:123@c.us'?new Promise(resolve=>pending.push(resolve)):get(peer)
 try{
  h.install();h.rows[0].setAttribute('data-id','456@c.us');h.sync();await settle()
  assert.equal(h.note(0).textContent,'Second contact note')
  for(const resolve of pending)resolve({text:'Late first contact',revision:20});await settle()
  assert.equal(h.note(0).textContent,'Second contact note');assert.equal(h.note(0).getAttribute('data-hd-note-peer'),'peer:456@c.us')
 }finally{h.dom.window.close()}
})

test('contact rename preserves a stable identity and updates the accessible editor label',async()=>{
 const h=contactList();try{
  h.install();await settle()
  const listTitle=h.rows[0].querySelector('span[title]')!,headerTitle=h.w.document.querySelector('#main span[title]')
  for(const title of [listTitle,headerTitle]){title.setAttribute('title','Alex Renamed');title.textContent='Alex Renamed'}
  h.sync();await settle();assert.equal(h.note(0).textContent,'First contact note');assert.equal(h.headerNote().textContent,'First contact note')
  assert.match(h.note(0).getAttribute('aria-label')!,/Alex Renamed/)
  h.note(0).click();await h.save('After rename');assert.equal(h.writes[0].peer,'peer:123@c.us');assert.equal(h.headerNote().textContent,'After rename')
 }finally{h.dom.window.close()}
})

test('an opaque row opens the selected chat and waits for its new stable JID even when both contacts have the same name',async()=>{
 const h=contactList({keys:['123@c.us','conversation-stable-two']});try{
  h.rows[1].addEventListener('click',()=>h.rows.forEach((row,index)=>row.setAttribute('aria-selected',String(index===1))))
  h.install();await settle();assert.equal(h.note(1).textContent,'＋联系人备注');assert.equal(h.note(1).disabled,false)
  h.note(1).click();h.sync();await settle()
  assert.equal(h.w.document.querySelector('dialog'),null,'old mounted messages must not resolve a same-name selected row')
  assert.equal(h.note(1).getAttribute('data-hd-note-peer'),'')
  h.w.document.querySelector('.message').setAttribute('data-id','false_456@c.us_new');h.sync();await settle();await settle()
  assert.equal(h.w.document.querySelector('textarea').value,'Second contact note')
  await h.save('Learned second contact');assert.equal(h.note(1).textContent,'Learned second contact');assert.equal(h.headerNote().textContent,'Learned second contact')
  h.select(0,'123@c.us');h.sync();await settle();assert.equal(h.note(1).textContent,'Learned second contact')
  const navigations=h.navigations.length;h.note(1).click();assert.equal(h.navigations.length,navigations,'a learned stable row can be edited without navigating')
  await h.save('Edit without navigating');assert.equal(h.headerNote().textContent,'First contact note')
  h.rows[1].setAttribute('data-id','conversation-stable-three');h.sync();await settle();assert.equal(h.note(1).getAttribute('data-hd-note-peer'),'');assert.equal(h.note(1).textContent,'＋联系人备注')
 }finally{h.dom.window.close()}
})

test('unkeyed or index-keyed virtual rows never retain a note after they stop identifying the selected chat',async()=>{
 for(const key of ['', '7']){
  const h=contactList({keys:[key,'456@c.us']});try{
   h.install();await settle();assert.equal(h.note(0).textContent,'First contact note')
   h.select(1,'456@c.us');h.w.document.querySelector('#pane-side').dispatchEvent(new h.w.Event('scroll'));h.sync();await settle()
   assert.equal(h.note(0).getAttribute('data-hd-note-peer'),'');assert.equal(h.note(0).textContent,'＋联系人备注')
   h.rows[0].querySelector('.last-message')!.textContent='Reused virtual row';h.sync();await settle();assert.equal(h.note(0).textContent,'＋联系人备注')
  }finally{h.dom.window.close()}
 }
})

test('a contact JID in a message preview cannot identify an unknown list row',async()=>{
 const h=contactList({keys:['123@c.us','conversation-unknown']});try{
  h.rows[1].querySelector('.last-message')!.innerHTML='<span data-jid="123@c.us"><a href="https://wa.me/123">Preview mentioning another person</a></span>'
  h.install();await settle();assert.equal(h.note(1).getAttribute('data-hd-note-peer'),'');assert.equal(h.note(1).textContent,'＋联系人备注')
  assert.equal(h.rows[1].querySelectorAll('[data-rt-ui="contact-list-note"]').length,1)
 }finally{h.dom.window.close()}
})

test('a revision conflict preserves the newer stored note and reloads it for a deliberate edit',async()=>{
 const h=contactList();try{
  h.install();await settle();h.note(0).click();h.notes.set('peer:123@c.us',{text:'Saved elsewhere',revision:2})
  await h.save('Stale draft');assert.equal(h.notes.get('peer:123@c.us')!.text,'Saved elsewhere');assert.equal(h.writes.length,0)
  assert.match(h.w.document.querySelector('dialog [role="status"]').textContent,/另一处/);assert.equal(h.w.document.querySelector('textarea').value,'Stale draft')
  h.w.document.querySelector('dialog button[type="button"]').click();h.note(0).click();assert.equal(h.w.document.querySelector('textarea').value,'Saved elsewhere')
  await h.save('Reviewed new note');assert.equal(h.note(0).textContent,'Reviewed new note');assert.equal(h.headerNote().textContent,'Reviewed new note');assert.equal(h.writes[0].revision,2)
 }finally{h.dom.window.close()}
})

test('removing the injection restores native styles, previews and controls without leaving added rows',async()=>{
 const h=contactList();try{
  h.install();await settle();assert.equal(h.w.document.querySelector('#main header').style.minHeight,'76px')
  h.w.dispatchEvent(new h.w.Event('pagehide'))
  assert.equal(h.w.document.querySelectorAll('[data-rt-ui="contact-list-note"],[data-rt-ui="contact-details"]').length,0)
  assert.equal(h.w.document.querySelector('#main header').style.minHeight,'64px')
  assert.equal(h.rows[0].querySelector<HTMLElement>('[data-testid="cell-frame-main"]')!.style.gap,'2px')
  assert.equal(h.rows[0].querySelector('.last-message')!.textContent,'Original preview 0');assert.ok(h.w.document.querySelector('.native-menu'));assert.ok(h.w.document.querySelector('.call'))
 }finally{h.dom.window.close()}
})

test('a minimal native header keeps injected details inside its own boundary and does not move call controls',async()=>{
 const h=contactList();try{
  h.w.document.querySelector('#main header').innerHTML='<span title="Alex" dir="auto">Alex</span><button class="call">Call</button>'
  const header=h.w.document.querySelector('#main header'),call=header.querySelector('.call')
  h.install();await settle();assert.equal(h.headerNote().parentElement?.parentElement,header);assert.equal(call.nextElementSibling,h.headerNote().parentElement)
  assert.equal(h.w.document.querySelector('.messages [data-rt-ui="contact-details"]'),null)
  h.w.dispatchEvent(new h.w.Event('pagehide'));h.w.dispatchEvent(new h.w.Event('online'));await settle()
  assert.equal(h.w.document.querySelector('[data-rt-ui="contact-details"]'),null);assert.equal(header.style.flexWrap,'')
 }finally{h.dom.window.close()}
})
