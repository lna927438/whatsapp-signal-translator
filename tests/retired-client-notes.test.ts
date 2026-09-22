import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {mainHarness} from './main-harness'

test('retiring notes removes only retired fields and exact note files, preserving account and recovery data',async()=>{
  const h=mainHarness()
  try {
    const account={id:'wa-1',platform:'whatsapp',label:'Work',note:'old',caption:'old caption',createdAt:1,translationProvider:'deepseek',contactLanguages:{peer:{language:'en-US',name:'Official name',updatedAt:1}},proxySecret:'private'}
    writeFileSync(join(h.directory,'accounts.json'),JSON.stringify([account]))
    writeFileSync(join(h.directory,'contact-notes-v1.json'),'old encrypted note bytes')
    writeFileSync(join(h.directory,'contact-notes-v1.json.tmp'),'old temporary note bytes')
    writeFileSync(join(h.directory,'translation-receipts-v1.json'),'unchanged receipt bytes')
    writeFileSync(join(h.directory,'drafts-v1.json'),'unchanged draft bytes')
    await h.load('src/main/storage/retireLegacyNotes.ts').retireLegacyNotes()
    const [saved]=JSON.parse(readFileSync(join(h.directory,'accounts.json'),'utf8'))
    const {note,caption,...expected}=account
    assert.deepEqual(saved,expected)
    for(const name of ['contact-notes-v1.json','contact-notes-v1.json.tmp'])assert.equal(existsSync(join(h.directory,name)),false)
    assert.equal(readFileSync(join(h.directory,'translation-receipts-v1.json'),'utf8'),'unchanged receipt bytes')
    assert.equal(readFileSync(join(h.directory,'drafts-v1.json'),'utf8'),'unchanged draft bytes')
    await h.load('src/main/storage/retireLegacyNotes.ts').retireLegacyNotes()
    assert.deepEqual(JSON.parse(readFileSync(join(h.directory,'accounts.json'),'utf8')),[expected])
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})

test('old note patches cannot restore retired note fields and invalid color/channel leaves settings unchanged',async()=>{
  const h=mainHarness()
  try {
    const {AccountManager}=h.load('src/main/accounts/accountManager.ts'),accounts=new AccountManager()
    const record=await accounts.add('whatsapp','Work')
    await accounts.update(record.id,{note:'restore attempt',caption:'restore attempt'})
    const before=readFileSync(join(h.directory,'accounts.json'),'utf8')
    assert.equal(before.includes('restore attempt'),false)
    await assert.rejects(accounts.update(record.id,{translationColor:'not-a-color'}),/颜色/)
    await assert.rejects(accounts.update(record.id,{translationProvider:'unknown'}),/通道/)
    assert.equal(readFileSync(join(h.directory,'accounts.json'),'utf8'),before)
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})

test('retired note IPC is no longer authorized from WhatsApp guests',async()=>{
  const h=mainHarness({app:{isPackaged:false,getPath:()=>''}})
  try {
    const handlers=new Map<string,Function>(),raw={handle:(name:string,fn:Function)=>handlers.set(name,fn)}
    const {createSecureIpc}=h.load('src/main/secureIpc.ts')
    const ipc=createSecureIpc(raw,{webContents:{id:1}},{ownsSender:()=>true})
    for(const name of ['whatsapp:contact-note','whatsapp:save-contact-note']){
      ipc.handle(name,()=>assert.fail('Retired channel must not reach a handler'))
      const frame={url:'https://web.whatsapp.com/'}
      assert.throws(()=>handlers.get(name)!({sender:{id:7,mainFrame:frame},senderFrame:frame},'wa','peer:1@c.us'),/此操作/)
    }
  } finally {rmSync(h.directory,{recursive:true,force:true})}
})
