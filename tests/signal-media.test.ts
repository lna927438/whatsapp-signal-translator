import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { mainHarness } from './main-harness.ts'
import { byteRange, normalizeAttachments, signalNeedsTranslation, signalMediaEntries, signalAttachmentFilename } from '../src/shared/signalMedia.ts'

test('gallery entries retain conversation identity, newest-first order, photo extensions and expiration boundaries',()=>{
  const image={id:'one',filename:'附件',contentType:'IMAGE/JPEG; charset=binary',size:12}
  const rows=signalMediaEntries([{peer:'a',timestamp:1,attachments:[image]},{peer:'a',timestamp:3,attachments:[image]},{peer:'b',timestamp:2,attachments:[image]},{peer:'a',timestamp:4,attachments:[image],expiresAt:5}],6)
  assert.deepEqual(rows.map(item=>item.timestamp),[3,2,1]);assert.equal(new Set(rows.map(item=>item.key)).size,3)
  assert.ok(rows.every(item=>item.filename==='附件.jpg'&&item.contentType==='image/jpeg'))
  assert.equal(signalAttachmentFilename({...image,filename:'../../CON'}),'Signal-CON.jpg')
  assert.equal(signalAttachmentFilename({...image,filename:'holiday.jpg'}),'holiday.jpg')
})

test('staged files survive source removal and restart, retaining names with owner and account isolation', async () => {
  const h = mainHarness(), { SignalMediaStore } = h.load('src/main/platforms/signal/signalMediaStore.ts')
  try {
    const store = new SignalMediaStore(), original = join(h.directory, 'holiday.png')
    await writeFile(original, Buffer.from('media-data'))
    const attachment = await store.stage('owner-a','signal-a',{ path:original, filename:'holiday.png' })
    await rm(original)
    const recovered = await new SignalMediaStore().get('owner-a','signal-a',attachment.id)
    assert.equal(basename(recovered.path),'holiday.png'); assert.equal((await readFile(recovered.path)).toString(),'media-data')
    await assert.rejects(store.get('owner-b','signal-a',attachment.id)); await assert.rejects(store.get('owner-a','signal-b',attachment.id))
    await assert.rejects(store.get('owner-a','signal-a','../../secret'))
    await assert.rejects(store.validate('owner-a','signal-a',{ attachments:[attachment.id,attachment.id] }))
    await assert.rejects(store.validate('owner-a','signal-a',{ attachments:[attachment.id],voiceNote:true }))
  } finally { await rm(h.directory,{recursive:true,force:true}) }
})

test('media send intent is durable and submitted once; empty caption and emoji do not call translation', async () => {
  const h = mainHarness(), { SendTasks } = h.load('src/main/translation/sendTasks.ts')
  let data:any = {tasks:[]}, calls = 0
  const storage = {read:async()=>structuredClone(data),write:async(value:any)=>{data=structuredClone(value)}}
  const tasks = new SendTasks(storage), input:any = { platform:'signal',accountId:'a',conversationId:'signal:+12025550123',signalAccount:'+12025550100',recipient:'+12025550123',intentId:'media-intent-12345',signalPayload:{attachments:['local-11111111-1111-1111-1111-111111111111']},request:{text:'',targetLanguage:'en'},translate:false,blockChinese:true }
  try {
    const one = await tasks.prepare('owner',input)
    assert.equal((await tasks.prepare('owner',input)).id,one.id)
    await assert.rejects(tasks.prepare('owner',{...input,signalPayload:{attachments:['different-file']}}),/不一致/)
    await tasks.translate('owner',one.id,async()=>{throw new Error('must not translate media')},()=>true)
    const restarted = new SendTasks(storage)
    await Promise.all([restarted.submit('owner',one.id,async()=>{ calls++; return {timestamp:123} },()=>true),restarted.submit('owner',one.id,async()=>{calls++;return{}},()=>true)])
    assert.equal(calls,1); assert.equal((await restarted.get('owner',one.id)).translated,'')
    assert.equal(signalNeedsTranslation('😂❤️👍 123'),false); assert.equal(signalNeedsTranslation('你好 😂'),true)
  } finally { await rm(h.directory,{recursive:true,force:true}) }
})

test('media streaming supports seek ranges and revokes access when account changes or message expires', async () => {
  const h = mainHarness(), {grantSignalMedia,serveSignalMedia,clearSignalMediaGrants} = h.load('src/main/platforms/signal/signalMediaProtocol.ts')
  try {
    const path = join(h.directory,'sample.mp4'); await writeFile(path,Buffer.from('0123456789'))
    let allowed = true; const url = grantSignalMedia(path,'video/mp4',async()=>allowed)
    const result = await serveSignalMedia(new Request(url,{headers:{Range:'bytes=3-6'}}))
    assert.equal(result.status,206); assert.equal(await result.text(),'3456'); assert.equal(result.headers.get('content-range'),'bytes 3-6/10')
    assert.equal((await serveSignalMedia(new Request(url,{headers:{Range:'bytes=30-'}}))).status,416)
    allowed=false; assert.equal((await serveSignalMedia(new Request(url))).status,403)
    allowed=true; clearSignalMediaGrants(); assert.equal((await serveSignalMedia(new Request(url))).status,403)
    assert.throws(()=>grantSignalMedia(path,'text/html',async()=>true))
  } finally { await rm(h.directory,{recursive:true,force:true}) }
})

test('incoming media retains dimensions and voice flags; invalid attachment paths and invalid byte ranges are rejected', () => {
  assert.deepEqual(normalizeAttachments([{id:'photo-1',filename:'voice.ogg',contentType:'audio/ogg',size:100,isVoiceNote:true,width:10,height:20},{id:'../../secret'}]),[{id:'photo-1',filename:'voice.ogg',contentType:'audio/ogg',size:100,isVoiceNote:true,width:10,height:20}])
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9,partial:true})
  for(const range of ['bytes=5-1','bytes=-0','bytes=0-1,3-4','bad','bytes=-']) assert.equal(byteRange(range,10),null)
})
