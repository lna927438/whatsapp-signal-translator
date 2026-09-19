import test from 'node:test'
import assert from 'node:assert/strict'
import type { GoogleVoiceData } from '../src/main/platforms/googleVoice/windowRecords.ts'
import type { BridgeData } from '../src/main/platforms/googleVoice/extensionBridge.ts'
import { mainHarness } from './main-harness.ts'
const h=mainHarness()
const {GoogleVoiceRecords,googleVoiceProfileRoot}=h.load('src/main/platforms/googleVoice/windowRecords.ts') as typeof import('../src/main/platforms/googleVoice/windowRecords.ts')
const {GoogleVoiceExtensionBridge,GoogleVoicePipeServer}=h.load('src/main/platforms/googleVoice/extensionBridge.ts') as typeof import('../src/main/platforms/googleVoice/extensionBridge.ts')
import { createConnection } from 'node:net'

function store<T>(initial:T){let data=structuredClone(initial);return {read:async()=>structuredClone(data),write:async(next:T)=>{data=structuredClone(next)}}}
test('Google Voice records serialize concurrent additions, isolate owners and preserve browser binding',async()=>{
  const storage=store<GoogleVoiceData>({windows:[]}),records=new GoogleVoiceRecords(storage)
  const rows=await Promise.all(Array.from({length:5},()=>records.add('owner-a')))
  await records.add('owner-b');assert.equal((await records.list('owner-a')).length,5)
  assert.equal(new Set(rows.map(row=>row.id)).size,5)
  await assert.rejects(records.get('owner-b',rows[0].id))
  await records.update('owner-a',rows[0].id,{browser:'chrome'})
  await assert.rejects(records.update('owner-a',rows[0].id,{browser:'edge'}))
  const reordered=await records.reorder('owner-a',rows.map(row=>row.id).reverse())
  assert.equal(reordered[0].id,rows[4].id)
  await assert.rejects(records.reorder('owner-a',[rows[0].id,rows[0].id]))
  await assert.rejects(records.update('owner-a',rows[0].id,{label:'x\nmalformed'}))
  await records.update('owner-a',rows[0].id,{closed:true})
  assert.equal((await records.list('owner-a')).length,4)
  assert.equal((await storage.read()).windows.length,6,'closing preserves stored profile identity')
  const a=googleVoiceProfileRoot('D:/fixture','../../owner-a',rows[0].id)
  const b=googleVoiceProfileRoot('D:/fixture','owner-b',rows[0].id)
  assert.notEqual(a,b);assert.ok(!a.includes('owner-a'));assert.throws(()=>googleVoiceProfileRoot('D:/fixture','a','../other'))
})

function harness(){
  const storage=store<BridgeData>({pairs:[]});let owner='a',revision=0,available=true,calls=0
  const bridge=new GoogleVoiceExtensionBridge(storage,()=>{const saved=owner,version=revision;return {owner,authorized:()=>saved===owner&&version===revision&&!!owner}},async(_owner,id)=>available&&id==='window',async(_owner,id,op,payload)=>{calls++;return {window:id,op,payload}})
  const pair=async()=>{const code=await bridge.code('window');const reply:any=await bridge.request({v:1,id:'pair',op:'pair',payload:{code}});assert.equal(reply.ok,true);return {token:reply.result.pairToken,code}}
  return {bridge,storage,pair,get calls(){return calls},setOwner:(next:string)=>{owner=next;revision++},close:()=>{available=false}}
}
test('pair code is one-use, window-scoped and raw capability is never persisted',async()=>{
  const h=harness(),code=await h.bridge.code('window')
  const replies:any[]=await Promise.all([1,2].map(i=>h.bridge.request({v:1,id:'request-'+i,op:'pair',payload:{code}})))
  assert.equal(replies.filter(r=>r.ok).length,1)
  const token=replies.find(r=>r.ok).result.pairToken
  assert.equal(JSON.stringify(await h.storage.read()).includes(token),false)
  const status:any=await h.bridge.request({v:1,id:'check',op:'status',pairToken:token})
  assert.equal(status.ok,true);assert.equal(status.result.window,'window')
  h.setOwner('b');assert.equal((await h.bridge.request({v:1,id:'check',op:'status',pairToken:token}) as any).ok,false)
  assert.equal(h.calls,1)
})
test('closed windows, changed identity, unpaired and malformed operations cannot reach translation',async()=>{
  const h=harness(),{token}=await h.pair()
  for(const request of [{v:2,id:'bad',op:'status',pairToken:token},{v:1,id:'bad',op:'delete',pairToken:token},{v:1,id:'bad',op:'translate',pairToken:'bad'},null])assert.equal((await h.bridge.request(request) as any).ok,false)
  h.close();assert.equal((await h.bridge.request({v:1,id:'bad',op:'translate',pairToken:token,payload:{text:'sample'}}) as any).ok,false)
  assert.equal(h.calls,0)
})
test('an old code is invalidated by replacement and by logout',async()=>{
  const h=harness(),old=await h.bridge.code('window'),current=await h.bridge.code('window')
  assert.equal((await h.bridge.request({v:1,id:'a',op:'pair',payload:{code:old}}) as any).ok,false)
  h.setOwner('')
  assert.equal((await h.bridge.request({v:1,id:'b',op:'pair',payload:{code:current}}) as any).ok,false)
})
test('named pipe exchanges bounded frames without a network listener',async()=>{
  const h=harness(),{token}=await h.pair(),server=new GoogleVoicePipeServer(h.bridge)
  await server.start()
  const socket=createConnection('\\\\.\\pipe\\'+server.pipeName)
  try {
    const result=await new Promise<any>((resolve,reject)=>{
      let chunks=Buffer.alloc(0);socket.on('error',reject)
      socket.on('data',chunk=>{chunks=Buffer.concat([chunks,chunk]);if(chunks.length>=4&&chunks.length>=chunks.readUInt32LE(0)+4)resolve(JSON.parse(chunks.subarray(4).toString()))})
      socket.once('connect',()=>{const bytes=Buffer.from(JSON.stringify({v:1,id:'status',op:'status',pairToken:token})),header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);socket.write(header);socket.write(bytes)})
    })
    assert.equal(result.ok,true)
  }finally{socket.destroy();await server.stop()}
})
