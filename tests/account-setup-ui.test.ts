import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
const require=createRequire(import.meta.url)
const dom=new JSDOM('<body></body>',{url:'https://hellodog.test/'})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node']) Object.defineProperty(globalThis,key,{configurable:true,value:(dom.window as any)[key]})
const vue=require('vue')
const {descriptor}=parse(readFileSync(new URL('../src/renderer/src/components/AccountSetup.vue',import.meta.url),'utf8'))
const source=compileScript(descriptor,{id:'account-setup-test',inlineTemplate:true}).content
const exports:any={}
runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,document:dom.window.document,window:dom.window,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,URL,console,require:(name:string)=>name==='vue'?vue:require('../src/shared/accountConfig.ts')})
const settle=async()=>{for(let i=0;i<8;i++){await vue.nextTick();await Promise.resolve()}}
function input(el:any,value:string){el.value=value;el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));el.dispatchEvent(new dom.window.Event('change',{bubbles:true}))}
function mount(platform='whatsapp',account?:any){const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root);const saved:any[]=[];const calls:any[]=[];(dom.window as any).desktopAPI={addAccounts:async(args:any)=>{calls.push(args);return [{id:'a',...args.options}]},updateAccount:async(id:string,options:any)=>{calls.push({id,options});return {id,...options}},testAccountProxy:async()=>({ip:'192.0.2.1',latencyMs:25})};const app=vue.createApp(exports.default,{platform,owner:'test-owner',account,languages:[{code:'en-US',name:'English'},{code:'zh-CN',name:'中文'}],onSaved:(a:any)=>saved.push(a)});app.mount(root);return{root,calls,saved,close(){app.unmount();root.remove()}}}
after(()=>dom.window.close())

test('new-window form previews batch names, saves actual switches and uses a separate scroll wrapper',async()=>{
 const h=mount();try{await settle();input(h.root.querySelector('[name=account-name]'),'Team');input(h.root.querySelector('.batch-create input'),'3');await settle();assert.match(h.root.querySelector('.batch-create')!.textContent!,/Team 1、Team 2、Team 3/)
 const switches=h.root.querySelectorAll('.setup-grid .setup-toggle input');assert.ok(switches.length>=4)
 const receive=Array.from(h.root.querySelectorAll('label')).find(x=>x.textContent?.includes('收到的消息显示译文'))!.querySelector('input')!;receive.click();await settle()
 assert.ok(h.root.querySelector('.setup-scroll > fieldset.setup-body'));assert.ok(!h.root.querySelector('.setup-scroll footer'))
 h.root.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(h.calls.length,1);assert.equal(h.calls[0].count,3);assert.equal(h.calls[0].options.receiveAutoTranslate,false);assert.equal(h.saved.length,1)
 }finally{h.close()}
})

test('Signal proxy remains disabled and templates exclude proxy passwords',async()=>{
 const h=mount('signal',{id:'s',label:'Signal',proxy:{enabled:false,host:'private-proxy',password:'not-to-be-saved'}})
 try{await settle();assert.equal((h.root.querySelector('.proxy-heading input') as HTMLInputElement).disabled,true)
 input(h.root.querySelector('input[placeholder="例如 英语客户"]'),'Daily')
 const button=Array.from(h.root.querySelectorAll('button')).find(b=>b.textContent==='保存当前配置为模板')!;button.click();await settle()
 const value=dom.window.localStorage.getItem('hellodog:templates:test-owner')!;assert.ok(value.includes('Daily'));assert.ok(!value.includes('private-proxy'));assert.ok(!value.includes('password'))
 }finally{h.close()}
})

test('proxy detection locks form until completion and displays result without submitting',async()=>{
 const h=mount();try{await settle();(h.root.querySelector('.proxy-heading input') as HTMLInputElement).click();await settle();input(h.root.querySelector('input[placeholder="例如 proxy.example.com"]'),'proxy.example.com')
 let release!:(value:any)=>void;(dom.window as any).desktopAPI.testAccountProxy=()=>new Promise(resolve=>{release=resolve})
 Array.from(h.root.querySelectorAll('button')).find(b=>b.textContent==='检测出口 IP')!.click();await settle();assert.equal((h.root.querySelector('fieldset') as HTMLFieldSetElement).disabled,true)
 release({ip:'192.0.2.1',latencyMs:25});await settle();assert.equal((h.root.querySelector('fieldset') as HTMLFieldSetElement).disabled,false);assert.match(h.root.textContent!,/192.0.2.1/);assert.equal(h.calls.length,0)
 }finally{h.close()}
})

test('global settings categories save real translation, notification and desktop choices; cache clearing requires confirmation',async()=>{
 const {descriptor}=parse(readFileSync(new URL('../src/renderer/src/components/SettingsPanel.vue',import.meta.url),'utf8'))
 const output:any={};const source=compileScript(descriptor,{id:'settings-test',inlineTemplate:true}).content
 runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:output,document:dom.window.document,window:dom.window,localStorage:dom.window.localStorage,console,require:(name:string)=>name==='vue'?vue:{requireSupabase:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'test',email:'test@example.invalid',user_metadata:{}},access_token:'synthetic'}}})}})}})
 const saved:any[]=[];let cleared=0
 ;(dom.window as any).desktopAPI={getSettings:async()=>({provider:'openai',localLanguage:'zh-CN',targetLanguage:'en-US',historyMode:'new',notifications:'background',receiveAutoTranslate:true,sendAutoTranslate:true}),getLanguages:async()=>[],authSetOnlineSession:async()=>{},measureRoutes:async()=>[],diagnoseConnection:async()=>[],saveSettings:async(value:any)=>saved.push(value),getCacheInfo:async()=>({translations:3}),clearTranslationCache:async()=>{cleared++}}
 const root=dom.window.document.createElement('div');dom.window.document.body.appendChild(root);const app=vue.createApp(output.default);app.mount(root)
 const click=(text:string)=>Array.from(root.querySelectorAll('button')).find(b=>b.textContent===text)!.click()
 try{await settle();assert.ok(root.querySelector('.settings-scroll'));input(root.querySelector('select option[value="manual"]')!.parentElement,'manual')
 const toggle=Array.from(root.querySelectorAll('label')).find(x=>x.textContent?.includes('发送前展开译文预览'))!.querySelector('input')!;toggle.click()
 click('通知');await settle();input(root.querySelector('select option[value="off"]')!.parentElement,'off')
 click('运行');await settle();Array.from(root.querySelectorAll('label')).find(x=>x.textContent?.includes('关闭窗口时保留'))!.querySelector('input')!.click()
 click('数据');await settle();click('清理我的翻译缓存…');await settle();assert.equal(cleared,0);click('确认清理');await settle();assert.equal(cleared,1)
 click('保存设置');await settle();assert.equal(saved.length,1);assert.equal(saved[0].historyMode,'manual');assert.equal(saved[0].previewSend,true);assert.equal(saved[0].notifications,'off');assert.equal(saved[0].closeToTray,true)
 }finally{app.unmount();root.remove()}
})
