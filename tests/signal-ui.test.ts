import { createUiLocaleHarness } from './ui-locale-harness.ts'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import * as protocol from '../src/shared/signalProtocol.ts'
import * as typing from '../src/shared/signalTyping.ts'

const require = createRequire(import.meta.url)
const state = require('../src/renderer/src/lib/signalState.ts')
const dom = new JSDOM('<body></body>', { url: 'https://hellodog.test/' })
for (const key of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
const vue = require('vue')
const { uiLocale } = createUiLocaleHarness()
const restartState = require('../src/renderer/src/lib/restartState.ts')
const preferencesModule = require('../src/shared/signalPreferences.ts')
const mediaModule = require('../src/shared/signalMedia.ts')
const components = new Map<string, any>()
let mediaTimeoutMs = 10000
function loadComponent(file: string): any {
  if (components.has(file)) return components.get(file)
  const { descriptor } = parse(readFileSync(new URL('../src/renderer/src/components/' + file, import.meta.url), 'utf8'))
  const source = compileScript(descriptor, { id: file, inlineTemplate: true }).content
  const exports: any = {}; components.set(file, exports)
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, window: dom.window, localStorage: dom.window.localStorage, document: dom.window.document, console, setInterval, clearInterval,
    setTimeout: (fn:()=>void,ms:number)=>setTimeout(fn,ms===10000?mediaTimeoutMs:ms), clearTimeout, structuredClone, atob,
    require: (name: string): any => name === 'vue' ? vue : name.includes('signalTyping') ? typing : name.includes('uiLocale') ? uiLocale : name === 'qrcode' ? require('../node_modules/qrcode') : name.endsWith('.vue') ? loadComponent(name.replace('./','')) : name.includes('restartState') ? restartState : name.includes('signalMedia') ? mediaModule : name.includes('signalPreferences') ? preferencesModule : name.includes('signalProtocol') ? protocol : state
  })
  return exports
}
const exports = loadComponent('SignalView.vue')
const settle = async () => { for (let i = 0; i < 40; i++) { await vue.nextTick(); await Promise.resolve() } }
const account = '+12025550100', peer = '+12025550123'
function input(element: HTMLInputElement, value: string) { element.value = value; element.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }
function mount(options: { failure?: boolean; missingAccount?: boolean; pending?: boolean } = {}) {
  dom.window.localStorage.clear()
  const callbacks: Record<string, Function> = {}, calls: any[] = []
  let prefs = structuredClone(preferencesModule.signalPreferenceDefaults)
  const api: any = {
    focusPlatform: async () => true, getDraft: async () => '', saveDraft: async () => true,
    signalRuntimeStatus: async () => ({ state: 'ready', message: '已准备好' }),
    signalListAccounts: async () => { if (options.failure) throw new Error('Signal 连接失败'); return options.missingAccount ? [] : [account] },
    signalHistory: async () => [], signalListContacts: async () => [{ id: peer, name: 'Alex', aliases: [peer], kind: 'contact' }, { id: 'group:YXNkZg==', name: 'Project group', aliases: ['group:YXNkZg=='], kind: 'group' }],
    signalSyncContacts: async () => calls.push('sync'), updateAccount: async () => true,
    signalPreferences: async () => structuredClone(prefs), signalAvatar: async () => '',
    signalSavePreferences: async (_id:string, patch:any) => { Object.assign(prefs, patch); return structuredClone(prefs) },
    signalConversationPreferences: async (_id:string, peer:string, patch:any) => { prefs.conversations[peer] = {...prefs.conversations[peer], ...patch}; return structuredClone(prefs) },
    signalMarkRead: async () => structuredClone(prefs), signalProfile: async () => ({name:'Test user',givenName:'Test',familyName:'User',number:account}),
    signalDetails: async (_id:string, peer:string) => ({id:peer, name:'Alex', number:peer, kind:'contact', aliases:[peer], expiration:0, sharedGroups:[]}),
    signalSaveContact: async () => true,
    pendingSend: async () => options.pending ? { id: 'send-1', signalAccount: account, state: 'uncertain', request: { text: 'hello' } } : null,
    prepareSignalSend: async (...args: any[]) => { calls.push(args); return { id: 'send-new', state: 'draft' } },
    translateSend: async () => ({ id: 'send-new', state: 'ready', translated: 'Hello' }),
    getSettings: async () => ({ previewSend: false }), submitSend: async () => ({ result: { account, peer, original: '你好', translated: 'Hello', fromMe: true, timestamp: 42 } })
  }
  for (const name of ['onAccountAction', 'onBillingChanged', 'onSignalRuntime', 'onSignalDiagnostic', 'onSignalMessage','onSignalChanged','onSignalTyping']) api[name] = (callback: Function) => { callbacks[name] = callback; return () => delete callbacks[name] }
  ;(dom.window as any).desktopAPI = api
  const root = dom.window.document.createElement('div'); dom.window.document.body.appendChild(root)
  const app = vue.createApp(exports.default, { accountRecord: { id: 'signal-a', signalAccount: account, sendAutoTranslate: true }, userId: 'owner' })
  app.mount(root)
  return { root, api, calls, callbacks, close() { app.unmount(); root.remove() } }
}
after(() => dom.window.close())

