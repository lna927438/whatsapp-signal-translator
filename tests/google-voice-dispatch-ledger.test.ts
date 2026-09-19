import test from 'node:test'
import assert from 'node:assert/strict'
import { mainHarness } from './main-harness.ts'
import type { GoogleVoiceDispatchData } from '../src/main/platforms/googleVoice/dispatchLedger.ts'
const { GoogleVoiceDispatchLedger }=mainHarness().load('src/main/platforms/googleVoice/dispatchLedger.ts') as typeof import('../src/main/platforms/googleVoice/dispatchLedger.ts')

test('concurrent reservations and restart cannot dispatch the same draft twice',async()=>{
  let data:GoogleVoiceDispatchData={records:[]}
  const storage={read:async()=>structuredClone(data),write:async(value:GoogleVoiceDispatchData)=>{data=structuredClone(value)}}
  const ledger=new GoogleVoiceDispatchLedger(storage)
  const attempts=await Promise.allSettled(['r1','r2'].map(id=>ledger.reserve('owner','window','conv',id,'私密原文','Hello',()=>true)))
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1)
  assert.equal(data.records.length,1);assert.ok(!JSON.stringify(data).includes('私密原文'))
  const restored=new GoogleVoiceDispatchLedger(storage)
  assert.equal((await restored.status('owner','window','conv','私密原文',()=>true)).state,'uncertain')
  await assert.rejects(restored.reserve('owner','window','conv','r3','私密原文','Hello',()=>true),/待确认/)
  assert.equal((await restored.status('owner','other','conv','私密原文',()=>true)).state,'clear')
})

test('failed persistence never grants dispatch and identity changes after writing stay uncertain',async()=>{
  const broken=new GoogleVoiceDispatchLedger({read:async()=>({records:[]}),write:async()=>{throw new Error('disk full')}})
  await assert.rejects(broken.reserve('a','b','c','r','source','result',()=>true),/disk full/)
  let authorized=true,data:GoogleVoiceDispatchData={records:[]}
  const store={read:async()=>structuredClone(data),write:async(value:GoogleVoiceDispatchData)=>{data=structuredClone(value);authorized=false}}
  const ledger=new GoogleVoiceDispatchLedger(store)
  await assert.rejects(ledger.reserve('a','b','c','r','source','result',()=>authorized),/状态已变化/)
  assert.equal(data.records[0].state,'uncertain')
  await assert.rejects(ledger.resolve('a','b','c','r',1,'not-sent',()=>false))
  assert.equal(data.records[0].state,'uncertain')
})

test('a lost resolution reply can be replayed without reversing the saved decision',async()=>{
  let data:GoogleVoiceDispatchData={records:[]}
  const store={read:async()=>structuredClone(data),write:async(value:GoogleVoiceDispatchData)=>{data=structuredClone(value)}}
  for(const outcome of ['sent','not-sent'] as const){
    const ledger=new GoogleVoiceDispatchLedger(store)
    await ledger.reserve('a','b','c',outcome,'source-'+outcome,'result-'+outcome,()=>true)
    await ledger.resolve('a','b','c',outcome,1,outcome,()=>true)
    const restored=new GoogleVoiceDispatchLedger(store)
    assert.equal((await restored.resolve('a','b','c',outcome,1,outcome,()=>true)).resolved,true)
    await assert.rejects(restored.resolve('a','b','c',outcome,1,outcome==='sent'?'not-sent':'sent',()=>true),/相反/)
  }
})
