import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

function setup(options:{translate?:Function;authorize?:Function;save?:Function;shortTranslationTimeout?:boolean}={}){
  const calls:any[]=[],authorizations:any[]=[],saved:any[]=[],exports:any={}
  const window={MessageCache:{saveMessage:async(message:any)=>{await options.save?.(message);saved.push(structuredClone(message.attributes))}}}
  const code=ts.transpileModule(readFileSync(new URL('../integrations/hellodog-source/hellodog.preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  runInNewContext(code,{exports,window,process:{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}},require:(name:string)=>name==='electron'?{ipcRenderer:{invoke:async(_channel:string,request:any)=>{if(request.authorizationOnly){authorizations.push(request);return options.authorize?options.authorize(request):{authorized:true,text:request.translated,requestId:request.requestId}}calls.push(request);return options.translate?options.translate(request):{enabled:true,text:'Translated '+request.text,requestId:'send-sd-'+request.id}}}}:{},setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,options.shortTranslationTimeout?15:ms),clearTimeout,setInterval:()=>0})
  const message=(id:string,body:string)=>({id,attributes:{body} as any,get(key:string){return this.attributes[key]},set(value:any){Object.assign(this.attributes,value)}})
  const conversation={id:'conversation-1',get:()=> 'private'}
  return{translate:(value:any,editTimestamp?:number)=>exports.translateHelloDogMessage(value,conversation,editTimestamp),message,calls,saved,authorizations}
}
test('official persisted send hook handles rapid separate messages and reuses a completed translation on retry',async()=>{
  const h=setup(),a=h.message('a','same text'),b=h.message('b','same text')
  await Promise.all([h.translate(a),h.translate(b)])
  await h.translate(a)
  assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].id,h.calls[1].id)
  assert.equal(a.get('body'),'Translated same text');assert.equal(h.saved.length,2)
  assert.equal(h.saved[0].helloDogTranslation.original,'same text')
  assert.equal(h.authorizations.length,1);assert.equal(h.authorizations[0].requestId,'send-sd-a');assert.equal(h.authorizations[0].text,'same text')
})

test('a saved Signal translation cannot bypass a zero-balance rejection on native retry',async()=>{
  const h=setup({authorize:()=>{throw Error('可用字符已用完')}}),message=h.message('credit','原文');
  await h.translate(message);await assert.rejects(h.translate(message),/字符已用完/);
  assert.equal(h.calls.length,1);assert.equal(h.saved.length,1);assert.equal(message.get('body'),'Translated 原文');
})
test('an empty or malformed authorization response cannot release the original Signal body',async()=>{
  for(const reply of [null,{}, {enabled:0}]){
    const h=setup({translate:()=>reply}),message=h.message('malformed','中文原文');
    await assert.rejects(h.translate(message),/权限尚未确认/);assert.equal(message.get('body'),'中文原文');assert.equal(h.saved.length,0);
  }
})
test('a saved Signal message erased during authorization is not sent or restored',async()=>{
  let finish:Function=()=>{};const h=setup({authorize:()=>new Promise(resolve=>{finish=resolve})}),message=h.message('erased','原文');
  await h.translate(message);const retry=h.translate(message);message.set({isErased:true,body:''});finish({authorized:true});
  await assert.rejects(retry,/changed/);assert.equal(message.get('body'),'');assert.equal(h.calls.length,1);
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

test('a failed native send adopts an authoritative free correction under the original message and translation IDs',async()=>{
  const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected translation',requestId:r.requestId})}),message=h.message('corrected','original text');
  await h.translate(message);const id=message.get('helloDogTranslation').requestId;
  await h.translate(message);
  assert.equal(message.get('body'),'Corrected translation');assert.equal(message.get('helloDogTranslation').original,'original text');
  assert.equal(message.get('helloDogTranslation').requestId,id);assert.equal(h.calls.length,1);assert.equal(h.saved.length,2);
})

test('a correction cannot replace a native message already sent to one recipient',async()=>{
  const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected translation',requestId:r.requestId})}),message=h.message('partial','original text');
  await h.translate(message);message.set({sendStateByConversationId:{a:{status:'Sent'},b:{status:'Failed'}}});
  await assert.rejects(h.translate(message),/部分|已发送/);assert.equal(message.get('body'),'Translated original text');assert.equal(h.saved.length,1);
})

test('corrected native-body persistence failure retains its prior text and authorization metadata for safe retry',async()=>{
  let saves=0;const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected translation',requestId:r.requestId}),save:()=>{if(++saves===2)throw Error('disk unavailable')}}),message=h.message('correction-disk','original text');
  await h.translate(message);const saved=structuredClone(message.get('helloDogTranslation'));
  await assert.rejects(h.translate(message),/disk/);assert.equal(message.get('body'),'Translated original text');assert.deepEqual(structuredClone(message.get('helloDogTranslation')),saved);
  await h.translate(message);assert.equal(message.get('body'),'Corrected translation');assert.equal(h.calls.length,1);
})

test('native authorization rejects missing, mismatched or empty authoritative translation replies',async()=>{
  for(const approval of [{authorized:true},{authorized:true,text:'new',requestId:'another-request'},{authorized:true,text:'',requestId:'send-sd-invalid-approval'}]){
    const h=setup({authorize:()=>approval}),message=h.message('invalid-approval','original text');await h.translate(message);
    await assert.rejects(h.translate(message),/权限尚未确认/);assert.equal(message.get('body'),'Translated original text');assert.equal(h.saved.length,1);
  }
})

test('a corrected edit updates only its failed revision and retains the original message history',async()=>{
  const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected edit',requestId:r.requestId})}),message=h.message('corrected-edit','edited text');
  message.set({editMessageTimestamp:200,sendStateByConversationId:{peer:{status:'Sent'}},editHistory:[{timestamp:200,body:'edited text',sendStateByConversationId:{peer:{status:'Failed'}}},{timestamp:100,body:'already sent',sendStateByConversationId:{peer:{status:'Sent'}}}]});
  await h.translate(message,200);await h.translate(message,200);
  assert.equal(message.get('body'),'Corrected edit');assert.equal(message.get('editHistory')[0].body,'Corrected edit');assert.equal(message.get('editHistory')[1].body,'already sent');
  assert.equal(message.get('helloDogEditTranslations')['200'].original,'edited text');assert.equal(h.calls.length,1);
})

test('lost correction authorization leaves old native text intact; retry reuses the saved request and ignores late replies',async()=>{
  let finish:Function=()=>{},calls=0;
  const h=setup({shortTranslationTimeout:true,authorize:(r:any)=>++calls===1?new Promise(resolve=>{finish=resolve}):{authorized:true,text:'Current correction',requestId:r.requestId}}),message=h.message('correction-timeout','original text');
  await h.translate(message);const id=message.get('helloDogTranslation').requestId;
  await assert.rejects(h.translate(message),/超时/);assert.equal(message.get('body'),'Translated original text');assert.equal(h.saved.length,1);
  await h.translate(message);finish({authorized:true,text:'Late correction',requestId:id});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(message.get('body'),'Current correction');assert.equal(h.authorizations[0].requestId,h.authorizations[1].requestId);assert.equal(h.calls.length,1);assert.equal(h.saved.length,2);
})

test('native text changed while its translated body is saving cannot reach transport or be overwritten by rollback',async()=>{
  for(const correction of [false,true])for(const rejects of [false,true]){
    let saves=0;const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected translation',requestId:r.requestId}),save:(message:any)=>{
      if(++saves===(correction?2:1)){message.set({body:'changed 中文'});if(rejects)throw Error('disk unavailable')}
    }}),message=h.message('save-race','original text');
    if(correction)await h.translate(message);
    await assert.rejects(h.translate(message),rejects?/disk/:/changed/);assert.equal(message.get('body'),'changed 中文');
  }
})