test('Signal typing is shown only for the current account and conversation and disappears on stop',async()=>{
 const h=mount()
 try{
  await settle();(h.root.querySelector('.signal-contact') as HTMLButtonElement).click();await settle()
  const value={account,peer,sender:peer,started:true,timestamp:Date.now(),expiresAt:Date.now()+15000}
  h.callbacks.onSignalTyping({...value,account:'+12025550999'});await settle();assert.equal(h.root.querySelector('.signal-typing'),null)
  h.callbacks.onSignalTyping(value);await settle();assert.ok(h.root.querySelector('.signal-typing'))
  h.callbacks.onSignalTyping({...value,started:false,timestamp:value.timestamp+1});await settle();assert.equal(h.root.querySelector('.signal-typing'),null)
 }finally{h.close()}
})

test('English Signal submission errors retain an uncertain task without resending or blocking the next draft', async () => {
  uiLocale.uiLanguage.value = 'en'
  const h = mount()
  let submissions = 0
  h.api.submitSend = async () => { submissions++; throw new Error('Connection lost while awaiting the send result') }
  try {
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement,'First draft'); await settle()
    ;(h.root.querySelector('.signal-composer button') as HTMLButtonElement).click(); await settle()
    assert.equal(submissions,1)
    assert.equal(h.root.querySelector('.signal-outbox button'),null)
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement,'Next unsent draft'); await settle()
    assert.equal((h.root.querySelector('.signal-composer textarea') as HTMLTextAreaElement).value,'Next unsent draft')
    assert.equal((h.root.querySelector('.signal-composer button') as HTMLButtonElement).disabled,false)
    h.callbacks.onAccountAction({action:'send-resolved',accountId:'signal-a'}); await settle()
    assert.equal(submissions,1)
  } finally { h.close(); uiLocale.uiLanguage.value = 'zh-CN' }
})

test('a recycled media component ignores old replies, reopens the correct account attachment and returns keyboard focus', async()=>{
  let first!: (value:string)=>void
  const replies:any[]=[]
  ;(dom.window as any).desktopAPI={signalMediaUrl:async(accountId:string,peer:string,id:string)=>{replies.push([accountId,peer,id]);return id==='old'?new Promise<string>(r=>first=r):'hellodog-media://new/image'}}
  const props=vue.reactive({accountId:'a',peer:'peer-a',attachment:{id:'old',filename:'old.png',contentType:'image/png',size:42}})
  const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root)
  const app=vue.createApp({render:()=>vue.h(loadComponent('SignalMedia.vue').default,props)});app.mount(root)
  try{
    await settle();props.accountId='b';props.peer='peer-b';props.attachment={...props.attachment,id:'new',filename:'new.png'};await settle()
    first('hellodog-media://old/image');await settle()
    const image=root.querySelector('img')!;assert.equal(image.getAttribute('src'),'hellodog-media://new/image');assert.equal(image.alt,'new.png')
    assert.deepEqual(replies,[['a','peer-a','old'],['b','peer-b','new']])
    const button=root.querySelector('button')!;button.focus();button.click();await settle()
    const close=dom.window.document.querySelector('.signal-media-lightbox button') as HTMLButtonElement
    assert.equal(dom.window.document.activeElement,close)
    close.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle()
    assert.equal(dom.window.document.querySelector('.signal-media-lightbox'),null);assert.equal(dom.window.document.activeElement,button)
  }finally{app.unmount();root.remove()}
})

