import {before,test} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {voiceFileBundle} from './voice-file-fixture.ts'
let bundle:string
before(async()=>{bundle=await voiceFileBundle()})
const audioId='a'.repeat(64),recognized={text:'Good morning, synthetic test.',audioId}
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0))}
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(reason?:any)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function mount(options:{props?:any;decode?:(url:string)=>any;recognize?:(...args:any[])=>any;translate?:(...args:any[])=>any;create?:(file:File)=>string}={}){
 const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window as any,d=w.document as Document
 const urls:string[]=[],revoked:string[]=[],recognitions:any[][]=[],translations:any[][]=[]
 w.__props=options.props||{};w.__decode=options.decode||(()=>new Uint8Array([1,2,3]))
 w.URL.createObjectURL=(file:File)=>{const url=options.create?options.create(file):'blob:fixture-'+(urls.length+1);urls.push(url);return url}
 w.URL.revokeObjectURL=(url:string)=>revoked.push(url)
 w.desktopAPI={recognizeVoice:async(...args:any[])=>{recognitions.push(args);return options.recognize?options.recognize(...args):recognized},translateVoiceFile:async(...args:any[])=>{translations.push(args);return options.translate?options.translate(...args):'早上好，合成测试。'}}
 w.eval(bundle);await tick()
 const input=()=>d.querySelector('input[type=file]') as HTMLInputElement
 const choose=async(name='fixture.wav',size?:number)=>{const file=new w.File(['synthetic non-audio fixture'],name,{type:'audio/wav'});if(size!==undefined)Object.defineProperty(file,'size',{value:size});Object.defineProperty(input(),'files',{value:[file],configurable:true});input().dispatchEvent(new w.Event('change',{bubbles:true}));await tick()}
 const button=(label:string)=>Array.from(d.querySelectorAll('button')).find(item=>item.textContent===label) as HTMLButtonElement|undefined
 const edit=async(text:string)=>{const area=d.querySelector('textarea') as HTMLTextAreaElement;area.value=text;area.dispatchEvent(new w.Event('input',{bubbles:true}));await tick()}
 const select=async(id:string)=>{const el=d.querySelector('select') as HTMLSelectElement;el.value=id;el.dispatchEvent(new w.Event('change',{bubbles:true}));await tick()}
 const status=()=>d.querySelector('[role=status]')?.textContent||''
 return {w,d,urls,revoked,recognitions,translations,input,choose,button,edit,select,status,close:()=>{w.__dispose();dom.window.close()}}
}

test('real Vue uses selected account, requires explicit confirmation and sends the corrected draft only once',async()=>{
 const completion=deferred<string>(),h=await mount({props:{selectedId:'signal'},translate:()=>completion.promise})
 try{assert.equal((h.d.querySelector('select') as HTMLSelectElement).value,'signal');await h.choose();assert.equal(h.recognitions[0][0],'signal');assert.equal(h.translations.length,0);assert.deepEqual(h.revoked,h.urls)
  await h.edit('Corrected voice transcript.');h.button('确认并翻译')!.click();h.button('确认并翻译')!.click();await tick()
  assert.deepEqual(h.translations,[['signal',audioId,'Corrected voice transcript.']]);assert.equal(h.button('取消'),undefined)
  completion.resolve('校正后的翻译。');await tick();assert.equal(h.status(),'语音翻译完成');assert.equal(h.d.querySelector('.voice-file-result')?.textContent,'校正后的翻译。')
  await h.edit('Changed after translation.');assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.translations.length,1)
 }finally{h.close()}
})

test('invalid selected account falls back; removing all accounts disables input and cannot call IPC',async()=>{
 const h=await mount({props:{selectedId:'missing'}})
 try{assert.equal((h.d.querySelector('select') as HTMLSelectElement).value,'wa');h.w.__setProps({accounts:[]});await tick();assert.equal(h.input().disabled,true);await h.choose();assert.equal(h.recognitions.length,0);assert.equal(h.translations.length,0)}finally{h.close()}
})

test('selecting a different account clears the draft, filename and result independently',async()=>{
 const h=await mount()
 try{await h.choose();h.button('确认并翻译')!.click();await tick();await h.select('signal');assert.equal(h.d.querySelector('textarea'),null);assert.equal(h.d.querySelector('.voice-file-result'),null);assert.ok(!h.d.body.textContent!.includes('fixture.wav'));assert.equal(h.status(),'');await h.choose('signal.wav');assert.equal(h.recognitions.at(-1)![0],'signal')}finally{h.close()}
})

test('cancelled native file picker preserves current draft without recognition or translation',async()=>{
 const h=await mount()
 try{await h.choose();Object.defineProperty(h.input(),'files',{value:[],configurable:true});h.input().dispatchEvent(new h.w.Event('change',{bubbles:true}));await tick();assert.equal((h.d.querySelector('textarea') as HTMLTextAreaElement).value,recognized.text);assert.equal(h.recognitions.length,1);assert.equal(h.translations.length,0)}finally{h.close()}
})

test('recognition cancellation releases Blob immediately and ignores late success before any paid call',async()=>{
 const pending=deferred(),h=await mount({recognize:()=>pending.promise})
 try{await h.choose();assert.equal(h.revoked.length,0);h.button('取消')!.click();await tick();assert.deepEqual(h.revoked,h.urls);assert.match(h.status(),/已取消/);assert.equal(h.input().disabled,false)
  pending.resolve(recognized);await tick();assert.equal(h.d.querySelector('textarea'),null);assert.equal(h.translations.length,0);assert.equal(h.revoked.length,1)
 }finally{h.close()}
})