test('a late delivered receipt during correction persistence stops transport and preserves delivered history and concurrent edits',async()=>{
  for(const concurrentEdit of [false,true]){
    let saves=0;const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected translation',requestId:r.requestId}),save:(message:any)=>{
      if(++saves===2)message.set({sendStateByConversationId:{peer:{status:'Delivered',updatedAt:5}},...(concurrentEdit?{body:'newer user edit'}:{})});
    }}),message=h.message('late-delivery','original text');
    await h.translate(message);message.set({sendStateByConversationId:{peer:{status:'Failed',updatedAt:1}}});
    await assert.rejects(h.translate(message),/已发送|部分|changed/);
    assert.equal(message.get('sendStateByConversationId').peer.status,'Delivered');
    assert.equal(message.get('body'),concurrentEdit?'newer user edit':'Translated original text');
    assert.equal(h.saved.at(-1).body,message.get('body'));assert.equal(h.saved.at(-1).sendStateByConversationId.peer.status,'Delivered');
    assert.equal(h.calls.length,1);
  }
})

test('late delivery while saving an edit correction preserves the edited revision receipt and a newer edit',async()=>{
  let saves=0;const h=setup({authorize:(r:any)=>({authorized:true,text:'Corrected edit',requestId:r.requestId}),save:(message:any)=>{
    if(++saves===2)message.set({body:'newer edit',editMessageTimestamp:300,helloDogTranslation:{original:'newer source',translated:'newer edit',requestId:'send-newer'},
      editHistory:[{timestamp:300,body:'newer edit',sendStateByConversationId:{peer:{status:'Pending'}}},...message.get('editHistory').map((item:any)=>item.timestamp===200?{...item,sendStateByConversationId:{peer:{status:'Delivered'}}}:item)]});
  }}),message=h.message('late-edit','edited source');
  message.set({editMessageTimestamp:200,editHistory:[{timestamp:200,body:'edited source',sendStateByConversationId:{peer:{status:'Failed'}}},{timestamp:100,body:'original sent',sendStateByConversationId:{peer:{status:'Sent'}}}]});
  await h.translate(message,200);await assert.rejects(h.translate(message,200),/部分|已发送/);
  assert.equal(message.get('body'),'newer edit');assert.equal(message.get('helloDogTranslation').requestId,'send-newer');
  const edit=message.get('editHistory').find((item:any)=>item.timestamp===200);assert.equal(edit.body,'Translated edited source');assert.equal(edit.sendStateByConversationId.peer.status,'Delivered');
  assert.equal(message.get('editHistory').find((item:any)=>item.timestamp===100).body,'original sent');assert.equal(h.saved.at(-1).body,'newer edit');
})
test('a native message erased during translation is not revived or dispatched',async()=>{
  let finish:(result:any)=>void=()=>{};const h=setup({translate:()=>new Promise(resolve=>{finish=resolve})}),message=h.message('a','hello'),task=h.translate(message)
  message.set({isErased:true,body:''});finish({enabled:true,text:'translated',requestId:'a'})
  await assert.rejects(task,/changed/);assert.equal(h.saved.length,0);assert.equal(message.get('body'),'')
})

