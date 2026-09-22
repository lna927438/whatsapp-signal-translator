import { createUiLocaleHarness } from './ui-locale-harness.ts'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as translationChannels from '../src/shared/translationChannels'
import { parse, compileScript } from '@vue/compiler-sfc'
const require = createRequire(import.meta.url)
const dom = new JSDOM('<body></body>', { url: 'https://hellodog.test/' })
for (const key of ['window','document','Element','HTMLElement','SVGElement','Node']) Object.defineProperty(globalThis,key,{configurable:true,value:(dom.window as any)[key]})
const vue = require('vue'), { uiLocale } = createUiLocaleHarness()
function component(name: string) {
  const { descriptor } = parse(readFileSync(new URL('../src/renderer/src/components/'+name+'.vue', import.meta.url),'utf8'))
  const compiled = compileScript(descriptor,{id:'experience-'+name,inlineTemplate:true}).content, exports:any = {}
  runInNewContext(ts.transpileModule(compiled,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, { exports, document:dom.window.document, window:dom.window, console, setInterval, clearInterval, require:(name:string) => name==='vue'?vue:name.includes('uiLocale')?uiLocale:name.includes('translationChannels')?translationChannels:name.endsWith('.vue')?{default:{render:()=>vue.h('span')}}:require(name) })
  return exports.default
}
const settle=async()=>{for(let i=0;i<10;i++){await vue.nextTick();await Promise.resolve()}}
function mount(name:string,props:any){const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root);const app=vue.createApp(component(name),props);app.mount(root);return{root,close(){app.unmount();root.remove()}}}
const button=(root:HTMLElement,text:string)=>Array.from(root.querySelectorAll('button')).find(el=>el.textContent?.trim()===text)!
after(()=>dom.window.close())

test('colour selection is a draft until confirmed; cancelling never persists and failures retain the editor',async()=>{
  const writes:string[]=[],h=mount('ConfirmColor',{value:'#112233',save:async(value:string)=>{writes.push(value);if(value==='#ff0000')throw Error('Save unavailable')}})
  try {
    h.root.querySelector('button')!.click();await settle()
    let input=h.root.querySelector('input')!;input.value='#00ff00';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle()
    assert.deepEqual(writes,[]);assert.equal((h.root.querySelector('.color-preview') as HTMLElement).style.color,'rgb(0, 255, 0)')
    button(h.root,'取消').click();await settle();assert.deepEqual(writes,[]);assert.equal(h.root.querySelector('input'),null)
    h.root.querySelector('button')!.click();await settle();input=h.root.querySelector('input')!;assert.equal(input.value,'#112233')
    input.value='#ff0000';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));button(h.root,'确定').click();await settle();assert.match(h.root.textContent!,/Save unavailable/);assert.ok(h.root.querySelector('input'))
    input.value='#abcdef';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));button(h.root,'确定').click();await settle();assert.deepEqual(writes,['#ff0000','#abcdef']);assert.equal(h.root.querySelector('input'),null)
  } finally {h.close()}
})

test('provider choice blocks unavailable channels and never announces a failed save as selected',async()=>{
  const writes:string[]=[],props=vue.reactive({value:'deepseek',channels:{deepseek:{available:true},openai:{available:false,reason:'未启用'}},save:async(value:string)=>{writes.push(value);throw Error('线路不可用')}})
  const h=mount('TranslationChannelSelector',props)
  try {
    let target=Array.from(h.root.querySelectorAll('button')).find(el=>el.textContent?.includes('OpenAI'))!;assert.equal(target.disabled,true);target.click();await settle();assert.deepEqual(writes,[])
    props.channels.openai.available=true;await settle();target.click();await settle();assert.deepEqual(writes,['openai']);assert.match(h.root.textContent!,/线路不可用/);assert.equal(target.getAttribute('aria-pressed'),'false');assert.equal(button(h.root,'DeepSeek').getAttribute('aria-pressed'),'true')
  } finally {h.close()}
})