test('unmount during decode revokes Blob immediately and does not start recognition when decoding finishes',async()=>{
 const pending=deferred(),h=await mount({decode:()=>pending.promise})
 try{await h.choose();h.w.__dispose();assert.deepEqual(h.revoked,h.urls);pending.resolve(new Uint8Array([1]));await tick();assert.equal(h.recognitions.length,0);assert.equal(h.translations.length,0);assert.equal(h.revoked.length,1)}finally{h.close()}
})

test('parent selected account change invalidates in-flight recognition and ignores late errors',async()=>{
 const pending=deferred(),h=await mount({recognize:()=>pending.promise})
 try{await h.choose();h.w.__setProps({selectedId:'signal'});await tick();assert.equal((h.d.querySelector('select') as HTMLSelectElement).value,'signal');assert.deepEqual(h.revoked,h.urls);pending.reject(new Error('old account recognition error'));await tick();assert.equal(h.status(),'');assert.equal(h.d.querySelector('textarea'),null);assert.equal(h.translations.length,0)}finally{h.close()}
})

test('new file invalidates older recognition; the old finalizer cannot release or finish the new operation',async()=>{
 const first=deferred(),second=deferred();let count=0;const h=await mount({recognize:()=>++count===1?first.promise:second.promise})
 try{await h.choose('first.wav');await h.choose('second.wav');assert.deepEqual(h.revoked,[h.urls[0]]);first.resolve(recognized);await tick();assert.equal(h.d.querySelector('textarea'),null);assert.equal(h.input().disabled,true);assert.deepEqual(h.revoked,[h.urls[0]])
  second.resolve({text:'Second selected file.',audioId:'b'.repeat(64)});await tick();assert.equal((h.d.querySelector('textarea') as HTMLTextAreaElement).value,'Second selected file.');assert.deepEqual(h.revoked,h.urls);h.button('确认并翻译')!.click();await tick();assert.deepEqual(h.translations,[['wa','b'.repeat(64),'Second selected file.']])
 }finally{h.close()}
})

test('pending paid response cannot appear after account change, next file or unmount',async()=>{
 for(const action of ['account','file','unmount']){const pending=deferred(),h=await mount({translate:()=>pending.promise})
  try{await h.choose();h.button('确认并翻译')!.click();await tick();if(action==='account'){h.w.__setProps({selectedId:'signal'});await tick()}else if(action==='file')await h.choose('second.wav');else h.w.__dispose();pending.resolve('Stale translation');await tick();assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.translations.length,1)}finally{h.close()}
 }
})

test('clearing transcript leaves editor usable; blank text cannot request a translation',async()=>{
 const h=await mount();try{await h.choose();await h.edit('');assert.ok(h.d.querySelector('textarea'));assert.equal(h.button('确认并翻译')!.disabled,true);h.button('确认并翻译')!.click();assert.equal(h.translations.length,0);await h.edit('Ready.');assert.equal(h.button('确认并翻译')!.disabled,false)}finally{h.close()}
})

test('decoder, object URL, size and recognition errors are visible and never become successful translation',async()=>{
 for(const options of [{decode:()=>{throw new Error('decode failed')}},{create:()=>{throw new Error('object URL failed')}},{recognize:()=>{throw new Error('recognizer failed')}},{recognize:()=>null},{recognize:()=>({text:'',audioId})},{recognize:()=>({text:'  ',audioId})},{recognize:()=>({text:'x'.repeat(12001),audioId})},{recognize:()=>({text:'Fine',audioId:'bad'})}]){
  const h=await mount(options);try{await h.choose();assert.ok(h.status());assert.ok(!h.status().includes('完成'));assert.equal(h.d.querySelector('textarea'),null);assert.equal(h.translations.length,0);assert.equal(h.input().disabled,false);assert.deepEqual(h.revoked,h.urls)}finally{h.close()}
 }
 const h=await mount();try{await h.choose('huge.wav',20*1024*1024+1);assert.match(h.status(),/5 分钟/);assert.equal(h.urls.length,0);assert.equal(h.recognitions.length,0)}finally{h.close()}
})

test('empty, malformed or failed translation clears previous success and permits a manual retry',async()=>{
 for(const invalid of ['',null,{},'   ',new Error('translation unavailable')]){let calls=0;const h=await mount({translate:()=>{if(calls++===0)return 'First successful answer';if(invalid instanceof Error)throw invalid;return invalid}})
  try{await h.choose();h.button('确认并翻译')!.click();await tick();assert.equal(h.status(),'语音翻译完成');h.button('确认并翻译')!.click();await tick();assert.notEqual(h.status(),'语音翻译完成');assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.button('确认并翻译')!.disabled,false);assert.equal(h.translations.length,2)}finally{h.close()}
 }
})

test('even a synthetic edit during translation invalidates the pending result instead of attaching it to new text',async()=>{
 const pending=deferred(),h=await mount({translate:()=>pending.promise});try{await h.choose();h.button('确认并翻译')!.click();await tick();await h.edit('Another transcript.');pending.resolve('Old answer');await tick();assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.translations.length,1);assert.equal(h.button('确认并翻译')!.disabled,false)}finally{h.close()}
})
