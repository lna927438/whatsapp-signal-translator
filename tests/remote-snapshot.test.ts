import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { RemoteSnapshot } = createRequire(import.meta.url)('../src/renderer/src/lib/remoteSnapshot.ts') as typeof import('../src/renderer/src/lib/remoteSnapshot')

test('offline startup has unknown balance, failed later refresh retains last confirmed balance', async () => {
  const changes: any[] = []
  const state = new RemoteSnapshot<{ balance: number }>((value, synced) => changes.push({ value, synced }))
  await state.refresh(async () => { throw new Error('offline') })
  assert.deepEqual(changes.at(-1), { value: null, synced: false })
  await state.refresh(async () => ({ balance: 4321 }))
  await state.refresh(async () => { throw new Error('offline again') })
  assert.deepEqual(changes.at(-1), { value: { balance: 4321 }, synced: false })
})

test('slow balance refreshes coalesce and cannot overwrite a newer confirmed wallet update', async () => {
  const changes: any[] = []
  let finish!: (value: { balance: number }) => void, calls = 0
  const fetch = () => { calls++; return new Promise<{ balance: number }>(resolve => { finish = resolve }) }
  const state = new RemoteSnapshot<{ balance: number }>((value, synced) => changes.push({ value, synced }))
  const first = state.refresh(fetch), second = state.refresh(fetch)
  await Promise.resolve()
  assert.equal(calls, 1)
  state.accept({ balance: 50 })
  finish({ balance: 100 })
  await Promise.all([first, second])
  assert.deepEqual(changes.at(-1), { value: { balance: 50 }, synced: true })
})

test('settlement during a pending fetch invalidates its response and guarantees one trailing fetch', async () => {
  const changes: any[] = []; let finish!: (n: number) => void; let calls = 0
  const state = new RemoteSnapshot<number>((value, synced) => changes.push({value,synced}))
  const pending = state.refresh(() => new Promise(resolve => { finish=resolve }))
  await Promise.resolve()
  state.invalidate(async()=>{calls++;return 80})
  state.invalidate(async()=>{calls++;return 70})
  finish(100); await pending
  assert.equal(calls,1)
  assert.equal(changes.some(x=>x.value===100),false)
  assert.deepEqual(changes.at(-1),{value:70,synced:true})
})

test('lost connectivity after settlement keeps the confirmed value explicitly unsynced', async () => {
 const changes:any[]=[];const state=new RemoteSnapshot<number>((value,synced)=>changes.push({value,synced}))
 state.accept(100);await state.invalidate(async()=>{throw new Error('offline')})
 assert.deepEqual(changes.at(-1),{value:100,synced:false})
 await state.invalidate(async()=>90);assert.deepEqual(changes.at(-1),{value:90,synced:true})
})