test('unavailable model names remain visible without allowing selection',async()=>{
  const reason='当前通道尚未启用。',writes:string[]=[]
  const h=mount('TranslationChannelSelector',{value:'',channels:{deepseek:{available:false,reason,displayName:'deepseek-v4-pro'},openai:{available:false,reason,displayName:'gpt-5.6-luna'}},save:async(value:string)=>{writes.push(value)}})
  try {
    assert.equal(h.root.querySelector('[aria-pressed="true"]'),null)
    for(const target of h.root.querySelectorAll('button')){assert.equal(target.disabled,true);target.click()}
    await settle();assert.deepEqual(writes,[]);assert.match(h.root.textContent!,/DeepSeek · deepseek-v4-pro/);assert.match(h.root.textContent!,/OpenAI · gpt-5.6-luna/)
  } finally {h.close()}
})

test('notifications only show a download action for a verified newer version',async()=>{
  const props=vue.reactive({snapshot:{update:{verified:true,status:'current',currentVersion:'1.0.0',latestVersion:'1.0.0',notes:'Latest release'},notices:[{id:'a',revision:1,starts_at:'2026-09-22',title:'Notice',body:'Body',action:'download',dismissed:true}]}})
  const h=mount('NotificationCenter',props)
  try {
    await settle();assert.match(h.root.textContent!,/已是当前最新版本/);assert.ok(!button(h.root,'前往官网更新'))
    props.snapshot.update.status='unknown';props.snapshot.update.verified=false;await settle();assert.match(h.root.textContent!,/版本检查尚未完成/);assert.ok(!button(h.root,'前往官网更新'))
    props.snapshot.update.status='available';props.snapshot.update.verified=true;props.snapshot.update.latestVersion='1.1.0';await settle();assert.match(h.root.textContent!,/发现新版本 1.1.0/);assert.ok(button(h.root,'前往官网更新'))
  } finally {h.close()}
})

