import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mainHarness } from './main-harness.ts'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { BackgroundAccountStatus } = require('../src/main/network/backgroundAccountStatus.ts')
const { SendTasks, SendPendingError } = require('../src/main/translation/sendTasks.ts')

test('routine sends never wait on cloud account checks; confirmed disabled state still applies', async () => {
  let resolve: (value:any) => void = () => {}, checks = 0
  const status = new BackgroundAccountStatus(async () => { checks++; return new Promise(r => { resolve = r }) })
  status.setIdentity('owner','token')
  for (let i = 0; i < 5; i++) status.assertAvailable()
  assert.equal(checks,1)
  resolve({user:{id:'owner'},profile:{status:'disabled'}}); await status.refresh()
  assert.throws(() => status.assertAvailable(), /账号状态/)
  status.setIdentity('next','next-token'); status.assertAvailable()
  resolve({user:{id:'next'},profile:{status:'active'}}); await status.refresh(); status.assertAvailable()
})

test('late send evidence settles a durable pending task without another dispatch or translation', async () => {
  let data:any = {tasks:[]}, reads = 0, writes = 0
  const tasks = new SendTasks({read:async()=>{reads++;return structuredClone(data)},write:async(next:any)=>{writes++;data=structuredClone(next)}})
  const task = await tasks.prepare('owner',{platform:'whatsapp',accountId:'a',conversationId:'wa:alex',targetKey:'peer:alex@c.us',translate:false,blockChinese:false,request:{text:'hello',targetLanguage:'en-US'}})
  await tasks.translate('owner',task.id,async()=>assert.fail(),()=>true)
  let dispatches=0
  const result = await tasks.submit('owner',task.id,async()=>{dispatches++;throw new SendPendingError({baseline:['old'],targetKey:'peer:alex@c.us'})},()=>true)
  assert.equal(result.state,'uncertain')
  const writeCount = writes
  await tasks.pending('owner','a','wa:alex','peer:alex@c.us'); await tasks.get('owner',task.id)
  assert.equal(writes,writeCount); assert.ok(reads > 0)
  await tasks.resolveWithEvidence('owner',task.id,{queued:true,messageId:'observed-id'})
  assert.equal((await tasks.submit('owner',task.id,async()=>{dispatches++},()=>true)).state,'sent')
  assert.equal(dispatches,1)
  await tasks.expireMessage('owner',task.id)
  await tasks.translate('owner',task.id,async()=>assert.fail('A completed disappearing task must never translate again'),()=>true)
  assert.equal((await tasks.get('owner',task.id)).request.text,'')
})

test('Signal retains a late RPC response for background reconciliation without reissuing the request', async () => {
  const h = mainHarness()
  const { SignalCli } = h.load('src/main/platforms/signal/signalCli.ts')
  const cli:any = new SignalCli(); const written:string[] = [], late:any[] = []
  cli.child = {killed:false,stdin:{write(value:string){written.push(value)}},kill(){}}
  try {
    await assert.rejects(cli.call('send',{account:'test',message:'example'},5,(value:any)=>late.push(value)), /timeout/)
    const request = JSON.parse(written[0])
    cli.onLine(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{timestamp:123,results:[{type:'SUCCESS'}]}}))
    assert.equal(written.length,1); assert.equal(late[0].timestamp,123)
  } finally { cli.stop(); await rm(h.directory,{recursive:true,force:true}) }
})

test('different messages with identical translations cannot borrow each other\'s WhatsApp receipt', async () => {
  let data:any = {tasks:[]}
  const tasks = new SendTasks({read:async()=>structuredClone(data),write:async(next:any)=>{data=structuredClone(next)}})
  const prepare = (text:string) => tasks.prepare('owner',{platform:'whatsapp',accountId:'a',conversationId:'wa:alex',targetKey:'peer:alex@c.us',translate:true,blockChinese:false,request:{text,targetLanguage:'en-US'}})
  const first = await prepare('早上好')
  await tasks.translate('owner',first.id,async()=> 'Good morning',()=>true)
  await tasks.submit('owner',first.id,async()=>{throw new SendPendingError({baseline:['old'],targetKey:'peer:alex@c.us'})},()=>true)
  const second = await prepare('早安')
  assert.notEqual(first.id,second.id)
  await tasks.translate('owner',second.id,async()=> 'Good morning',()=>true)
  assert.equal((await tasks.resolveWithEvidence('owner',first.id,{queued:true,messageId:'new'})).state,'uncertain')
  await tasks.submit('owner',second.id,async()=>({queued:true,messageId:'new'}),()=>true)
  assert.equal((await tasks.resolveWithEvidence('owner',first.id,{queued:true,messageId:'new'})).state,'uncertain')
  assert.equal((await tasks.get('owner',second.id)).state,'sent')
})

test('expired Signal content cannot be restored by a late translation and retains only billing metadata', async () => {
  const h = mainHarness()
  try {
    const { TranslationCache } = h.load('src/main/translation/cache.ts'), { TranslationReceipts } = h.load('src/main/translation/receipts.ts')
    const cache = new TranslationCache(), receipts = new TranslationReceipts()
    const request = {text:'private message',sourceLanguage:'en-US',targetLanguage:'zh-CN',requestId:'request-1',messageId:'peer:123',accountId:'a',conversationId:'signal:peer',cacheUserId:'owner',context:[{role:'incoming',text:'private context'}]}
    await receipts.prepare('owner','openai',request); await receipts.update('owner','request-1',{state:'charged',chargedCharacters:15,translated:'private translation'})
    await cache.set('openai',request,'private translation')
    await cache.expire('owner','a','peer:123'); await receipts.expireMessage('owner','a','signal:peer','peer:123')
    await cache.set('openai',request,'late private translation'); await receipts.update('owner','request-1',{translated:'late private translation'})
    assert.equal(await cache.get('openai',request),undefined)
    const receipt = await receipts.get('owner','request-1')
    assert.equal(receipt.chargedCharacters,15); assert.equal(receipt.request.text,''); assert.equal(receipt.translated,undefined)
    const disk = await readFile(join(h.directory,'translation-receipts-v1.json'),'utf8')
    assert.ok(!disk.includes('private message')); assert.ok(!disk.includes('private translation')); assert.ok(!disk.includes('private context'))
    await assert.rejects(receipts.prepare('owner','openai',request),/已过期/)
  } finally { await rm(h.directory,{recursive:true,force:true}) }
})
