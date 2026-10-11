import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// Run BOTH shipped observers. The voice-only fixture cannot catch one feature
// deleting the other feature's UI during its normal background scans.
function fixture(body = '') {
  const dom = new JSDOM(`<style>
    .module-message__container-outer { line-height:0; display:flex; flex-direction:column; max-width:306px }
    .module-message__container { overflow:hidden; padding:8px 12px }
  </style><div data-hellodog-id="voice-message"><div class="module-message__container-outer"><div class="module-message__container"><div dir="ltr"><audio></audio><span class="duration">0:18</span><div class="module-message__text"></div></div></div></div></div>`, { pretendToBeVisual: true })
  const window = dom.window as any, document = window.document as Document
  const element = document.querySelector<HTMLElement>('[data-hellodog-id]')!
  element.getBoundingClientRect = () => ({ top: 10, bottom: 200 } as DOMRect)
  const attributes: any = { id:'voice-message', body, type:'incoming', conversationId:'conversation-a',
    attachments:[{ contentType:'audio/ogg', path:'owned-audio', size:100, clientUuid:'attachment-a' }] }
  const message = { attributes, get:(name:string)=>attributes[name] }
  window.MessageCache = { getById:(id:string)=>id === attributes.id ? message : undefined }
  window.ConversationController = { get:()=>({ getTitle:()=> 'Fixture', get:()=> 'private' }) }
  window.reduxStore = { getState:()=>({ selectedConversationId:'conversation-a' }) }
  const ipc = Object.assign(new EventEmitter(), { send:()=>{}, invoke:async (_channel:string, request:any) => {
    textCalls.push(request); return { enabled:true, text:'中文：' + request.text }
  } })
  const textCalls:any[] = []
  let attachmentReads = 0, time = 0, timerId = 0, removedPanels = 0
  const timers = new Map<number,{ at:number; every:number; callback:()=>void }>()
  const timer = (callback:()=>void, delay=0, every=0) => { const id=++timerId; timers.set(id,{at:time+delay,every,callback}); return id }
  const observation = new window.MutationObserver((records:MutationRecord[]) => {
    for (const record of records) for (const node of Array.from(record.removedNodes)) {
      if ((node as Element).matches?.('[data-hellodog-voice]')) removedPanels++
    }
  })
  observation.observe(element,{childList:true,subtree:true})
  const modules = new Map<string,any>()
  function load(name:string):any {
    if (modules.has(name)) return modules.get(name)
    const exports:any={}; modules.set(name,exports)
    const source = readFileSync(new URL('../integrations/hellodog-source/' + name,import.meta.url),'utf8')
    runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,window,document,Date,Blob,URL,Uint8Array,innerHeight:800,MutationObserver:window.MutationObserver,
      process:{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}},
      setTimeout:(callback:()=>void,delay:number)=>timer(callback,delay),clearTimeout:(id:number)=>timers.delete(id),
      setInterval:(callback:()=>void,delay:number)=>timer(callback,delay,delay),clearInterval:(id:number)=>timers.delete(id),
      require:(path:string):any=>{
        if (path === 'electron') return {ipcRenderer:ipc}
        if (path.startsWith('node:')) return require(path)
        if (['./hellodog.voice.preload.ts','./hellodog.voice.dom.ts'].includes(path)) return load(path.slice(2))
        if (path.includes('/migrations.')) return {loadAttachmentData:async()=>{ attachmentReads++; throw Error('fixture audio unavailable') }}
        if (path.includes('/nav.')) return {getSelectedConversationId:(state:any)=>state.selectedConversationId}
        if (path.includes('hellodog.recovery')) return {refreshHelloDogPage:async(options:any)=>{options.refreshTranslations();return 'refreshed'}}
        return {}
      },
    })
    return exports
  }
  load('hellodog.preload.ts').startHelloDogMessages()
  async function flush() { for(let index=0;index<10;index++) await Promise.resolve() }
  async function advance(milliseconds:number) {
    const end = time+milliseconds
    await flush()
    for (;;) {
      const next=[...timers].filter(([,entry])=>entry.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]
      if (!next) break
      const [id,entry]=next;time=entry.at
      if(entry.every)entry.at+=entry.every;else timers.delete(id)
      entry.callback();await flush()
    }
    time=end;await flush()
  }
  return {dom,document,element,attributes,ipc,textCalls,advance,flush,reads:()=>attachmentReads,removed:()=>removedPanels,
    panel:()=>element.querySelector<HTMLElement>('[data-hellodog-voice]')!,
    close:()=>{window.dispatchEvent(new window.Event('unload'));observation.disconnect();timers.clear();dom.window.close()},
  }
}

test('native pure voice remains the same panel during combined text/voice scans and after an explicit failed translation',async()=>{
  const f=fixture()
  try {
    const original=f.panel(),audio=f.element.querySelector('audio')
    await f.advance(8000)
    assert.equal(f.panel(),original,'text scans must not remove a voice-only message panel')
    assert.equal(f.removed(),0)
    assert.equal(f.reads(),0,'background scans must not read audio')
    assert.equal(f.textCalls.length,0,'voice-only messages must not request text translation')
    original.querySelector('button')!.click();await f.flush()
    assert.equal(f.reads(),1)
    assert.equal(original.querySelector('button')!.textContent,'重试语音翻译')
    f.element.querySelector('.duration')!.textContent='0:17'
    f.document.dispatchEvent(new f.dom.window.Event('scroll'))
    await f.advance(8000)
    assert.equal(f.panel(),original)
    assert.equal(f.removed(),0)
    assert.equal(f.reads(),1,'a failure must not cause automatic voice retries')
    assert.equal(f.element.querySelector('audio'),audio,'native audio must remain untouched')
  } finally { f.close() }
})

test('native audio captions update and text-only refreshes preserve the voice panel',async()=>{
  const f=fixture('first caption')
  try {
    const original=f.panel()
    await f.advance(3000)
    assert.equal(f.element.querySelector('[data-hellodog-ui="translation"]')!.textContent,'中文：first caption')
    f.attributes.body='edited caption'
    f.element.querySelector('.module-message__text')!.append('edited caption')
    await f.advance(3000)
    assert.equal(f.textCalls.length,2)
    assert.equal(f.element.querySelector('[data-hellodog-ui="translation"]')!.textContent,'中文：edited caption')
    assert.equal(f.panel(),original)
    f.ipc.emit('hellodog:reload',{},'refresh-a');await f.advance(3000)
    assert.equal(f.panel(),original,'text refresh must only remove text-owned nodes')
    assert.equal(f.removed(),0)
    assert.equal(f.element.querySelectorAll('[data-hellodog-ui="translation"]').length,1)
  } finally { f.close() }
})

test('native voice status opts out of Signal zero-line-height media layout',()=>{
  const f=fixture()
  try {
    const outer=f.element.querySelector('.module-message__container-outer')!
    assert.equal(f.dom.window.getComputedStyle(outer).lineHeight,'0')
    const panelStyle=f.dom.window.getComputedStyle(f.panel())
    assert.equal(panelStyle.lineHeight,'1.5','wrapped status/error/result text needs nonzero line boxes')
    assert.equal(panelStyle.boxSizing,'border-box')
    assert.equal(f.panel().querySelector('[role="status"]')!.textContent,'点击后在语音下方显示英文和中文。')
  } finally { f.close() }
})