test('account profile reads totals without requesting the detailed transaction snapshot or usage log',()=>{
  const source=readFileSync(new URL('../src/renderer/src/components/PersonalCenter.vue',import.meta.url),'utf8')
  assert.match(source,/await cloudApi\.me\(\)/);assert.doesNotMatch(source,/cloudApi\.(snapshot|usage)\(/);assert.doesNotMatch(source,/usage-list|request_id|最近云端翻译消耗/)
})

test('update banner requires verified available status even if a stale show flag remains',async()=>{
  for(const [status,verified,visible] of [['unknown',false,false],['current',true,false],['available',false,false],['available',true,true]] as const){
    ;(dom.window as any).desktopAPI={updateNotice:async()=>({show:true,status,verified,latestVersion:'1.1.0',currentVersion:'1.0.0'})}
    const h=mount('UpdateNotice',{})
    try{await settle();assert.equal(!!h.root.querySelector('.update-notice'),visible)}finally{h.close()}
  }
})

test('settings version page never treats a cached installer manifest as a current official release',async()=>{
  for(const status of ['unknown','current','ahead','available']){
    ;(dom.window as any).desktopAPI={updateNotice:async()=>({status,verified:status!=='unknown',currentVersion:'1.0.0',latestVersion:'1.1.0'}),reliabilityHistory:async()=>[],reliabilityStatus:async()=>({accounts:[],metrics:{}}),updateInfo:async()=>({currentVersion:'1.0.0',manifest:{version:'0.9.0',size:100,sha256:'synthetic',channel:'stable'},newer:false}),getSettings:async()=>({}),contentRetention:async()=>({days:0})}
    const h=mount('SettingsUpdates',{})
    try{await settle();assert.equal(!!button(h.root,'前往官网更新'),status==='available');assert.equal(h.root.textContent!.includes('已是当前最新版本'),status==='current');if(status==='unknown')assert.match(h.root.textContent!,/版本检查尚未完成/)}finally{h.close()}
  }
})

test('settings version check forces signed metadata refresh and download actions follow the verified manifest',async()=>{
 let version='1.0.0',phase='available';const calls:any[]=[]
 ;(dom.window as any).desktopAPI={
  updateNotice:async(force:boolean)=>{calls.push(['notice',force]);return {status:version==='1.0.0'?'current':'available',verified:true,currentVersion:'1.0.0',latestVersion:version}},
  updateInfo:async()=>({currentVersion:'1.0.0',manifest:{version,channel:'stable',size:100},newer:version!=='1.0.0',phase}),
  checkUpdate:async(channel:string)=>{calls.push(['check',channel])},downloadUpdate:async()=>{calls.push(['download']);phase='verified'},openUpdateInstaller:async()=>{calls.push(['install']);phase='opened'},openOfficialWebsite:async()=>calls.push(['website']),restartApp:async()=>calls.push(['restart'])
 }
 ;(dom.window as any).__HELLODOG_PREPARE_RESTART__=async()=>calls.push(['prepare'])
 const h=mount('SettingsUpdates',{})
 try{
  await settle();assert.match(h.root.textContent!,/已是当前最新版本/);assert.equal(button(h.root,'前往官网更新'),undefined)
  version='1.1.0';button(h.root,'检查更新').click();await settle();assert.ok(calls.some(call=>call[0]==='notice'&&call[1]===true));assert.deepEqual(calls.find(call=>call[0]==='check'),['check','stable'])
  button(h.root,'下载并校验').click();await settle();await settle();assert.ok(button(h.root,'打开已校验的安装包'));assert.equal(calls.filter(call=>call[0]==='download').length,1)
  button(h.root,'打开已校验的安装包').click();await settle();await settle();assert.ok(calls.findIndex(call=>call[0]==='prepare')<calls.findIndex(call=>call[0]==='install'))
  button(h.root,'前往官网').click();await settle();button(h.root,'一键重启').click();await settle();assert.equal(calls.filter(call=>call[0]==='website').length,1);assert.equal(calls.filter(call=>call[0]==='restart').length,1)
 }finally{h.close();delete (dom.window as any).__HELLODOG_PREPARE_RESTART__}
})

test('restart and website errors stay visible; duplicate pending restart clicks do not submit twice',async()=>{
 let release!:()=>void,calls=0
 ;(dom.window as any).desktopAPI={updateNotice:async()=>({verified:true,status:'current',currentVersion:'1.0.0'}),updateInfo:async()=>({currentVersion:'1.0.0'}),restartApp:async()=>{calls++;await new Promise<void>(resolve=>release=resolve);throw Error('草稿保存失败，未重启')},openOfficialWebsite:async()=>{throw Error('官网打开失败')}}
 const h=mount('SettingsUpdates',{})
 try{await settle();const target=button(h.root,'一键重启');target.click();target.click();await settle();assert.equal(calls,1);assert.equal(target.disabled,true);release();await settle();assert.match(h.root.querySelector('[role=alert]')!.textContent!,/草稿保存失败/);assert.equal(button(h.root,'一键重启').disabled,false);button(h.root,'前往官网').click();await settle();assert.match(h.root.querySelector('[role=alert]')!.textContent!,/官网打开失败/)}finally{h.close()}
})

test('failed version refresh hides stale download and installation actions; draft save failure blocks installer',async()=>{
 let fail=false,installed=0,checked=0
 ;(dom.window as any).desktopAPI={updateNotice:async()=>{if(fail)throw Error('更新服务不可用');return {verified:true,status:'available',latestVersion:'1.1.0',currentVersion:'1.0.0'}},updateInfo:async()=>({currentVersion:'1.0.0',manifest:{version:'1.1.0',channel:'stable',size:100},newer:true,phase:'verified'}),checkUpdate:async()=>checked++,openUpdateInstaller:async()=>installed++}
 ;(dom.window as any).__HELLODOG_PREPARE_RESTART__=async()=>{throw Error('设置仍未保存')}
 const h=mount('SettingsUpdates',{})
 try{await settle();button(h.root,'打开已校验的安装包').click();await settle();assert.equal(installed,0);assert.match(h.root.querySelector('[role=alert]')!.textContent!,/设置仍未保存/);fail=true;button(h.root,'检查更新').click();await settle();assert.match(h.root.querySelector('[role=alert]')!.textContent!,/更新服务不可用/);assert.equal(button(h.root,'打开已校验的安装包'),undefined);assert.equal(button(h.root,'前往官网更新'),undefined);assert.equal(checked,1)}finally{h.close();delete (dom.window as any).__HELLODOG_PREPARE_RESTART__}
})