test('first edit translation save failure restores only its own text and retains concurrent newer edit and receipts',async()=>{
  const newer={original:'newer source',translated:'newer edit',requestId:'send-newer'},other={original:'other source',translated:'other text',requestId:'send-other'};
  const h=setup({save:(message:any)=>{
    message.set({body:'newer edit',bodyRanges:[{start:0,length:5,style:2}],editMessageTimestamp:300,helloDogTranslation:newer,
      helloDogEditTranslations:{...message.get('helloDogEditTranslations'),300:newer,100:other},
      editHistory:[{timestamp:300,body:'newer edit',sendStateByConversationId:{peer:{status:'Pending'}}},...message.get('editHistory').map((item:any)=>item.timestamp===200?{...item,sendStateByConversationId:{peer:{status:'Delivered',updatedAt:9}}}:item)]});
    throw Error('disk unavailable');
  }}),message=h.message('first-edit-save-race','edited source');
  message.set({editMessageTimestamp:200,editHistory:[{timestamp:200,body:'edited source',bodyRanges:[{start:0,length:6,style:1}],sendStateByConversationId:{peer:{status:'Failed'}}},{timestamp:100,body:'original sent'}]});
  await assert.rejects(h.translate(message,200),/disk/);
  assert.equal(message.get('body'),'newer edit');assert.equal(message.get('editMessageTimestamp'),300);assert.equal(message.get('helloDogTranslation'),newer);
  assert.deepEqual(message.get('bodyRanges'),[{start:0,length:5,style:2}]);
  const edit=message.get('editHistory').find((item:any)=>item.timestamp===200);
  assert.equal(edit.body,'edited source');assert.equal(edit.sendStateByConversationId.peer.status,'Delivered');assert.equal(edit.sendStateByConversationId.peer.updatedAt,9);
  assert.deepEqual(edit.bodyRanges,[{start:0,length:6,style:1}]);
  assert.equal(message.get('editHistory').length,3);assert.equal(message.get('editHistory')[0].body,'newer edit');
  assert.equal(message.get('helloDogEditTranslations')[300],newer);assert.equal(message.get('helloDogEditTranslations')[100],other);assert.equal(message.get('helloDogEditTranslations')[200],undefined);
})

test('first translation save failure cannot roll back a newer same-text annotation',async()=>{
  const newer={original:'another original',translated:'Translated original text',requestId:'send-newer'};
  const h=setup({save:(message:any)=>{message.set({helloDogTranslation:newer,bodyRanges:[{start:0,length:3,style:2}]});throw Error('disk unavailable')}}),message=h.message('same-body-new-annotation','original text');
  await assert.rejects(h.translate(message),/disk/);
  assert.equal(message.get('body'),'Translated original text');assert.equal(message.get('helloDogTranslation'),newer);assert.deepEqual(message.get('bodyRanges'),[{start:0,length:3,style:2}]);
})


test('late untranslated authorization cannot release a changed Chinese draft or an erased native message', async () => {
  for (const change of [{ body: '修改后的中文原文' }, { isErased: true }, { deletedForEveryone: true }, { expirationStartTimestamp: 1, expireTimer: 1 }]) {
    let finish: (result: unknown) => void = () => {}
    const h = setup({ translate: () => new Promise(resolve => { finish = resolve }) }), message = h.message('plain-race', 'Hello friend')
    const work = h.translate(message)
    message.set(change); finish({ enabled: false })
    await assert.rejects(work, /changed/)
    assert.equal(h.saved.length, 0)
    assert.equal(message.get('body'), change.body || 'Hello friend')
  }
})

test('late untranslated edit authorization cannot release replacement edit text', async () => {
  let finish: (result: unknown) => void = () => {}
  const h = setup({ translate: () => new Promise(resolve => { finish = resolve }) }), message = h.message('plain-edit-race', 'Hello friend')
  message.set({ editMessageTimestamp: 200, editHistory: [{ timestamp: 200, body: 'Hello friend' }] })
  const work = h.translate(message, 200)
  message.set({ body: '中文', editHistory: [{ timestamp: 200, body: '中文' }] }); finish({ enabled: false })
  await assert.rejects(work, /changed/); assert.equal(h.saved.length, 0); assert.equal(message.get('body'), '中文')
})