test('media timeout releases loading and retry remains usable; the late first response never replaces the retry',async()=>{
  let calls=0,late!:(value:string)=>void
  ;(dom.window as any).desktopAPI={signalMediaUrl:async()=>{calls++;return calls===1?new Promise<string>(r=>late=r):'hellodog-media://retry/image'}}
  mediaTimeoutMs=5
  const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root)
  const app=vue.createApp(loadComponent('SignalMedia.vue').default,{accountId:'a',peer:'peer',attachment:{id:'image',filename:'image.png',contentType:'image/png',size:42}});app.mount(root)
  try{
    await new Promise(r=>setTimeout(r,25));await settle();assert.match(root.textContent||'',/读取超时/);assert.equal(root.querySelector('.media-loading'),null)
    const retry=root.querySelector('p button') as HTMLButtonElement;retry.click();await settle();late('hellodog-media://late/image');await settle()
    assert.equal(root.querySelector('img')?.getAttribute('src'),'hellodog-media://retry/image');assert.equal(calls,2)
  }finally{mediaTimeoutMs=10000;app.unmount();root.remove()}
})

test('Signal album shows thumbnails and separate links/files, with sequential viewing and copy/save feedback',async()=>{
  const calls:any[]=[], now=Date.now()
  ;(dom.window as any).desktopAPI={signalMediaUrl:async(_id:string,_peer:string,id:string)=>'hellodog-media://fixture/'+id,signalMediaAction:async(...args:any[])=>{calls.push(structuredClone(args));return{action:args[3],success:true}}}
  const photo=(id:string,contentType='image/png')=>({id,filename:id+'.png',contentType,size:123})
  const props=vue.reactive({accountId:'record-a',peer,messages:[{peer,timestamp:now-1000,original:'https://example.com/photo',attachments:[photo('one')]},{peer,timestamp:now,original:'Two',attachments:[photo('two'),photo('document','application/pdf')]},{peer,timestamp:now-2000,attachments:[photo('expired')],expiresAt:now-1}]})
  const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root)
  const app=vue.createApp({render:()=>vue.h(loadComponent('SignalGallery.vue').default,props)});app.mount(root)
  try{
    await settle();assert.equal(root.querySelectorAll('.sg-grid img').length,2)
    const thumbnail=root.querySelector('.sg-grid button') as HTMLButtonElement;thumbnail.focus();thumbnail.click();await settle()
    const viewer=()=>dom.window.document.querySelector('.signal-media-lightbox')!
    assert.equal(viewer().querySelector('img')?.getAttribute('alt'),'two.png')
    ;(viewer().querySelector('[aria-label="下一张"]') as HTMLButtonElement).click();await settle()
    assert.equal(viewer().querySelector('img')?.getAttribute('alt'),'one.png')
    const action=(label:string)=>Array.from(viewer().querySelectorAll('button')).find(button=>button.textContent===label)!.click()
    action('复制图片');await settle();assert.match(viewer().textContent||'',/图片已复制/)
    action('保存附件');await settle();assert.match(viewer().textContent||'',/附件已保存/)
    assert.deepEqual(calls,[['record-a',peer,'one','copy'],['record-a',peer,'one','save']])
    ;(viewer().querySelector('button') as HTMLButtonElement).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle()
    assert.equal(dom.window.document.activeElement,thumbnail)
    ;(root.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();await settle();assert.equal(root.querySelector('a')?.getAttribute('href'),'https://example.com/photo')
    ;(root.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement).click();await settle();assert.equal(root.querySelectorAll('.sg-file').length,1)
    props.messages=[];await settle();assert.equal(root.querySelectorAll('.sg-file').length,0)
  }finally{app.unmount();root.remove()}
})

