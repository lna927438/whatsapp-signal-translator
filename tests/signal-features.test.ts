import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mainHarness } from './main-harness.ts'

async function fixture() {
  let owner = 'owner-1'
  const handlers = new Map<string, Function>(), calls: any[] = []
  const saved: any[] = [], copied: any[] = [], menus: any[] = []
  const frame = {}, sender = {id:1, mainFrame:frame}
  let saveChoice: any = { canceled:true }, menuChoice = ''
  const electron: any = { app: { getPath: () => h.directory }, ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) },
    dialog: {showSaveDialog:async(_window:any,options:any)=>{saved.push(options);return typeof saveChoice==='function'?saveChoice():saveChoice}},
    nativeImage:{createFromBuffer:(bytes:Buffer)=>({isEmpty:()=>!bytes.length,toPNG:()=>bytes})},
    ClipboardItem:class{constructor(public data:any){}},clipboard:{write:async(items:any[])=>copied.push(Buffer.from(await items[0].data['image/png'].arrayBuffer()))},
    Menu:{buildFromTemplate:(items:any[])=>{menus.push(items);return{popup:({callback}:any)=>{const item=items.find(item=>item.label===menuChoice);item?.click();callback()}}}}
  }
  const h = mainHarness(electron)
  const { AccountManager } = h.load('src/main/accounts/accountManager.ts')
  const accounts = new AccountManager()
  const record = await accounts.add('signal', 'Signal A', '+12025550100')
  const { SignalPreferencesStore } = h.load('src/main/storage/signalPreferences.ts')
  const signal: any = { preferences: new SignalPreferencesStore(), request: async (...args:any[]) => { calls.push(args); return [] }, listContacts: async () => [], loadHistory: async () => [] }
  const window: any = { webContents: { id: 1, send() {} }, isDestroyed: () => false }
  h.load('src/main/platforms/signal/signalFeatures.ts').registerSignalFeatures(window, signal, () => owner)
  const invoke = (name:string, ...args:any[]) => handlers.get(name)!({sender,senderFrame:frame}, record.id, ...args)
  return { ...h, accounts, record, signal, calls, handlers, invoke, saved, copied, menus, sender, frame, setSave(value:any){saveChoice=value},setMenu(value:string){menuChoice=value},setOwner(value:string) { owner = value }, close: () => rm(h.directory, { recursive: true, force: true }) }
}

test('Signal settings, archive, color, mute and folders persist per account and login owner', async () => {
  const h = await fixture()
  try {
    await h.invoke('signal:preferences-save', {theme:'light',enterSends:false,notifications:'off'})
    await h.invoke('signal:conversation-preferences', '+12025550123', {archived:true,color:'#123abc',mutedUntil:123456})
    await h.invoke('signal:folder', {name:'Work',peers:['+1 (202) 555-0123']})
    const stored = await h.invoke('signal:preferences-get')
    assert.equal(stored.theme,'light'); assert.equal(stored.conversations['+12025550123'].archived,true)
    assert.deepEqual(Array.from(stored.folders[0].peers),['+12025550123'])
    const { SignalPreferencesStore } = h.load('src/main/storage/signalPreferences.ts')
    assert.equal((await new SignalPreferencesStore().get('owner-1', '+12025550100')).theme,'light')
    assert.equal((await new SignalPreferencesStore().get('owner-1', '+12025550999')).theme,'dark')
    h.setOwner('owner-2'); assert.equal((await h.invoke('signal:preferences-get')).theme,'dark')
    assert.equal(h.calls.length,0)
  } finally { await h.close() }
})

test('Signal contact, profile, group and block actions use the pinned upstream RPC arguments', async () => {
  const h = await fixture()
  try {
    await h.invoke('signal:contact-save', '+12025550123', {nickName:'Alex',note:'Project',expiration:86400})
    await h.invoke('signal:profile-save', {givenName:'Cristina',familyName:'',about:'Hello'})
    await h.invoke('signal:block','group:YXNkZg==',true)
    await h.invoke('signal:group-save',null,{name:'Team',members:['+12025550123']})
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[
      ['+12025550100','updateContact',{recipient:'+12025550123',nickGivenName:'Alex',nickFamilyName:'',expiration:86400}],
      ['+12025550100','updateProfile',{givenName:'Cristina',familyName:'',about:'Hello'}],
      ['+12025550100','block',{groupId:['YXNkZg==']}],
      ['+12025550100','updateGroup',{name:'Team',member:['+12025550123']}]
    ])
    assert.ok(h.calls.every((call:any[])=>call[2].note===undefined),'retired note input must never reach Signal')
    await assert.rejects(h.invoke('signal:contact-save','group:YXNkZg==',{note:'bad'}))
    await assert.rejects(h.invoke('signal:block','+12025550100',true))
    await assert.rejects(h.invoke('signal:contact-save','+12025550123',{expiration:-1}))
  } finally { await h.close() }
})

