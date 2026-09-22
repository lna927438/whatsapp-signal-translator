import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const {WorkspaceFocus}=createRequire(import.meta.url)('../src/main/workspaceFocus.ts') as typeof import('../src/main/workspaceFocus')
const deferred=()=>{let resolve!:(value?:unknown)=>void,reject!:(error:Error)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))

test('a hanging page does not block the newest window and old completion never hides it',async()=>{
  let visible='',hides=0;const focus=new WorkspaceFocus(()=>{hides++;visible=''},()=>true,50),hold=deferred()
  const old=focus.select('whatsapp:a',async lease=>{await hold.promise;if(lease.current())visible='a';return {state:'ready'}})
  await tick()
  const newer=focus.select('signal:b',async()=>{visible='b';return {state:'ready'}})
  assert.equal((await old).state,'cancelled');assert.equal((await newer).state,'ready');assert.equal(visible,'b')
  hold.resolve();await tick();assert.equal(visible,'b');assert.equal(hides,2)
})

test('stale failures cannot replace the selected page or fail its navigation',async()=>{
  const focus=new WorkspaceFocus(()=>{},()=>true,50),hold=deferred()
  const old=focus.select('a',async()=>{await hold.promise;throw Error('old load failed')});await tick()
  assert.equal((await focus.select('b',async()=>({state:'ready'}))).state,'ready')
  hold.reject(Error('old failure'));assert.equal((await old).state,'cancelled');await tick()
  assert.equal(focus.isCurrent('b'),true)
})

test('slow selection has bounded loading response and still admits immediate switching',async()=>{
  const focus=new WorkspaceFocus(()=>{},()=>true,15),hold=deferred()
  const slow=await focus.select('a',async()=>{await hold.promise;return {state:'ready'}})
  assert.equal(slow.state,'loading');assert.equal((await focus.select('b',async()=>({state:'ready'}))).state,'ready')
  hold.resolve()
})

test('refresh only runs for the current selection and never hides or changes selection',async()=>{
  let hides=0,calls=0;const focus=new WorkspaceFocus(()=>{hides++},()=>true,20)
  await focus.select('google-voice:a',async()=>({state:'ready'}))
  assert.equal((await focus.runCurrent('google-voice:b',async()=>{calls++;return {state:'ready'}})).state,'cancelled')
  assert.equal((await focus.runCurrent('google-voice:a',async()=>{calls++;return {state:'loading'}})).state,'loading')
  assert.equal(calls,1);assert.equal(hides,1)
})

test('logout and destroyed windows invalidate pending tasks without touching destroyed views',async()=>{
  let alive=true,hides=0;const focus=new WorkspaceFocus(()=>{hides++},()=>alive,30),hold=deferred()
  const work=focus.select('a',async lease=>{await hold.promise;assert.equal(lease.current(),false);return {state:'ready'}});await tick()
  alive=false;focus.invalidate();assert.equal((await work).state,'cancelled');assert.equal(hides,1)
  assert.equal((await focus.select('b',async()=>({state:'ready'}))).state,'cancelled');hold.resolve()
})

test('a launcher can adopt its resolved account ID but stale launchers cannot retarget the newest selection',async()=>{
  const focus=new WorkspaceFocus(()=>{},()=>true,30);let oldLease:any
  await focus.select('google-voice:',async lease=>{oldLease=lease;assert.equal(lease.retarget('google-voice:a'),true);return {state:'ready'}})
  assert.equal(focus.isCurrent('google-voice:a'),true)
  await focus.select('signal:b',async()=>({state:'ready'}));assert.equal(oldLease.retarget('google-voice:a'),false);assert.equal(focus.isCurrent('signal:b'),true)
})