test('manual Signal translation crosses the bridge with only a plain message identity and applies its returned result',async()=>{
  const h=mount(), calls:any[]=[]
  h.api.translateSignalMessage=async(...args:any[])=>{calls.push(structuredClone(args));return '你今天过得如何？'}
  try{
    await settle();(h.root.querySelector('.signal-contact') as HTMLButtonElement).click();await settle()
    h.callbacks.onSignalMessage({account,peer,timestamp:123,fromMe:false,original:'How was your day? 😊',attachments:[],unsupported(){}});await settle()
    ;(h.root.querySelector('.bubble>button') as HTMLButtonElement).click();await settle()
    assert.deepEqual(calls,[['signal-a',{account,peer,timestamp:123,fromMe:false}]])
    assert.equal(h.root.querySelector('.translated')?.textContent,'你今天过得如何？')
    assert.doesNotMatch(h.root.textContent||'',/could not be cloned/)
  }finally{h.close()}
})

test('visible historical Signal messages recover from synchronous bridge failures when connectivity returns, without resending',async()=>{
  const rect=dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return{top:0,bottom:500,left:0,right:800,width:800,height:500,x:0,y:0,toJSON(){}}}
  const visibility=Object.getOwnPropertyDescriptor(dom.window.document,'visibilityState')
  Object.defineProperty(dom.window.document,'visibilityState',{configurable:true,value:'visible'})
  const h=mount();let attempts=0
  h.api.signalHistory=async()=>[{account,peer,timestamp:123,fromMe:false,original:'An older message 😊',attachments:[]}]
  h.api.displaySignalMessage=(_id:string,identity:any)=>{structuredClone(identity);attempts++;if(attempts===1)throw new Error('An object could not be cloned.');return Promise.resolve('一条历史消息 😊')}
  try{
    await settle();(h.root.querySelector('.signal-contact') as HTMLButtonElement).click();await settle()
    assert.equal(attempts,1);assert.equal(h.root.querySelector('.translated'),null)
    dom.window.dispatchEvent(new dom.window.Event('online'));await settle()
    assert.equal(attempts,2);assert.equal(h.root.querySelector('.translated')?.textContent,'一条历史消息 😊')
    assert.equal(h.calls.length,0)
  }finally{h.close();dom.window.HTMLElement.prototype.getBoundingClientRect=rect;if(visibility)Object.defineProperty(dom.window.document,'visibilityState',visibility);else delete (dom.window.document as any).visibilityState}
})

test('Signal inline media and emoji picker work without a review banner, and attachment-only send captures its IDs', async () => {
  const h = mount()
  try {
    const image = { id:'local-11111111-1111-1111-1111-111111111111',filename:'photo.png',contentType:'image/png',size:10 }
    h.api.signalPickMedia = async () => [image]
    h.api.signalMediaUrl = async () => 'data:image/png;base64,AA=='
    h.api.signalStagedMedia = async () => [image]
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    ;(h.root.querySelector('[aria-label="表情符号"]') as HTMLButtonElement).click(); await settle()
    ;(h.root.querySelector('.signal-emoji-picker>div button') as HTMLButtonElement).click(); await settle()
    const textarea = h.root.querySelector('.signal-composer textarea') as HTMLInputElement
    assert.equal(textarea.value,'😀'); input(textarea,'')
    ;(h.root.querySelector('[aria-label="添加附件"]') as HTMLButtonElement).click(); await settle()
    assert.equal(h.root.querySelector('.signal-selected-media img')?.getAttribute('alt'),'photo.png')
    const send = h.root.querySelector('.signal-composer button') as HTMLButtonElement
    assert.equal(send.disabled,false); send.click(); await settle()
    assert.equal(h.calls[0][3],''); assert.deepEqual(Array.from(h.calls[0][5].attachments),[image.id])
    assert.equal(h.root.querySelector('.signal-selected-media'),null)
  } finally { h.close() }
})

