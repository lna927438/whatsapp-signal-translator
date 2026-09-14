import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import type {SendTaskData} from '../src/main/translation/sendTasks'
const require=createRequire(import.meta.url)
const {alreadyInTargetLanguage,hasBlockedChinese}=require('../src/main/translation/outgoingPolicy.ts')
const {SendTasks,SendNotStartedError}=require('../src/main/translation/sendTasks.ts')
const english='Thanks for sharing this. I think that the message was clear, and you should have the information you need.\nHave a good evening!'

test('already-English prose stays English while mixed or ambiguous languages still require translation',()=>{
  const check=(text:string,targetLanguage='en-US',quality?:any)=>alreadyInTargetLanguage({text,targetLanguage,quality})
  assert.equal(check(english),true)
  assert.equal(check('Thank you!'),true)
  for(const text of ['Hola gracias por todo','bonjour merci vous êtes gentil','Michael','This is 你好','no gracias','the','Ciao how are you today'])assert.equal(check(text),false,text)
  assert.equal(check(english,'es'),false)
  assert.equal(check(english,'en-US',{tone:'business'}),false)
  assert.equal(check('https://the.you.is.example'),false)
})

for(const platform of ['signal','whatsapp'])test(`${platform}: an English outgoing message bypasses API billing and sends once`,async()=>{
  let data:SendTaskData={tasks:[]},calls=0,sends=0
  const store={read:async()=>structuredClone(data),write:async(value:SendTaskData)=>{data=structuredClone(value)}}
  const tasks=new SendTasks(store)
  const task=await tasks.prepare('owner',{platform,accountId:'a',conversationId:'c',translate:true,blockChinese:true,request:{text:english,sourceLanguage:'zh-CN',targetLanguage:'en-US'}})
  await tasks.translate('owner',task.id,async()=>{calls++;return '错误的反向中文译文'},()=>true)
  const send=async(value:any)=>{sends++;assert.equal(value.translated,english);return {id:'fixture-only'}}
  await tasks.submit('owner',task.id,send,()=>true)
  await new SendTasks(store).submit('owner',task.id,send,()=>true)
  assert.equal(calls,0);assert.equal(sends,1)
})

test('Chinese guard follows the selected target, including Japanese Han characters',()=>{
  assert.equal(hasBlockedChinese('你好','en-US'),true)
  assert.equal(hasBlockedChinese('你好','zh-CN'),false)
  assert.equal(hasBlockedChinese('您好','zh-TW'),false)
  assert.equal(hasBlockedChinese('本日は晴れです','ja'),false)
})

test('wrong-language output remains unsent and does not submit a platform command',async()=>{
  let data:SendTaskData={tasks:[]},sends=0
  const tasks=new SendTasks({read:async()=>structuredClone(data),write:async(value:SendTaskData)=>{data=structuredClone(value)}})
  const task=await tasks.prepare('owner',{platform:'signal',accountId:'a',conversationId:'c',translate:true,blockChinese:true,request:{text:'您好，请确认时间。',sourceLanguage:'zh-CN',targetLanguage:'en-US'}})
  await tasks.translate('owner',task.id,async()=> '错误译文',()=>true)
  await assert.rejects(tasks.submit('owner',task.id,async()=>{sends++},()=>true),SendNotStartedError)
  assert.equal(sends,0);assert.equal((await tasks.get('owner',task.id)).state,'ready')
})
