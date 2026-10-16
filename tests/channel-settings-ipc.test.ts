import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
function fixture(expireAt='',platform='win32'){
 let authorized=true,selected='openai',available=true,blockChineseSend=true,chineseSaveFailure=false,voiceBarrier:()=>Promise<void>=async()=>{},signalBarrier:()=>Promise<void>=async()=>{};const handlers=new Map<string,Function>(),calls:any[]=[],validated:string[]=[],account:any={id:'signal-a',platform:'signal',signalEngine:'desktop',blockChineseSend:true}
 const settings={get:async()=>({provider:'openai',translationProvider:selected,blockChineseSend}),save:async(value:any)=>{calls.push(['settings',value]);selected=value.translationProvider;blockChineseSend=value.blockChineseSend!==false}}
 const sections=[
  source.slice(source.indexOf("  ipcMain.handle('translator:channels',"),source.indexOf("  const googleVoiceRecords")),
  source.slice(source.indexOf("  ipcMain.handle('translator:test',"),source.indexOf("  ipcMain.handle('signal:translate-message'")),
  source.slice(source.indexOf("  ipcMain.handle('accounts:add',"),source.indexOf("  ipcMain.handle('accounts:test-proxy'")),
  source.slice(source.indexOf("  ipcMain.handle('accounts:update',"),source.indexOf("  ipcMain.handle('accounts:set-contact-language'")),
  source.slice(source.indexOf("  ipcMain.handle('google-voice:add',"),source.indexOf("  ipcMain.handle('google-voice:update'")),
  source.slice(source.indexOf("  ipcMain.handle('settings:save',"),source.indexOf("  ipcMain.handle('translator:get-runtime-settings'"))
 ]
 runInNewContext(ts.transpileModule(sections.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},process:{platform},settings,sendPolicyRevision:0,sendPolicyChanging:0,
  readTranslationChannels:async(_base:unknown,force:boolean)=>{calls.push(['channels',force]);return {checked:true}},
  requireMain:(event:any)=>{if(event.sender!==1)throw Error('main only')},requireAuth:async()=>true,taskIdentity:()=>({authorized:()=>authorized}),
  requireSelectableChannel:async(value:string)=>{validated.push(value);if(expireAt==='channel')authorized=false;if(!available)throw Error('通道尚未启用');return value},
  requestChannelPreference:async(value:string)=>{if(expireAt==='preference')authorized=false;return value},
  translator:{testWithSettings:async(_settings:any,request:any)=>{calls.push(['test',request]);if(expireAt==='result')authorized=false;return '译文'},translate:async(request:any)=>{calls.push(['test',request]);if(expireAt==='result')authorized=false;return '译文'}},
  accounts:{list:async()=>[account],update:async(_id:string,patch:any)=>{calls.push(['account-update',patch]);Object.assign(account,patch);return {...account}},setChineseSendPolicy:async(value:boolean)=>{if(chineseSaveFailure)throw Error('fixture atomic account write failed');calls.push(['chinese',value])},add:async(...args:any[])=>{calls.push(['account',...args]);return args.at(-1)},addBatch:async(...args:any[])=>{calls.push(['batch',...args]);return args.at(-1)}},googleVoice:{add:async(options:any)=>{calls.push(['voice',options]);return options},invalidateContext:()=>{},invalidateSendContext:()=>voiceBarrier()},
  webAdapter:()=>undefined,signal:{resumeReceiving:async()=>{}},applyDesktopOptions:()=>{},setCloudRoute:()=>{},whatsapp:{resumeTranslations:()=>{},invalidateSendPolicy:async()=>{}},telegram:{resumeTranslations:()=>{},invalidateSendPolicy:async()=>{}},signalDesktop:{refresh:()=>{},invalidateSendPolicy:()=>signalBarrier()},mainWindow:{webContents:{send:()=>{}}}
 })
 return {calls,validated,account,select:(value:string)=>selected=value,disable:()=>available=false,failChinese:()=>{chineseSaveFailure=true},barrier:(value:()=>Promise<void>)=>voiceBarrier=value,signalBarrier:(value:()=>Promise<void>)=>signalBarrier=value,logout:()=>authorized=false,blockChinese:()=>blockChineseSend,invoke:(name:string,...args:any[])=>handlers.get(name)!({sender:1},...args)}
}

