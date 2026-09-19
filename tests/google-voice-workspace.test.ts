/// <reference path="../src/renderer/src/env.d.ts" />
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { GoogleVoiceWindow, GoogleVoiceWorkspaceApi } from '../src/renderer/src/lib/googleVoiceWorkspace'
const require = createRequire(import.meta.url)
const websiteRequire = createRequire(new URL('../website/package.json', import.meta.url))
const { buildSync } = createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const compiled = { exports: {} as typeof import('../src/renderer/src/lib/googleVoiceWorkspace') }
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/lib/googleVoiceWorkspace.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vue'] })
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports)
const { useGoogleVoiceWorkspace } = compiled.exports

function fixture() {
  let records: GoogleVoiceWindow[] = [{ id: 'one', label: 'Voice 1', tabOrder: 0 }, { id: 'two', label: 'Voice 2', tabOrder: 1 }]
  const calls: unknown[][] = [], errors: string[] = []
  const api: GoogleVoiceWorkspaceApi = {
    listGoogleVoiceWindows: async () => structuredClone(records),
    addGoogleVoiceWindow: async () => { const record = { id: 'three', label: 'Voice 3', tabOrder: 2 }; records.push(record); return structuredClone(record) },
    updateGoogleVoiceWindow: async (id, patch) => { const item = records.find(item => item.id === id)!; Object.assign(item, patch); return structuredClone(item) },
    reorderGoogleVoiceWindows: async ids => { records = ids.map((id, tabOrder) => ({ ...records.find(item => item.id === id)!, tabOrder })); return structuredClone(records) },
    focusGoogleVoiceWindow: async id => { calls.push(['focus', id]) },
    closeGoogleVoiceWindow: async id => { records = records.filter(item => item.id !== id); calls.push(['close', id]); return true },
    refreshGoogleVoiceWindow: async id => { calls.push(['refresh', id]) },
    openGoogleVoiceExternal: async id => { calls.push(['external', id]) }
  }
  const voice = useGoogleVoiceWorkspace({ api: () => api, beforeFocus: async () => {}, reportError: message => errors.push(message) })
  return { api, voice, calls, errors }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('Voice windows persist independent add/rename/order/close operations without translation accounts', async () => {
  const { voice, calls } = fixture()
  await voice.enter()
  assert.equal(voice.selectedId.value, 'one')
  await voice.add()
  assert.equal(voice.selectedId.value, 'three')
  assert.equal(await voice.rename('three', '  Office  '), true)
  assert.equal(voice.selected.value?.label, 'Office')
  await voice.reorder(['three', 'one', 'two'])
  assert.deepEqual(voice.windows.value.map(item => item.id), ['three', 'one', 'two'])
  await voice.close('three')
  assert.equal(voice.selectedId.value, 'one')
  await voice.close('one'); await voice.close('two')
  assert.equal(voice.selectedId.value, '')
  assert.equal(voice.state.value, 'idle')
  assert.deepEqual(calls.at(-1), ['focus', undefined])
  voice.dispose()
})

test('Late focus results cannot reselect Voice after returning to another workspace', async () => {
  const { voice, api } = fixture()
  await voice.enter()
  const pending = deferred<unknown>()
  api.focusGoogleVoiceWindow = () => pending.promise
  const switching = voice.focus('two')
  await Promise.resolve()
  voice.leave()
  pending.reject(new Error('late native failure'))
  await switching
  assert.equal(voice.active.value, false)
  assert.equal(voice.state.value, 'idle')
  assert.equal(voice.message.value, '')
  voice.dispose()
})

test('Latest Voice selection wins over an earlier failed native startup', async () => {
  const { voice, api } = fixture()
  await voice.enter()
  const older = deferred<unknown>()
  api.focusGoogleVoiceWindow = id => id === 'two' ? older.promise : Promise.resolve()
  const previous = voice.focus('two')
  await Promise.resolve()
  await voice.focus('one')
  older.reject(new Error('old failure'))
  await previous
  assert.equal(voice.selectedId.value, 'one')
  assert.equal(voice.state.value, 'ready')
  voice.dispose()
})

test('Opening failure retains the selected record and allows retry', async () => {
  const { voice, api } = fixture()
  await voice.enter()
  api.focusGoogleVoiceWindow = async () => { throw new Error('Browser unavailable') }
  await voice.focus('two')
  assert.equal(voice.state.value, 'error')
  assert.equal(voice.selectedId.value, 'two')
  api.focusGoogleVoiceWindow = async () => {}
  await voice.retry()
  assert.equal(voice.state.value, 'ready')
  voice.dispose()
})

test('A cancelled native focus is not displayed as a ready window', async () => {
  const { voice, api } = fixture()
  await voice.enter()
  api.focusGoogleVoiceWindow = async () => ({ state: 'cancelled' })
  await voice.focus('two')
  assert.equal(voice.selectedId.value, 'two')
  assert.equal(voice.state.value, 'idle')
  voice.dispose()
})

test('Concurrent add clicks create one record and never steal focus after leaving Voice', async () => {
  const { voice, api, calls } = fixture()
  await voice.enter()
  const pending = deferred<GoogleVoiceWindow>()
  let adds = 0
  api.addGoogleVoiceWindow = () => { adds++; return pending.promise }
  const before = calls.length, adding = voice.add()
  await voice.add()
  voice.leave()
  pending.resolve({ id: 'four', label: 'Voice 4' })
  await adding
  assert.equal(adds, 1)
  assert.equal(calls.length, before)
  assert.equal(voice.windows.value.at(-1)?.id, 'four')
  assert.equal(voice.active.value, false)
  voice.dispose()
})

test('List loading blocks conflicting record writes and leaving ignores the old list', async () => {
  const { voice, api } = fixture()
  const pending = deferred<GoogleVoiceWindow[]>()
  api.listGoogleVoiceWindows = () => pending.promise
  const opening = voice.enter()
  for (let index = 0; index < 4; index++) await Promise.resolve()
  assert.equal(voice.busy.value, true)
  await voice.add()
  voice.leave()
  pending.resolve([{ id: 'stale', label: 'Stale' }])
  await opening
  assert.deepEqual(voice.windows.value, [])
  assert.equal(voice.busy.value, false)
  voice.dispose()
})

test('Refresh and independent-window actions stay on the selected Voice window', async () => {
  const { voice, calls } = fixture()
  await voice.enter()
  await voice.refresh()
  assert.deepEqual(calls.at(-1), ['refresh', 'one'])
  await voice.external()
  assert.deepEqual(calls.at(-1), ['external', 'one'])
  assert.equal(voice.state.value, 'idle')
  voice.dispose()
})
