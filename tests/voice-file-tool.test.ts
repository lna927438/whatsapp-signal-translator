import {before,test} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {voiceFileBundle} from './voice-file-fixture.ts'
let bundle:string
before(async()=>{bundle=await voiceFileBundle()})
const result={text:'Good morning, synthetic test.',englishTranslation:'Good morning, synthetic test.',translation:'早上好，合成测试。',audioId:'a'.repeat(64),targetLanguage:'zh-CN'}
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0))}
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(reason?:any)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
async function mount(options:{props?:any;decode?:(url:string)=>any;translate?:(...args:any[])=>any;create?:(file:File)=>string}={}){
 const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window as any,d=w.document as Document
 const urls:string[]=[],revoked:string[]=[],translations:any[][]=[]
 w.__props=options.props||{};w.__decode=options.decode||(()=>new Uint8Array([1,2,3]))
 w.URL.createObjectURL=(file:File)=>{const url=options.create?options.create(file):'blob:fixture-'+(urls.length+1);urls.push(url);return url}
 w.URL.revokeObjectURL=(url:string)=>revoked.push(url)
 w.desktopAPI={translateVoiceFileAudio:async(...args:any[])=>{translations.push(args);return options.translate?options.translate(...args):result}}
 w.eval(bundle);await tick()
 const input=()=>d.querySelector('input[type=file]') as HTMLInputElement
 const choose=async(name='fixture.wav',size?:number)=>{const file=new w.File(['synthetic fixture'],name,{type:'audio/wav'});if(size!==undefined)Object.defineProperty(file,'size',{value:size});Object.defineProperty(input(),'files',{value:[file],configurable:true});input().dispatchEvent(new w.Event('change',{bubbles:true}));await tick()}
 const button=(label:string)=>Array.from(d.querySelectorAll('button')).find(item=>item.textContent===label) as HTMLButtonElement|undefined
 const start=async()=>{button('转为中文')?.click();await tick()}
 const select=async(id:string)=>{const el=d.querySelector('select') as HTMLSelectElement;el.value=id;el.dispatchEvent(new w.Event('change',{bubbles:true}));await tick()}
 return{w,d,urls,revoked,translations,input,choose,button,start,select,status:()=>d.querySelector('[role=status]')?.textContent||'',close:()=>{w.__dispose();dom.window.close()}}
}

test('selecting a file does not submit; one explicit click shows English and Chinese directly',async()=>{
 const pending=deferred(),h=await mount({props:{selectedId:'signal'},translate:()=>pending.promise})
 try{await h.choose();assert.equal(h.translations.length,0);assert.equal(h.urls.length,0);await h.start();h.button('正在转为中文…')?.click();await tick();assert.equal(h.translations.length,1);assert.equal(h.translations[0][0],'signal');assert.deepEqual(Array.from(h.translations[0][1]),[1,2,3]);pending.resolve(result);await tick();assert.equal(h.status(),'已转为中文');assert.equal(h.d.querySelector('.voice-file-chinese')?.textContent,result.translation);assert.equal(h.d.querySelector('.voice-file-english')?.textContent,result.englishTranslation);assert.equal(h.d.querySelector('details'),null);assert.deepEqual(h.urls,h.revoked);assert.equal(h.button('转为中文'),undefined)}finally{h.close()}
})
test('Google Voice windows can be selected by the same file tool',async()=>{
 const id='gv-00000000-0000-4000-8000-000000000001',h=await mount({props:{accounts:[{id,platform:'google-voice',label:'Voice 窗口'}],selectedId:id}})
 try{await h.choose();await h.start();assert.equal(h.translations[0][0],id);assert.equal(h.status(),'已转为中文')}finally{h.close()}
})
test('decode failure is retryable without a cloud request and retains the selected file',async()=>{
 let fail=true;const h=await mount({decode:()=>{if(fail)throw Error('合成解码失败');return new Uint8Array([1])}})
 try{await h.choose();await h.start();assert.equal(h.translations.length,0);assert.match(h.status(),/解码失败/);assert.ok(h.button('转为中文'));fail=false;await h.start();assert.equal(h.translations.length,1);assert.equal(h.status(),'已转为中文');assert.deepEqual(h.urls,h.revoked)}finally{h.close()}
})
test('translation failure retries the same canonical audio; no legacy transcript-only API is used',async()=>{
 let fail=true;const h=await mount({translate:()=>{if(fail)throw Error('合成翻译失败');return result}})
 try{await h.choose();await h.start();assert.match(h.status(),/翻译失败/);assert.equal(h.d.querySelector('.voice-file-result'),null);fail=false;await h.start();assert.equal(h.translations.length,2);assert.deepEqual(Array.from(h.translations[0][1]),Array.from(h.translations[1][1]));assert.equal(h.status(),'已转为中文')}finally{h.close()}
})
test('cancel before decode completes prevents submission and releases its object URL',async()=>{
 const pending=deferred(),h=await mount({decode:()=>pending.promise})
 try{await h.choose();await h.start();h.button('取消')!.click();pending.resolve(new Uint8Array([1]));await tick();assert.equal(h.translations.length,0);assert.match(h.status(),/已取消本次/);assert.deepEqual(h.urls,h.revoked)}finally{h.close()}
})
test('cancel after submission discards a late answer without claiming the provider task was stopped',async()=>{
 const pending=deferred(),h=await mount({translate:()=>pending.promise})
 try{await h.choose();await h.start();h.button('取消')!.click();pending.resolve(result);await tick();assert.match(h.status(),/已提交的任务可能仍在处理/);assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.translations.length,1);assert.deepEqual(h.urls,h.revoked)}finally{h.close()}
})
test('changed account, selected file, removed account and unmount reject old asynchronous answers',async()=>{
 for(const action of ['account','file','removed','unmount']){
  const pending=deferred(),h=await mount({translate:()=>pending.promise})
  try{await h.choose();await h.start();if(action==='account')await h.select('signal');else if(action==='file')await h.choose('new.wav');else if(action==='removed'){h.w.__setProps({accounts:[]});await tick()}else h.w.__dispose();pending.resolve(result);await tick();assert.equal(h.d.querySelector('.voice-file-result'),null);assert.equal(h.d.querySelector('details'),null);assert.equal(h.translations.length,1)}finally{h.close()}
 }
})
test('empty, oversized files and missing accounts cannot decode or submit',async()=>{
 const h=await mount();try{for(const size of [0,20*1024*1024+1]){await h.choose('invalid.wav',size);assert.match(h.status(),/20 MB/);assert.equal(h.button('转为中文'),undefined)}assert.equal(h.urls.length,0);assert.equal(h.translations.length,0)}finally{h.close()}
 const empty=await mount({props:{accounts:[],selectedId:''}});try{assert.equal(empty.input().disabled,true);assert.match(empty.d.body.textContent||'',/先添加聊天账号/)}finally{empty.close()}
})
test('malformed or non-Chinese-target replies never render and remain retryable',async()=>{
 for(const answer of [null,{...result,targetLanguage:'en-US'},{...result,translation:''},{...result,audioId:'bad'},{...result,text:'x'.repeat(12001)}]){const h=await mount({translate:()=>answer});try{await h.choose();await h.start();assert.equal(h.d.querySelector('.voice-file-result'),null);assert.ok(h.button('转为中文'));assert.match(h.status(),/失败/)}finally{h.close()}}
})