test('Signal security verification binds an explicit 60 digit safety number and never trusts all keys', async () => {
  const h = await fixture()
  try {
    await assert.rejects(h.invoke('signal:safety-verify','+12025550123','1234'))
    await h.invoke('signal:safety-verify','+12025550123','12345 '.repeat(12))
    assert.equal(h.calls[0][1],'trust'); assert.equal(h.calls[0][2].verifiedSafetyNumber.length,60)
    assert.equal(h.calls[0][2].trustAllKnownKeys,undefined)
    await assert.rejects(h.handlers.get('signal:block')!({sender:{id:99}},h.record.id,'+12025550123',true),/主窗口/)
  } finally { await h.close() }
})

test('Signal profile lookup discards results after a login owner changes', async () => {
  const h = await fixture()
  try {
    h.signal.request = async () => { h.setOwner('owner-2'); return [{number:'+12025550100',profile:{givenName:'Private'}}] }
    await assert.rejects(h.invoke('signal:profile'),/登录状态/)
  } finally { await h.close() }
})

test('attachment access must match a saved message in this account and peer', async () => {
  const h = await fixture()
  try {
    h.signal.loadHistory = async () => [{peer:'+12025550123',attachments:[{id:'owned',size:5,filename:'photo.png',contentType:'image/png'}]}]
    await assert.rejects(h.invoke('signal:attachment','+12025550124','owned',false),/没有该附件/)
    await assert.rejects(h.invoke('signal:attachment','+12025550123','../../secret',false),/没有该附件/)
    assert.equal(h.calls.length,0)
  } finally { await h.close() }
})

test('photo save retains bytes and an image extension, while copy and the native menu return cloneable results', async () => {
  const h = await fixture(), peer='+12025550123'
  try {
    const path=join(h.directory,'received-opaque'), destination=join(h.directory,'saved.png'), bytes=Buffer.from('photo-fixture')
    await writeFile(path,bytes)
    h.signal.loadHistory=async()=>[{peer,attachments:[{id:'owned',filename:'附件',contentType:'image/png',size:bytes.length}]}]
    h.signal.media={received:async()=>path}
    h.setSave({canceled:false,filePath:destination})
    const saved=await h.invoke('signal:media-action',peer,'owned','save')
    assert.deepEqual(structuredClone(saved),{action:'save',success:true})
    assert.deepEqual(await readFile(destination),bytes);assert.equal(h.saved[0].defaultPath,join(h.directory,'附件.png'))
    assert.equal((await h.invoke('signal:media-action',peer,'owned','copy')).success,true);assert.deepEqual(h.copied[0],bytes)
    h.setMenu('复制图片');assert.equal((await h.invoke('signal:media-action',peer,'owned','menu')).action,'copy')
    assert.equal(h.copied.length,2);assert.deepEqual(Array.from(h.menus[0],(item:any)=>item.label),['复制图片','保存附件'])
    h.setSave({canceled:true});assert.equal((await h.invoke('signal:media-action',peer,'owned','save')).action,'cancelled')
    assert.equal(h.calls.length,0)
  } finally { await h.close() }
})

test('photo actions reject child frames and expired or switched-owner attachments before copying or saving', async () => {
  const h = await fixture(), peer='+12025550123'
  try {
    const path=join(h.directory,'photo'), destination=join(h.directory,'must-not-save.png')
    await writeFile(path,'photo-fixture')
    h.signal.loadHistory=async()=>[{peer,attachments:[{id:'owned',filename:'p.png',contentType:'image/png',size:13}]}]
    h.signal.media={received:async()=>path}
    await assert.rejects(h.handlers.get('signal:media-action')!({sender:h.sender,senderFrame:{}},h.record.id,peer,'owned','copy'),/主窗口/)
    await assert.rejects(h.invoke('signal:media-action','+12025550999','owned','copy'),/没有该附件/)
    h.setSave(()=>{h.setOwner('owner-2');return{canceled:false,filePath:destination}})
    await assert.rejects(h.invoke('signal:media-action',peer,'owned','save'),/登录状态/)
    assert.equal(await stat(destination).then(()=>true,()=>false),false);assert.equal(h.copied.length,0)
    h.setOwner('owner-1');h.signal.loadHistory=async()=>[]
    await assert.rejects(h.invoke('signal:media-action',peer,'owned','menu'),/没有该附件/)
  } finally { await h.close() }
})
