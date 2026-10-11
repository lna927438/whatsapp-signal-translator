import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
function fixture(expireAt=''){
 let authorized=true,selected='openai',available=true;const handlers=new Map<string,Function>(),calls:any[]=[],validated:string[]=[]
 const settings={get:async()=>({provider:'openai',translationProvider:selected}),save:async(value:any)=>{calls.push(['settings',value]);selected=value.translationProvider}}
 const sections=[
  source.slice(source.indexOf("  ipcMain.handle('translator:channels',"),source.indexOf("  const googleVoiceRecords")),
  source.slice(source.indexOf("  ipcMain.handle('translator:test',"),source.indexOf("  ipcMain.handle('signal:translate-message'")),
  source.slice(source.indexOf("  ipcMain.handle('accounts:add',"),source.indexOf("  ipcMain.handle('accounts:test-proxy'")),
  source.slice(source.indexOf("  ipcMain.handle('google-voice:add',"),source.indexOf("  ipcMain.handle('google-voice:update'")),
  source.slice(source.indexOf("  ipcMain.handle('settings:save',"),source.indexOf("  ipcMain.handle('translator:get-runtime-settings'"))
 ]
 runInNewContext(ts.transpileModule(sections.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},settings,
  readTranslationChannels:async(_base:unknown,force:boolean)=>{calls.push(['channels',force]);return {checked:true}},
  requireMain:(event:any)=>{if(event.sender!==1)throw Error('main only')},requireAuth:async()=>true,taskIdentity:()=>({authorized:()=>authorized}),
  requireSelectableChannel:async(value:string)=>{validated.push(value);if(expireAt==='channel')authorized=false;if(!available)throw Error('通道尚未启用');return value},
  requestChannelPreference:async(value:string)=>{if(expireAt==='preference')authorized=false;return value},
  translator:{testWithSettings:async(_settings:any,request:any)=>{calls.push(['test',request]);if(expireAt==='result')authorized=false;return '译文'},translate:async(request:any)=>{calls.push(['test',request]);if(expireAt==='result')authorized=false;return '译文'}},
  accounts:{add:async(...args:any[])=>{calls.push(['account',...args]);return args.at(-1)},addBatch:async(...args:any[])=>{calls.push(['batch',...args]);return args.at(-1)}},googleVoice:{add:async(options:any)=>{calls.push(['voice',options]);return options},invalidateContext:()=>{}},
  applyDesktopOptions:()=>{},setCloudRoute:()=>{},whatsapp:{resumeTranslations:()=>{}},telegram:{resumeTranslations:()=>{}},signalDesktop:{refresh:()=>{}},mainWindow:{webContents:{send:()=>{}}}
 })
 return {calls,validated,select:(value:string)=>selected=value,disable:()=>available=false,invoke:(name:string,...args:any[])=>handlers.get(name)!({sender:1},...args)}
}
test('each new WhatsApp, Signal, Telegram and Voice window captures the selected default without changing old windows',async()=>{
 const h=fixture()
 for(const platform of ['whatsapp','signal','telegram']){const result=await h.invoke('accounts:add',{platform,label:'New'});assert.equal(result.translationProvider,'openai')}
 assert.equal((await h.invoke('google-voice:add',{label:'New Voice'})).translationProvider,'openai')
 h.select('deepseek');assert.equal((await h.invoke('accounts:add-batch',{platform:'whatsapp',count:2})).translationProvider,'deepseek')
 assert.equal(h.calls.filter(call=>call[0]==='settings').length,0)
})
test('the model test takes the visible explicit selection rather than server default or stored selection',async()=>{
 const h=fixture();assert.equal((await h.invoke('translator:test-config',{provider:'openai',translationProvider:'deepseek'},'Hello','zh-CN')).ok,true)
 assert.equal(h.calls[0][1].providerPreference,'deepseek');assert.deepEqual(h.validated,['deepseek'])
 assert.equal(await h.invoke('translator:test','Hello','zh-CN'),'译文');assert.equal(h.calls[1][1].providerPreference,'openai')
})
test('disabled channels reject test/default changes before creating windows, translations or settings writes',async()=>{
 const h=fixture();h.disable()
 assert.equal((await h.invoke('translator:test-config',{translationProvider:'openai'},'Hello','zh-CN')).ok,false)
 await assert.rejects(h.invoke('accounts:add',{platform:'whatsapp'}),/未启用/);await assert.rejects(h.invoke('google-voice:add',{}),/未启用/)
 await assert.rejects(h.invoke('settings:save',{translationProvider:'deepseek'}),/未启用/)
 assert.deepEqual(h.calls,[])
 // An existing selected model becoming unavailable must not block an unrelated preference save.
 await h.invoke('settings:save',{translationProvider:'openai',fontSize:15});assert.equal(h.calls[0][0],'settings')
})
test('identity changes during channel checks or a completed test never return another users result',async()=>{
 for(const expireAt of ['channel','preference','result']){
  const h=fixture(expireAt),result=await h.invoke('translator:test-config',{translationProvider:'openai'},'Hello','zh-CN')
  assert.equal(result.ok,false);assert.match(result.message,/登录状态已变化/)
  assert.equal(h.calls.length,expireAt==='result'?1:0)
 }
 for(const name of ['accounts:add','google-voice:add']){const h=fixture('channel');await assert.rejects(h.invoke(name,{platform:'whatsapp'}),/登录状态已变化/);assert.equal(h.calls.length,0)}
})

test('manual channel refresh forwards only a boolean through the authenticated IPC boundary',async()=>{
 const h=fixture()
 await h.invoke('translator:channels');await h.invoke('translator:channels',true)
 assert.deepEqual(h.calls,[['channels',false],['channels',true]])
 for(const value of ['true',1,null,{}])await assert.rejects(h.invoke('translator:channels',value),/刷新参数无效/)
 assert.equal(h.calls.length,2)
})