test('global Chinese switch applies to existing windows and rolls back if their atomic save fails',async()=>{
 const h=fixture();await h.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false})
 assert.equal(h.blockChinese(),false);assert.deepEqual(h.calls.map(call=>call[0]),['settings','chinese']);assert.equal(h.calls[1][1],false)
 const failed=fixture();failed.failChinese()
 await assert.rejects(failed.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false}),/account write failed/)
 assert.equal(failed.blockChinese(),true);assert.equal(failed.calls.length,2);assert.equal(failed.calls[1][1].blockChineseSend,true)
})

test('Chinese settings are not persisted until Voice acknowledges, and lost acknowledgement or changed identity preserves settings',async()=>{
 const h=fixture();let release!:()=>void,entered=false
 h.barrier(()=>{entered=true;return new Promise(resolve=>release=resolve)})
 const work=h.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false})
 for(let n=0;n<20;n++)await Promise.resolve();assert.equal(entered,true);assert.equal(h.calls.length,0);assert.equal(h.blockChinese(),true)
 release();await work;assert.equal(h.blockChinese(),false)
 for(const logout of [false,true]){
  const failed=fixture();failed.barrier(async()=>{if(logout)failed.logout();else throw Error('Voice 未确认')})
  await assert.rejects(failed.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false}),/未确认|登录状态/)
  assert.equal(failed.calls.length,0);assert.equal(failed.blockChinese(),true)
 }
})

test('global and per-window Chinese switch writes both await native Signal cancellation acknowledgement',async()=>{
 for(const global of [false,true]){
  const h=fixture();let release!:()=>void,entered=false
  h.signalBarrier(()=>{entered=true;return new Promise(resolve=>release=resolve)})
  const work=global?h.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false}):h.invoke('accounts:update','signal-a',{blockChineseSend:false})
  for(let n=0;n<25;n++)await Promise.resolve();assert.equal(entered,true);assert.equal(h.calls.length,0)
  release();await work;assert.equal(global?h.blockChinese():h.account.blockChineseSend,false)
  const failed=fixture();failed.signalBarrier(async()=>{throw Error('Signal 尚未确认发送设置')})
  await assert.rejects(global?failed.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false}):failed.invoke('accounts:update','signal-a',{blockChineseSend:false}),/Signal 尚未确认/)
  assert.equal(failed.calls.length,0);assert.equal(failed.account.blockChineseSend,true);assert.equal(failed.blockChinese(),true)
 }
})
test('each new WhatsApp, Signal, Telegram and Voice window captures the selected default without changing old windows',async()=>{
 const h=fixture()
 for(const platform of ['whatsapp','signal','telegram']){const result=await h.invoke('accounts:add',{platform,label:'New'});assert.equal(result.translationProvider,'openai')}
 assert.equal((await h.invoke('google-voice:add',{label:'New Voice'})).translationProvider,'openai')
 h.select('deepseek');assert.equal((await h.invoke('accounts:add-batch',{platform:'whatsapp',count:2})).translationProvider,'deepseek')
 assert.equal(h.calls.filter(call=>call[0]==='settings').length,0)
})

test('new Mac Signal windows use the bundled desktop core without replacing explicit or linked legacy choices',async()=>{
 const mac=fixture('','darwin'),windows=fixture()
 for(const name of ['accounts:add','accounts:add-batch']){
  assert.equal((await mac.invoke(name,{platform:'signal',count:2})).signalEngine,'desktop')
  assert.equal((await windows.invoke(name,{platform:'signal',count:2})).signalEngine,undefined)
  assert.equal((await mac.invoke(name,{platform:'signal',count:2,options:{signalEngine:'cli'}})).signalEngine,'cli')
  assert.equal((await mac.invoke(name,{platform:'whatsapp',count:2})).signalEngine,undefined)
 }
 assert.equal((await mac.invoke('accounts:add',{platform:'signal',signalAccount:'+12025550123'})).signalEngine,undefined)
})

test('new windows inherit Chinese policy and unrelated preference saves preserve it',async()=>{
 const h=fixture();await h.invoke('settings:save',{translationProvider:'openai',blockChineseSend:false})
 await h.invoke('settings:save',{translationProvider:'openai',fontSize:15});assert.equal(h.blockChinese(),false)
 for(const platform of ['whatsapp','signal','telegram'])assert.equal((await h.invoke('accounts:add',{platform})).blockChineseSend,false)
 assert.equal((await h.invoke('accounts:add-batch',{platform:'whatsapp',count:2})).blockChineseSend,false)
 assert.equal((await h.invoke('accounts:add',{platform:'telegram',options:{blockChineseSend:true}})).blockChineseSend,true)
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
