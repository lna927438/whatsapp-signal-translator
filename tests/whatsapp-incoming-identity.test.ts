import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import ts from 'typescript'
const {SendTasks}=createRequire(import.meta.url)('../src/main/translation/sendTasks.ts')
const {reusableDisplayOriginal}=createRequire(import.meta.url)('../src/shared/translationResult.ts')

async function setup(original='原文', translated='translated text'){
 let data:any={tasks:[]},paid=0,detected=0
 const tasks=new SendTasks({read:async()=>structuredClone(data),write:async(value:any)=>{data=structuredClone(value)}})
 const task=await tasks.prepare('owner',{platform:'whatsapp',accountId:'wa',conversationId:'chat',translate:true,request:{text:original,sourceLanguage:'zh-CN',targetLanguage:'en-US'}})
 await tasks.translate('owner',task.id,async()=> translated,()=>true)
 await tasks.submit('owner',task.id,async()=>({messageId:'opaque-native-id'}),()=>true)
 const file=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
 const source=file.slice(file.indexOf("  ipcMain.handle('translator:cached-incoming'"),file.indexOf("  ipcMain.handle('translator:translate-outgoing'"))
 const handlers=new Map<string,Function>()
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  ipcMain:{handle:(name:string,handler:Function)=>handlers.set(name,handler)},requireAuth:async()=>true,
  whatsapp:{ownsSender:(account:string,sender:number)=>account==='wa'&&sender===7},normalizePayload:(value:any)=>value,
  accountRuntime:async()=>({localLanguage:'zh-CN'}),taskIdentity:()=>({owner:'owner'}),sendTasks:tasks,reusableDisplayOriginal,
  translator:{cached:async()=>undefined,translateIncoming:async()=>{paid++;return 'new translation'}},
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
