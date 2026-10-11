import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { voiceMediaBundle } from './voice-browser-fixture.ts'

let bundle: string
before(async () => { bundle = await voiceMediaBundle() })
const result = { text: 'Call tomorrow.', englishTranslation: 'Call tomorrow.', translation: '明天打电话。', audioId: 'a'.repeat(64), targetLanguage: 'zh-CN' }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
async function mount(translate: () => Promise<any> = async () => result) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window as any, d = w.document as Document
  const calls: any[] = []
  w.IntersectionObserver = class { constructor(private callback: Function) {} observe() { this.callback([{ isIntersecting: true }]) } disconnect() {} }
  w.fetch = async () => new Response(new Uint8Array([1, 2, 3]))
  w.AbortSignal = AbortSignal
  w.AudioContext = class { async decodeAudioData() { return { duration: .15 } } async close() {} }
  w.OfflineAudioContext = class { destination = {}; constructor(_channels: number, private count: number) {} createBufferSource() { return { connect() {}, start() {} } } async startRendering() { return { getChannelData: () => new Float32Array(this.count).fill(.2) } } }
  w.desktopAPI = { signalMediaUrl: async () => 'hellodog-media://authorized/attachment', translateVoiceMessage: async (...args: any[]) => { calls.push(args); return translate() } }
  w.eval(bundle); await tick()
  return { w, d, calls, click: async () => { (d.querySelector('.voice-review button') as HTMLButtonElement).click(); await tick() }, close: () => { w.__dispose(); dom.window.close() } }
}

test('legacy Signal voice displays both languages below its original audio without repeated requests', async () => {
  const h = await mount()
  try {
    const audio = h.d.querySelector('audio'); assert.equal(h.calls.length, 0)
    await h.click(); assert.equal(h.calls.length, 1)
    assert.equal(h.d.querySelector('.voice-review [lang=en]')?.textContent, result.englishTranslation)
    assert.equal(h.d.querySelector('.voice-review [lang="zh-CN"]')?.textContent, result.translation)
    assert.equal(h.d.querySelector('audio'), audio); assert.equal(h.d.querySelector('.voice-review button'), null)
  } finally { h.close() }
})

test('legacy Signal discards a late bilingual result after switching away and back to the same message', async () => {
  let finish!: (value: any) => void
  const h = await mount(() => new Promise(resolve => { finish = resolve }))
  try {
    await h.click(); h.w.__setProps({ peer: '+12025550456' }); await tick(); h.w.__setProps({ peer: '+12025550123' }); await tick()
    finish(result); await tick()
    assert.equal(h.d.querySelector('.voice-output'), null); assert.equal(h.calls.length, 1)
    assert.equal((h.d.querySelector('.voice-review button') as HTMLButtonElement).disabled, false)
  } finally { h.close() }
})
