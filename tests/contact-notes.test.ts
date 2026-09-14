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