test('Signal received images, videos and audio render as media controls with scoped fetches', async () => {
  const h = mount(), calls:any[]=[]
  try {
    h.api.signalMediaUrl = async (...args:any[]) => {calls.push(args);return 'hellodog-media://media/example'}
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    h.callbacks.onSignalMessage({account,peer,fromMe:false,original:'',timestamp:1000,attachments:[{id:'pic',filename:'pic.gif',contentType:'image/gif',size:20},{id:'clip',filename:'clip.mp4',contentType:'video/mp4',size:30},{id:'voice',filename:'voice.ogg',contentType:'audio/ogg',size:40,isVoiceNote:true}]})
    await settle()
    assert.ok(h.root.querySelector('.signal-messages img[src^="hellodog-media:"]'))
    assert.ok(h.root.querySelector('.signal-messages video[controls]'));assert.ok(h.root.querySelector('.signal-messages audio[controls]'))
    assert.equal(calls.length,3);assert.ok(calls.every(call=>call[0]==='signal-a'&&call[1]===peer))
  } finally {h.close()}
})

test('Signal opens real contact and group controls without requiring a typed phone number', async () => {
  const h = mount()
  try {
    await settle(); assert.equal(h.root.querySelectorAll('.signal-contact').length, 2)
    ;(h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    assert.equal(h.root.querySelector('.signal-conversation-heading h3')?.textContent, 'Alex')
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, '你好'); await settle()
    ;(h.root.querySelector('.signal-composer button') as HTMLButtonElement).click(); await settle()
    assert.equal(h.calls[0][2], peer); assert.equal(h.root.querySelector('.translated')?.textContent, 'Hello')
    assert.equal((h.root.querySelector('.signal-composer textarea') as HTMLInputElement).value, '')
  } finally { h.close() }
})

test('Signal connection failure leaves an enabled repair action instead of a permanent spinner', async () => {
  const h = mount({ failure: true })
  try { await settle(); const button = h.root.querySelector('.runtime-card button') as HTMLButtonElement; assert.ok(button); assert.equal(button.disabled, false); assert.equal(button.textContent, '重新准备') }
  finally { h.close() }
})

test('a removed Signal linked device shows association controls instead of a misleading bound account', async () => {
  const h = mount({ missingAccount: true })
  try { await settle(); assert.ok(h.root.textContent?.includes('关联手机 Signal')); assert.equal(h.root.querySelector('.signal-composer'), null) }
  finally { h.close() }
})

test('Signal pending send records do not appear as a chat banner or auto-submit', async () => {
  const h = mount({ pending: true })
  try {
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, '你好'); await settle()
    assert.equal((h.root.querySelector('.signal-composer button') as HTMLButtonElement).disabled, false)
    assert.ok(!h.root.textContent?.includes('核对')); assert.equal(h.calls.length, 0)
    h.api.pendingSend = async () => null; h.callbacks.onAccountAction({ action: 'send-resolved', accountId: 'signal-a' }); await settle()
    assert.equal((h.root.querySelector('.signal-composer button') as HTMLButtonElement).disabled, false)
  } finally { h.close() }
})

test('Signal contact changes preserve distinct drafts and group recipients', async () => {
  const h = mount()
  try {
    await settle(); const contacts = h.root.querySelectorAll('.signal-contact')
    ;(contacts[0] as HTMLButtonElement).click(); await settle(); input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, 'draft to Alex'); await settle()
    ;(contacts[1] as HTMLButtonElement).click(); await settle(); input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, 'group draft'); await settle()
    ;(contacts[0] as HTMLButtonElement).click(); await settle()
    assert.equal((h.root.querySelector('.signal-composer textarea') as HTMLInputElement).value, 'draft to Alex')
    assert.equal(h.calls.length, 0)
  } finally { h.close() }
})

