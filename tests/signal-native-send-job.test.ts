import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import ts from 'typescript'
const require=createRequire(import.meta.url)

test('the actual patched Signal send job persists translation failure without entering transport or network retry',async()=>{
  const message:any={id:'fixture-message',attributes:{body:'fixture text',conversationId:'peer',timestamp:1,sendStateByConversationId:{peer:{status:'Pending'}}},get(key:string){return this.attributes[key]},set(value:any){Object.assign(this.attributes,value)}}
  const conversation:any={id:'peer',attributes:{},get:()=>undefined,getMemberConversationIds:()=>new Set(['peer']),isUntrusted:()=>false,isUnregistered:()=>false,isBlocked:()=>false,getSendTarget:()=> 'fixture-peer'}
  let translated=0,saved=0,networkRetries=0,transport=0
  const stubs:Record<string,any>={
    'lodash':{default:{isNumber:(n:any)=>typeof n==='number'}},
    '../../messages/getMessageById.preload.ts':{getMessageById:async()=>message},
    '../../util/whatTypeOfConversation.dom.ts':{isMe:()=>false},
    '../../state/selectors/message.preload.ts':{isOutgoing:()=>true},
    '../../util/isSignalConversation.dom.ts':{isSignalConversation:()=>false},
    '../../util/getMessageSentTimestamp.std.ts':{getMessageSentTimestamp:()=>1},
    '../../util/editHelpers.std.ts':{getTargetOfThisEditTimestamp:()=>undefined,getPropForTimestamp:({message,prop}:any)=>message[prop]},
    '../../messages/MessageSendState.std.ts':{isSent:(status:string)=>status==='Sent'},
    '../../hellodog/hellodog.preload.ts':{translateHelloDogMessage:async()=>{translated++;throw Error('译文语言与目标不符')}},
    '../../hellodog/hellodog.recovery.preload.ts':require('../integrations/hellodog-source/hellodog.recovery.preload.ts'),
    '../../test-node/util/messageFailures.preload.ts':{markFailed:()=>{message.attributes.sendStateByConversationId.peer.status='Failed'},saveErrorsOnMessage:async(_message:any,errors:Error[])=>{saved++;message.attributes.errors=errors.map(error=>error.message)}},
    './handleMultipleSendErrors.std.ts':{handleMultipleSendErrors:async()=>{networkRetries++;throw Error('Entered day-long retry path')}},
    '../../messages/send.preload.ts':{send:async()=>{transport++}},
  }
  const exports:any={}
  const code=ts.transpileModule(readFileSync(new URL('../integrations/signal-desktop/ts/jobs/helpers/sendNormalMessage.preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  runInNewContext(code,{exports,Error,window:{ConversationController:{get:()=>conversation}},require:(name:string)=>stubs[name]||{}})
  await exports.sendNormalMessage(conversation,{isFinalAttempt:false,shouldContinue:true,timeRemaining:86400000,log:{info(){},warn(){},error(){}},messaging:{}},{messageId:message.id})
  assert.equal(translated,1);assert.equal(saved,1);assert.equal(networkRetries,0);assert.equal(transport,0)
  assert.equal(message.get('body'),'fixture text');assert.equal(message.attributes.sendStateByConversationId.peer.status,'Failed')
  assert.match(message.attributes.errors[0],/目标/)
})
