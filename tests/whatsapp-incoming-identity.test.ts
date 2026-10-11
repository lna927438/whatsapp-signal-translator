import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import ts from 'typescript'
import {createHash} from 'node:crypto'
const {SendTasks}=createRequire(import.meta.url)('../src/main/translation/sendTasks.ts')
const {reusableDisplayOriginal}=createRequire(import.meta.url)('../src/shared/translationResult.ts')

async function setup(original='原文', translated='translated text',expireAt=''){
 let data:any={tasks:[]},paid=0,detected=0,authorized=true
 const tasks=new SendTasks({read:async()=>structuredClone(data),write:async(value:any)=>{data=structuredClone(value)}})
 const task=await tasks.prepare('owner',{platform:'whatsapp',accountId:'wa',conversationId:'chat',translate:true,request:{text:original,sourceLanguage:'zh-CN',targetLanguage:'en-US'}})
 await tasks.translate('owner',task.id,async()=> translated,()=>true)
 await tasks.submit('owner',task.id,async()=>({messageId:'opaque-native-id'}),()=>true)
 const file=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
 const source=file.slice(file.indexOf("  ipcMain.handle('translator:cached-incoming'"),file.indexOf("  ipcMain.handle('translator:test'"))
 const handlers=new Map<string,Function>()
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  ipcMain:{handle:(name:string,handler:Function)=>handlers.set(name,handler)},requireAuth:async()=>true,
  whatsapp:{ownsSender:(account:string,sender:number)=>account==='wa'&&sender===7},ownsWebSender:(account:string,sender:number)=>account==='wa'&&sender===7,normalizePayload:(value:any)=>value,
  accountRuntime:async()=>{if(expireAt==='runtime')authorized=false;return {localLanguage:'zh-CN'}},taskIdentity:()=>({owner:'owner',authorized:()=>authorized}),sendTasks:tasks,reusableDisplayOriginal,
  translator:{cached:async()=>{if(expireAt==='cache')authorized=false;return undefined},translateIncoming:async()=>{paid++;if(expireAt==='result')authorized=false;return 'new translation'},translate:async()=>{paid++;if(expireAt==='result')authorized=false;return 'new translation'}},
  detectContactLanguage:()=>{detected++;return undefined},announceConversation:()=>{}
 })
 return {call:(channel:string,payload:any,sender=7)=>handlers.get('translator:'+channel)!({sender:{id:sender}},'wa',payload),get paid(){return paid},get detected(){return detected}}
}

test('an outgoing native ID restores the original even when its DOM direction marker is absent',async()=>{
 const h=await setup(),payload={messageId:'opaque-native-id',text:'translated text',conversationId:'chat',outgoing:false}
 assert.equal(await h.call('cached-incoming',payload),'原文')
 assert.equal(await h.call('translate-incoming',payload),'原文')
 assert.equal(h.paid,0);assert.equal(h.detected,0)
})

test('a session switch during channel lookup cannot translate or charge the new account',async()=>{
 for(const channel of ['cached-incoming','translate-incoming','translate-outgoing']){
  const h=await setup('原文','translated text','runtime')
  await assert.rejects(h.call(channel,{text:'hello',outgoing:true}),/登录状态已变化/)
  assert.equal(h.paid,0)
 }
})

test('results cannot return to a different owner after cache or paid work completes',async()=>{
 for(const channel of ['cached-incoming','translate-incoming','translate-outgoing']){
  const h=await setup('原文','translated text',channel==='cached-incoming'?'cache':'result')
  await assert.rejects(h.call(channel,{text:'hello',outgoing:true}),/登录状态已变化/)
 }
})

test('an English original with cosmetic punctuation differences does not replace the Chinese display translation',async()=>{
 const text="You're very direct, George!",h=await setup('You’re very direct, George!',text);
 const payload={messageId:'opaque-native-id',text,conversationId:'chat',outgoing:true};
 assert.equal(await h.call('cached-incoming',payload),undefined);
 assert.equal(await h.call('translate-incoming',payload),'new translation');assert.equal(h.paid,1);
})

test('an English paraphrase is not displayed as a Chinese original',async()=>{
 const text='You are really direct!',h=await setup('You are very direct, George!',text);
 const payload={messageId:'opaque-native-id',text,conversationId:'chat',outgoing:true};
 assert.equal(await h.call('cached-incoming',payload),undefined);
 assert.equal(await h.call('translate-incoming',payload),'new translation');
})

test('a different message with identical text still has its own incoming translation',async()=>{
 const h=await setup(),payload={messageId:'another-native-id',text:'translated text',conversationId:'chat',outgoing:false}
 assert.equal(await h.call('cached-incoming',payload),undefined)
 assert.equal(await h.call('translate-incoming',payload),'new translation');assert.equal(h.paid,1)
})

test('edited native text cannot reuse an original for the previous message body',async()=>{
 const h=await setup(),payload={messageId:'opaque-native-id',text:'edited text',conversationId:'chat',outgoing:true}
 assert.equal(await h.call('cached-incoming',payload),undefined)
 assert.equal(await h.call('translate-incoming',payload),'new translation');assert.equal(h.paid,1)
 await assert.rejects(h.call('cached-incoming',payload,99),/账号窗口不匹配/)
})

test('back translation pins the task channel and refuses an identity change during receipt lookup',async()=>{
 const file=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
 const source=file.slice(file.indexOf("  ipcMain.handle('send:back-translate'"),file.indexOf("  ipcMain.handle('send:submit'"))
 for(const expire of [false,true]){
  let authorized=true,paid=0,handler:Function=()=>assert.fail('Missing handler')
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   ipcMain:{handle:(_name:string,value:Function)=>{handler=value}},createHash,
   taskIdentity:()=>({owner:'owner',authorized:()=>authorized}),assertTaskSender:()=>{},
   sendTasks:{get:async()=>{if(expire)authorized=false;return {state:'ready',accountId:'wa',conversationId:'peer',request:{providerPreference:'openai',targetLanguage:'en-US',sourceLanguage:'zh-CN'}}}},
   translator:{translate:async(request:any)=>{paid++;assert.equal(request.providerPreference,'openai');return '回翻'}}
  })
  if(expire){await assert.rejects(handler({},'send-original','Hello'),/登录状态已变化/);assert.equal(paid,0)}
  else {assert.equal(await handler({},'send-original','Hello'),'回翻');assert.equal(paid,1)}
 }
})