test('Signal accepts a second message while the first translates and sends both once without review', async () => {
  const h = mount()
  try {
    let release: (value:any) => void = () => {}, sequence = 0
    const tasks = new Map<string,any>(), submissions:string[] = []
    h.api.prepareSignalSend = async (_id:string, _account:string, recipient:string, text:string) => {
      const task = {id:'send-' + ++sequence, state:'draft', peer:recipient, request:{text}}
      tasks.set(task.id,task); return task
    }
    h.api.translateSend = async (id:string) => {
      if (id === 'send-1') await new Promise(resolve => { release = resolve })
      return {...tasks.get(id),state:'ready',translated:'translated ' + id}
    }
    h.api.submitSend = async (id:string) => { submissions.push(id); const task = tasks.get(id); return {state:'sent',result:{taskId:id,account,peer,original:task.request.text,translated:'translated ' + id,fromMe:true,timestamp:sequence + submissions.length}} }
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, 'first message'); await settle()
    ;(h.root.querySelector('.signal-composer button') as HTMLButtonElement).click(); await settle()
    assert.equal((h.root.querySelector('.signal-composer textarea') as HTMLInputElement).value,'')
    input(h.root.querySelector('.signal-composer textarea') as HTMLInputElement, 'second message'); await settle()
    assert.equal((h.root.querySelector('.signal-composer button') as HTMLButtonElement).disabled,false)
    ;(h.root.querySelector('.signal-composer button') as HTMLButtonElement).click(); await settle()
    assert.equal(sequence,2); assert.equal(submissions.length,0); assert.equal(h.root.querySelector('.signal-preview'),null)
    release(true); await settle(); await settle()
    assert.deepEqual(submissions,['send-1','send-2']); assert.equal(h.root.querySelectorAll('.msg.mine').length,2)
    assert.equal((h.root.querySelector('.signal-composer textarea') as HTMLInputElement).value,'')
  } finally { h.close() }
})

test('Signal contact details remove custom notes without changing the official name or archive actions', async () => {
  const h = mount()
  try {
    const edits:any[] = []; h.api.signalSaveContact = async (...args:any[]) => edits.push(args)
    await settle(); (h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    ;(h.root.querySelector('[aria-label="查看 Signal 联系人资料"]') as HTMLButtonElement).click(); await settle()
    assert.equal(h.root.querySelector('.sd-identity h2')?.textContent,'Alex')
    assert.equal(h.root.querySelector('.sd-edit'),null)
    assert.doesNotMatch(h.root.querySelector('.signal-details')?.textContent||'',/昵称与备注|保存昵称与备注/)
    assert.deepEqual(edits,[])
    const archive = [...h.root.querySelectorAll('.sd-actions button')].find(button => button.textContent?.includes('存档')) as HTMLButtonElement
    archive.click(); await settle()
    assert.equal(h.root.querySelectorAll('.signal-contact').length,1)
    ;(h.root.querySelector('[aria-label="Signal 聊天菜单"]') as HTMLButtonElement).click(); await settle()
    ;(h.root.querySelector('.signal-chat-menu button') as HTMLButtonElement).click(); await settle()
    assert.equal(h.root.querySelector('.signal-account b')?.textContent,'已存档聊天')
    assert.equal(h.root.querySelector('.signal-contact-copy b')?.textContent?.trim(),'Alex')
  } finally { h.close() }
})

test('Signal settings apply appearance immediately and Enter preference respects IME composition', async () => {
  const h = mount()
  try {
    await settle(); (h.root.querySelector('[aria-label="打开 Signal 设置"]') as HTMLButtonElement).click(); await settle()
    const appearance = [...h.root.querySelectorAll('.ss-tab')].find(button => button.textContent?.includes('外观')) as HTMLButtonElement
    appearance.click(); await settle()
    const theme = h.root.querySelector('.ss-row select') as HTMLSelectElement
    theme.value = 'light'; theme.dispatchEvent(new dom.window.Event('change',{bubbles:true})); await settle()
    assert.ok(h.root.querySelector('.signal-light'))
    ;(h.root.querySelector('[aria-label="返回 Signal 聊天"]') as HTMLButtonElement).click(); await settle()
    ;(h.root.querySelector('.signal-contact') as HTMLButtonElement).click(); await settle()
    const composer = h.root.querySelector('.signal-composer textarea') as HTMLInputElement
    input(composer,'input method draft')
    composer.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})); await settle()
    assert.equal(h.calls.length,0); assert.equal(composer.value,'input method draft')
  } finally { h.close() }
})
