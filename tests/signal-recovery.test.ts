import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const {prepareHelloDogSend,refreshHelloDogPage}=createRequire(import.meta.url)('../integrations/hellodog-source/hellodog.recovery.preload.ts')

test('native translation rejection fails only that message and releases the next queued send',async()=>{
  const failed:Error[]=[],dispatched:string[]=[]
  const jobs=[async()=>{throw Error('译文语言与目标不符')},async()=>{}]
  for(const [index,translate] of jobs.entries())if(await prepareHelloDogSend(translate,async(e:Error)=>{failed.push(e)},()=>false))dispatched.push(String(index))
  assert.equal(failed.length,1);assert.equal(failed[0].name,'HelloDogSendPreparationError');assert.match(failed[0].message,/目标/);assert.deepEqual(dispatched,['1'])
})
test('an erased native message never returns to the send queue',async()=>{
  let failed=0
  assert.equal(await prepareHelloDogSend(async()=>{throw Error('erased')},async()=>{failed++},()=>true),false)
  assert.equal(await prepareHelloDogSend(async()=>{},async()=>{failed++},()=>true),false)
  assert.equal(failed,0)
})
test('failed message state must persist before its native job is released',async()=>{
  await assert.rejects(prepareHelloDogSend(async()=>{throw Error('timeout')},async()=>{throw Error('disk unavailable')},()=>false),/disk/)
})
test('idle refresh saves the latest draft state before reloading',async()=>{
  const events:string[]=[]
  const mode=await refreshHelloDogPage({busy:()=>false,flushDrafts:async()=>{events.push('save')},refreshTranslations:()=>events.push('redraw'),checkConnection:()=>events.push('connection')})
  assert.equal(mode,'reload');assert.deepEqual(events,['save','redraw'])
})
test('refresh during a send, draft or call checks the existing connection without restarting jobs',async()=>{
  const events:string[]=[]
  const mode=await refreshHelloDogPage({busy:()=>true,flushDrafts:async()=>{events.push('save')},refreshTranslations:()=>events.push('redraw'),checkConnection:()=>events.push('check')})
  assert.equal(mode,'synchronized');assert.deepEqual(events,['save','redraw','check'])
})
test('draft persistence failure aborts refresh and leaves the current window intact',async()=>{
  let sideEffects=0
  await assert.rejects(refreshHelloDogPage({busy:()=>false,flushDrafts:async()=>{throw Error('disk unavailable')},refreshTranslations:()=>sideEffects++,checkConnection:()=>sideEffects++}),/disk/)
  assert.equal(sideEffects,0)
})
