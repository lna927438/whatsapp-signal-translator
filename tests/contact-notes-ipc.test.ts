import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,rmSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {mainHarness} from './main-harness.ts'

function notesIpc(){
 const harness=mainHarness(),handlers=new Map<string,Function>(),{ContactNotes}=harness.load('src/main/storage/contactNotes.ts'),{createSecureIpc}=harness.load('src/main/secureIpc.ts')
 const contactNotes=new ContactNotes(),whatsapp={ownsSender:(account:string,sender:number)=>account==='wa'&&sender===7}
 const ipcMain=createSecureIpc({handle:(name:string,handler:Function)=>handlers.set(name,handler)},{webContents:{id:1}},whatsapp)
 let owner='owner',version=0
 const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
 const selected=source.slice(source.indexOf("  ipcMain.handle('whatsapp:contact-note'"),source.indexOf("  ipcMain.handle('translator:cache-info'"))
 runInNewContext(ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ipcMain,whatsapp,contactNotes,taskIdentity:()=>{
  if(!owner)throw new Error('请先登录在线账号。')
  const captured=owner,revision=version;return{owner:captured,authorized:()=>captured===owner&&revision===version}
 }})
 const invoke=(action:string,args:unknown[],sender=7,url='https://web.whatsapp.com/',subframe=false)=>{
  const mainFrame={url},senderFrame=subframe?{url}:mainFrame
  return Promise.resolve().then(()=>handlers.get('whatsapp:'+action)!({sender:{id:sender,mainFrame},senderFrame},...args))
 }
 return{...harness,store:contactNotes,invoke,setOwner:(value:string)=>{owner=value;version++},close:()=>rmSync(harness.directory,{recursive:true,force:true})}
}

test('real secure IPC and encrypted contact store preserve separate owners, account and contacts after reload',async()=>{
 const h=notesIpc();try{
  assert.equal((await h.invoke('contact-note',['wa','peer:123@c.us'])).revision,0)
  assert.equal((await h.invoke('save-contact-note',['wa','peer:123@c.us','Contact note',0])).revision,1)
  assert.equal((await h.invoke('contact-note',['wa','peer:123@c.us'])).text,'Contact note')
  assert.equal((await h.invoke('contact-note',['wa','peer:456@lid'])).text,'')
  h.setOwner('other');assert.equal((await h.invoke('contact-note',['wa','peer:123@c.us'])).text,'')
  h.setOwner('owner');assert.equal((await h.invoke('contact-note',['wa','peer:123@c.us'])).text,'Contact note')
  await assert.rejects(h.invoke('save-contact-note',['wa','peer:123@c.us','Old revision',0]),/另一处/)
 }finally{h.close()}
})

test('real note IPC rejects untrusted frame, cross-account and logged-out access without weakening recovery',async()=>{
 const h=notesIpc();try{
  for(const args of [[['other','peer:123@c.us'],7,'https://web.whatsapp.com/',false],[['wa','peer:123@c.us'],9,'https://web.whatsapp.com/',false],[['wa','peer:123@c.us'],7,'https://example.invalid/',false],[['wa','peer:123@c.us'],7,'https://web.whatsapp.com/',true]] as const){
   await assert.rejects(h.invoke('contact-note',[...args[0]],args[1],args[2],args[3]))
  }
  h.setOwner('');await assert.rejects(h.invoke('contact-note',['wa','peer:123@c.us']),/先登录/)
  h.setOwner('owner');assert.equal((await h.invoke('contact-note',['wa','peer:123@c.us'])).text,'')
 }finally{h.close()}
})

test('a real pending note read rejects an owner change before returning decrypted data',async()=>{
 const h=notesIpc();let finish!:(value:unknown)=>void
 try{
  h.store.get=()=>new Promise(resolve=>{finish=resolve})
  const pending=h.invoke('contact-note',['wa','peer:123@c.us']);await Promise.resolve();h.setOwner('other');finish({text:'Private prior-owner note',revision:2})
  await assert.rejects(pending,/登录状态已变化/)
 }finally{h.close()}
})
