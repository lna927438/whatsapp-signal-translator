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

test('provider switching is window-local and preserves the page, draft and checked proxy state', async () => {
  const { voice, calls, api, errors } = fixture(); await voice.enter()
  voice.acceptState({id:'one',state:'ready',page:'messages',network:{mode:'proxy',status:'checked',ip:'192.0.2.1'}})
  const before=calls.length
  assert.equal(await voice.setTranslationProvider('one','openai'),true)
  assert.equal(voice.selected.value?.translationProvider,'openai');assert.equal(voice.windows.value[1].translationProvider,undefined)
  assert.equal(calls.length,before);assert.equal(voice.page.value,'messages');assert.equal(voice.network.value?.ip,'192.0.2.1')
  api.updateGoogleVoiceWindow=async()=>{throw Error('not enabled')}
  assert.equal(await voice.setTranslationProvider('one','deepseek'),false)
  assert.equal(voice.selected.value?.translationProvider,'openai');assert.equal(calls.length,before);assert.equal(errors.length,1)
  voice.dispose()
})

test('home inventory never opens a page and a late read cannot remove a newly created window', async () => {
  const {voice,calls,api}=fixture()
  await voice.listForHome();assert.equal(voice.windows.value.length,2);assert.equal(calls.length,0);assert.equal(voice.active.value,false)
  const pending=deferred<GoogleVoiceWindow[]>();api.listGoogleVoiceWindows=()=>pending.promise
  const reading=voice.listForHome();await voice.add();pending.resolve([{id:'one',label:'Old response'}]);await reading
  assert.equal(voice.windows.value.length,3);assert.ok(voice.windows.value.some(window=>window.id==='three'));assert.equal(calls.length,0)
  voice.dispose()
})

test('page notices separate official access guidance and login from text-page availability', async () => {
  const { voice } = fixture(); await voice.enter()
  assert.equal(voice.page.value, 'unknown'); assert.doesNotMatch(voice.translationNotice.value, /已内置|翻译已就绪/)
  voice.acceptState({ id: 'one', state: 'ready', page: 'messages' })
  assert.match(voice.translationNotice.value, /短信页面已打开/)
  voice.acceptState({ id: 'one', state: 'ready', page: 'access-help' })
  assert.match(voice.translationNotice.value, /Google 显示访问限制说明.*核对账号状态/)
  assert.doesNotMatch(voice.translationNotice.value, /封禁|已内置|翻译已就绪/)
  voice.acceptState({ id: 'two', state: 'ready', page: 'messages' })
  assert.equal(voice.page.value, 'access-help', 'background window cannot overwrite current page status')
  voice.acceptState({ id: 'one', state: 'ready', page: 'help' })
  assert.doesNotMatch(voice.translationNotice.value, /限制|封禁/)
  voice.acceptState({ id: 'one', state: 'ready', page: 'sign-in' })
  assert.match(voice.translationNotice.value, /请完成 Google 登录或验证/)
  voice.acceptState({ id: 'one', state: 'loading', page: 'messages' })
  assert.equal(voice.page.value, 'unknown'); assert.match(voice.translationNotice.value, /尚未就绪/)
  voice.dispose()
})

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

test('Opening failure retains the selected record and retries with a reload', async () => {
  const { voice, api, calls } = fixture()
  await voice.enter()
  api.focusGoogleVoiceWindow = async () => { throw new Error('Browser unavailable') }
  await voice.focus('two')
  assert.equal(voice.state.value, 'error')
  assert.equal(voice.selectedId.value, 'two')
  await voice.retry()
  assert.deepEqual(calls.at(-1), ['refresh', 'two'])
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

test('A late focus response cannot hide a newer embedded navigation failure',async()=>{
  const {voice,api}=fixture();await voice.enter()
  const pending=deferred<unknown>();api.focusGoogleVoiceWindow=()=>pending.promise
  const focusing=voice.focus('two');await Promise.resolve()
  voice.acceptState({id:'two',state:'error',message:'Official navigation failed'})
  pending.resolve({state:'ready'});await focusing
  assert.equal(voice.state.value,'error');assert.equal(voice.message.value,'Official navigation failed')
  voice.acceptState({id:'one',state:'ready'});assert.equal(voice.state.value,'error')
  voice.acceptState({id:'two',state:'ready',canGoBack:true});assert.equal(voice.state.value,'ready');assert.equal(voice.canGoBack.value,true)
  voice.dispose()
})

test('Document loading and back state follow embedded updates, never an external-window handoff',async()=>{
  const {voice,api,calls}=fixture();api.focusGoogleVoiceWindow=async()=>({state:'loading'})
  await voice.enter();assert.equal(voice.state.value,'loading')
  voice.acceptState({id:'one',state:'ready',canGoBack:true})
  api.backGoogleVoiceWindow=async id=>{calls.push(['back',id]);return {state:'ready',canGoBack:false}}
  await voice.back();assert.deepEqual(calls.at(-1),['back','one']);assert.equal(voice.canGoBack.value,false)
  voice.leave();voice.acceptState({id:'one',state:'error',message:'late'});assert.equal(voice.message.value,'')
  voice.dispose()
})

test('Voice notification focus reloads owned window records and does not reopen a closed or stale target', async () => {
  const h = fixture(), target = 'gv-10000000-0000-4000-8000-000000000001'
  h.api.listGoogleVoiceWindows = async () => [{id:target,label:'Synthetic Voice',tabOrder:0}]
  await h.voice.focusNotification(target)
  assert.equal(h.voice.active.value,true); assert.equal(h.voice.selectedId.value,target)
  assert.deepEqual(h.calls.at(-1),['focus',target])
  const before = h.calls.length
  h.api.listGoogleVoiceWindows = async () => []
  await h.voice.focusNotification(target); assert.equal(h.calls.length,before)
  const delayed = deferred<GoogleVoiceWindow[]>()
  h.api.listGoogleVoiceWindows = () => delayed.promise
  const late = h.voice.focusNotification(target); h.voice.leave()
  delayed.resolve([{id:target,label:'Synthetic Voice'}]); await late
  assert.equal(h.voice.active.value,false); assert.equal(h.calls.length,before)
  h.voice.dispose()
})
