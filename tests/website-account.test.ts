import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript} from '@vue/compiler-sfc'
import {JSDOM,VirtualConsole} from 'jsdom'

let bundle:string
before(async()=>{
 const webRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(webRequire.resolve('wrangler'))('esbuild')
 const file=fileURLToPath(new URL('../website/src/views/AccountView.vue',import.meta.url)),{descriptor}=parse(await readFile(file,'utf8'),{filename:file})
 const source=compileScript(descriptor,{id:'account-test',inlineTemplate:true}).content
 const result=await build({stdin:{resolveDir:dirname(file),sourcefile:'account-test.ts',contents:"import {createApp} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Account from './AccountView.vue';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/account',component:Account},{path:'/login',component:{render:()=>null}},{path:'/download',component:{render:()=>null}}]});const app=createApp(Account);app.use(router);window.__dispose=()=>app.unmount();window.__route=()=>router.currentRoute.value.path;router.push('/account').then(()=>router.isReady()).then(()=>app.mount('#app'));"},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'account-fixture',setup(build:any){
  build.onResolve({filter:/supabase$/},()=>({path:'supabase',namespace:'fixture'}))
  build.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'ts',contents:"export const supabaseConfigured=true,apiBase='https://api.example.invalid';export const requireSupabase=()=>window.__client;"}))
  build.onLoad({filter:/AccountView\.vue$/},()=>({loader:'ts',contents:source,resolveDir:dirname(file)}))
 }}]});bundle=result.outputFiles[0].text
})
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const session=(id='owner',token='token')=>({user:{id,email:id+'@example.invalid'},access_token:token})
function snapshot(id='owner',balance=900,charged=100){return{user:{id},profile:{id,username:'user-'+id,status:'active'},wallet:{user_id:id,balance,lifetime_credited:1000,lifetime_debited:charged},usage:[{request_id:'request-'+charged,source_characters:charged,provider:'deepseek',source_language:'zh',target_language:'en',created_at:'2026-09-16T00:00:00Z'}],ledger:[],reconciliation:{translationDebit:charged,usageCharacters:charged,duplicateDebits:0,mismatchedRequests:0},snapshotAt:new Date().toISOString()}}
async function mount(options:{request?:(url:string,init:any)=>Promise<Response>|Response;refresh?:()=>any}={}){
 const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message))
 const dom=new JSDOM('<div id="app"></div>',{url:'https://hellodog.example.invalid/account',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window as any
 let current:any=session(),callback:Function|undefined,unsubscribed=false,refreshes=0,reads=0,inCallback=false
 const calls:Array<{url:string;init:any}>=[],timers=new Map<number,{fn:Function;ms:number}>();let nextTimer=0
 w.AbortSignal=AbortSignal;w.AbortController=AbortController
 w.setInterval=(fn:Function,ms:number)=>{timers.set(++nextTimer,{fn,ms});return nextTimer};w.clearInterval=(id:number)=>timers.delete(id)
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
 w.__client={auth:{getSession:async()=>{assert.equal(inCallback,false);reads++;return{data:{session:current},error:null}},refreshSession:async()=>{assert.equal(inCallback,false);refreshes++;return options.refresh?options.refresh():{data:{session:session(current.user.id,'refreshed')},error:null}},onAuthStateChange:(fn:Function)=>{callback=fn;return{data:{subscription:{unsubscribe:()=>{unsubscribed=true}}}}}}}
 w.fetch=async(url:string,init:any)=>{calls.push({url,init});return options.request?options.request(url,init):Response.json(snapshot(current.user.id))}
 w.eval(bundle);await tick()
 return{w,calls,errors,timers,body:()=>w.document.body.textContent as string,refresh:async()=>{const buttons=[...w.document.querySelectorAll('button')] as any[];buttons.find(button=>/刷新字符余额|重新加载/.test(button.textContent))?.click();await tick()},run:async()=>{for(const timer of timers.values())timer.fn();await tick()},auth:async(value:any,event='SIGNED_IN')=>{current=value;inCallback=true;callback?.(event,value);inCallback=false;await tick()},get refreshes(){return refreshes},get reads(){return reads},get unsubscribed(){return unsubscribed},close:()=>{w.__dispose();dom.window.close()}}
}

test('website account reads one atomic snapshot and refreshes matching wallet and usage together',async()=>{
 let next=snapshot();const h=await mount({request:()=>Response.json(next)});try{
  assert.equal(h.calls.length,1);assert.ok(h.calls.every(call=>call.url.endsWith('/api/account-snapshot')))
  assert.match(h.body(),/900/);assert.match(h.body(),/-100/)
  next=snapshot('owner',850,150);await h.refresh();assert.match(h.body(),/850/);assert.match(h.body(),/-150/);assert.doesNotMatch(h.body(),/-100/)
  assert.ok(h.calls.every(call=>call.init.cache==='no-store'));assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('visible five-second polling preserves a stale complete snapshot on failure and recovers without false zero',async()=>{
 let fail=false;const h=await mount({request:()=>fail?Response.json({message:'Unavailable'},{status:503}):Response.json(snapshot())});try{
  assert.equal([...h.timers.values()][0].ms,5000);fail=true;await h.run();assert.match(h.body(),/900/);assert.match(h.body(),/保留上次同步数据/)
  Object.defineProperty(h.w.document,'visibilityState',{value:'hidden',configurable:true});const before=h.calls.length;await h.run();assert.equal(h.calls.length,before)
  fail=false;Object.defineProperty(h.w.document,'visibilityState',{value:'visible',configurable:true});h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));await tick();assert.doesNotMatch(h.body(),/当前显示可能过期/)
 }finally{h.close()}
})
test('logout clears private account data immediately and rejects a late prior-session response',async()=>{
 let finish!:(value:Response)=>void,hold=false;const h=await mount({request:()=>hold?new Promise(resolve=>{finish=resolve}):Response.json(snapshot())});try{
  hold=true;h.run();await tick();await h.auth(null,'SIGNED_OUT');assert.doesNotMatch(h.body(),/900|user-owner|owner@example/)
  finish(Response.json(snapshot()));await tick();assert.doesNotMatch(h.body(),/900|user-owner/);assert.equal(h.w.__route(),'/login')
 }finally{h.close()}
})
test('switching users discards old pending data and loads only the new identity',async()=>{
 let finish!:(value:Response)=>void,reads=0;const h=await mount({request:()=>++reads===1?new Promise(resolve=>{finish=resolve}):Response.json(snapshot('other',777,223))});try{
  await h.auth(session('other'));assert.match(h.body(),/777/);assert.match(h.body(),/user-other/)
  finish(Response.json(snapshot('owner')));await tick();assert.doesNotMatch(h.body(),/900|user-owner/);assert.match(h.body(),/777/)
 }finally{h.close()}
})
test('malformed or wrong-owner snapshots never become zero balances or replace validated data',async()=>{
 for(const value of [{...snapshot(),wallet:{balance:0}},{...snapshot(),user:{id:'other'}},{...snapshot(),usage:null}]){
  const h=await mount({request:()=>Response.json(value)});try{assert.equal(h.w.document.querySelector('.wallet-card'),null);assert.match(h.body(),/校验|不匹配/)}finally{h.close()}
 }
})
test('HTTP 401 refreshes the session once without message matching and a second 401 clears prior data',async()=>{
 let reject=false;const h=await mount({request:(_url,init)=>reject||init.headers.Authorization!=='Bearer refreshed'?Response.json({message:'Expired credential'},{status:401}):Response.json(snapshot())});try{
  assert.equal(h.refreshes,1);assert.match(h.body(),/900/)
  reject=true;await h.refresh();assert.equal(h.refreshes,2);assert.equal(h.w.document.querySelector('.wallet-card'),null);assert.doesNotMatch(h.body(),/user-owner/)
 }finally{h.close()}
})
test('overlapping timers do not create duplicate reads and unmount cancels pending transport and auth subscription',async()=>{
 let finish!:(value:Response)=>void;const h=await mount({request:()=>new Promise(resolve=>{finish=resolve})})
 await h.run();await h.run();assert.equal(h.calls.length,1)
 const signal=h.calls[0].init.signal;h.w.__dispose();assert.equal(signal.aborted,true);assert.equal(h.unsubscribed,true);assert.equal(h.timers.size,0)
 finish(Response.json(snapshot()));await tick();assert.doesNotMatch(h.body(),/900/);h.close()
})
