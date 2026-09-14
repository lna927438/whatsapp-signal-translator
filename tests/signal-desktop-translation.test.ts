import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

function setup(options:{translate?:Function;save?:Function;shortTranslationTimeout?:boolean}={}){
  const calls:any[]=[],saved:any[]=[],exports:any={}
  const window={MessageCache:{saveMessage:async(message:any)=>{await options.save?.(message);saved.push(structuredClone(message.attributes))}}}
  const code=ts.transpileModule(readFileSync(new URL('../integrations/hellodog-source/hellodog.preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  runInNewContext(code,{exports,window,process:{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}},require:(name:string)=>name==='electron'?{ipcRenderer:{invoke:async(_channel:string,request:any)=>{calls.push(request);return options.translate?options.translate(request):{enabled:true,text:'Translated '+request.text,requestId:'request-'+request.id}}}}:{},setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,options.shortTranslationTimeout?15:ms),clearTimeout,setInterval:()=>0})
  const message=(id:string,body:string)=>({id,attributes:{body} as any,get(key:string){return this.attributes[key]},set(value:any){Object.assign(this.attributes,value)}})
  const conversation={id:'conversation-1',get:()=> 'private'}
  return{translate:(value:any,editTimestamp?:number)=>exports.translateHelloDogMessage(value,conversation,editTimestamp),message,calls,saved}
}
test('official persisted send hook handles rapid separate messages and reuses a completed translation on retry',async()=>{
  const h=setup(),a=h.message('a','same text'),b=h.message('b','same text')
  await Promise.all([h.translate(a),h.translate(b)])
  await h.translate(a)
  assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].id,h.calls[1].id)
  assert.equal(a.get('body'),'Translated same text');assert.equal(h.saved.length,2)
  assert.equal(h.saved[0].helloDogTranslation.original,'same text')
})
test('emoji and attachment-only official sends do not invoke paid translation',async()=>{
  const h=setup();await h.translate(h.message('emoji','😀👍'));await h.translate(h.message('attachment',''));assert.equal(h.calls.length,0)
})

test('formatting and native mentions no longer bypass outgoing translation; offsets follow translated text',async()=>{
  const h=setup({translate:()=>({enabled:true,text:'Hi \ufffc, please confirm.',requestId:'translated'})}),message=h.message('range','你好\ufffc，请确认。')
  message.set({bodyRanges:[{start:2,length:1,mentionAci:'peer-id'},{start:0,length:message.get('body').length,style:1}]})
  await h.translate(message);assert.equal(h.calls.length,1)
  assert.equal(message.get('bodyRanges')[0].start,3);assert.equal(message.get('bodyRanges')[0].mentionAci,'peer-id')
  assert.equal(message.get('bodyRanges')[1].length,message.get('body').length)
  await h.translate(message);assert.equal(h.calls.length,1)
})

test('missing translated mention cannot dispatch an unaddressed or wrongly addressed message',async()=>{
  const h=setup({translate:()=>({enabled:true,text:'Hello friend',requestId:'bad'})}),message=h.message('mention','你好\ufffc')
  message.set({bodyRanges:[{start:2,length:1,mentionAci:'peer'}]})
  await assert.rejects(h.translate(message),/Mention/);assert.equal(message.get('body'),'你好\ufffc');assert.equal(h.saved.length,0)
})

test('edited Signal text is translated under its edit identity and retry never retranslates the same edit',async()=>{
  const h=setup(),message=h.message('edit','新的内容')
  message.set({editMessageTimestamp:200,editHistory:[{timestamp:200,body:'新的内容'},{timestamp:100,body:'old content'}],helloDogTranslation:{original:'原文',translated:'old content',requestId:'old'}})
  await h.translate(message,200)
  assert.equal(h.calls[0].id,'edit');assert.equal(h.calls[0].editTimestamp,200);assert.equal(message.get('body'),'Translated 新的内容')
  assert.equal(message.get('editHistory')[0].body,'Translated 新的内容');assert.equal(message.get('editHistory')[1].body,'old content')
  await h.translate(message,200);assert.equal(h.calls.length,1)
})
test('an unknown translation result keeps the original native job body for recovery',async()=>{
  const h=setup({translate:()=>{throw Error('Unknown result')}}),message=h.message('a','hello')
  await assert.rejects(h.translate(message),/Unknown/);assert.equal(message.get('body'),'hello');assert.equal(h.saved.length,0)
})

test('a lost native IPC reply releases the send job; retry uses its original message and a late reply cannot rewrite it',async()=>{
 let release:(value:any)=>void=()=>{},calls=0;
 const h=setup({shortTranslationTimeout:true,translate:()=>++calls===1?new Promise(resolve=>{release=resolve}):{enabled:true,text:'Current translation',requestId:'request-a'}}),message=h.message('a','hello');
 await assert.rejects(h.translate(message),/超时/);assert.equal(message.get('body'),'hello');assert.equal(h.saved.length,0);
 await h.translate(message);assert.equal(h.calls[0].id,h.calls[1].id);assert.equal(h.saved.length,1);
 release({enabled:true,text:'Late translation',requestId:'request-a'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(message.get('body'),'Current translation');assert.equal(h.saved.length,1);
})
test('native message persistence failure cannot silently bypass translation persistence on retry',async()=>{
  let failed=false;const h=setup({save:()=>{if(!failed){failed=true;throw Error('disk unavailable')}}}),message=h.message('a','hello')
  await assert.rejects(h.translate(message),/disk/);assert.equal(message.get('body'),'hello');assert.equal(message.get('helloDogTranslation'),undefined)
  await h.translate(message);assert.equal(h.saved.length,1);assert.equal(h.calls[0].id,h.calls[1].id)
})
test('a native message erased during translation is not revived or dispatched',async()=>{
  let finish:(result:any)=>void=()=>{};const h=setup({translate:()=>new Promise(resolve=>{finish=resolve})}),message=h.message('a','hello'),task=h.translate(message)
  message.set({isErased:true,body:''});finish({enabled:true,text:'translated',requestId:'a'})
  await assert.rejects(task,/changed/);assert.equal(h.saved.length,0);assert.equal(message.get('body'),'')
})
