import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {desktopAuthBundle} from './desktop-auth-fixture.ts'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {AuthSessionMissingError}=createRequire(new URL('../package.json',import.meta.url))('@supabase/supabase-js')
const {requiresSessionLogin}=require('../src/renderer/src/lib/sessionRecovery.ts') as typeof import('../src/renderer/src/lib/sessionRecovery')
const session=(owner='owner',level='aal2',suffix='')=>({access_token:owner+'-'+level+suffix,user:{id:owner,email:owner+'@example.invalid'}})
let bundle:string
before(async()=>{bundle=await desktopAuthBundle('root')})
const tick=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve}}
async function mount(initial=session(),options:{assurance?:(jwt:string)=>Promise<any>;refresh?:()=>Promise<any>}={}){
 const errors:string[]=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message))
 const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://client.example.invalid',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window as any
 let current:any=initial,callback:any,refreshCallback:any
 const bridges:any[]=[],overlays:boolean[]=[],completions:any[]=[],assurances:string[]=[]
 const timers=new Map<number,{fn:()=>void;ms:number}>();let timerId=0
 w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId};w.clearInterval=(id:number)=>timers.delete(id)
 const notify=(event:string,value:any)=>{current=value;callback?.(event,value)}
 w.__client={auth:{
  onAuthStateChange:(fn:any)=>{callback=fn;return{data:{subscription:{unsubscribe:()=>{callback=undefined}}}}},
  startAutoRefresh:async()=>{},getSession:async()=>({data:{session:current},error:null}),
  signInWithPassword:async()=>{notify('SIGNED_IN',current);return{data:{session:current},error:null}},
  signOut:async()=>{notify('SIGNED_OUT',null);return{error:null}},
  refreshSession:options.refresh||(async()=>({data:{session:current},error:null})),
  mfa:{
   getAuthenticatorAssuranceLevel:async(jwt:string)=>{assurances.push(jwt);return options.assurance?options.assurance(jwt):{data:{currentLevel:jwt.includes('aal2')?'aal2':'aal1',nextLevel:'aal2'},error:null}},
   listFactors:async()=>({data:{all:[{id:'factor',factor_type:'totp',status:'verified'}]},error:null}),
   challengeAndVerify:async()=>{const value=session(current.user.id,'aal2','-verified');notify('MFA_CHALLENGE_VERIFIED',value);return{data:value,error:null}}
  }
 }}
 w.__mounts=0;w.__unmounts=0
 w.desktopAPI={authSetOnlineSession:async(s:any)=>bridges.push(s?JSON.parse(JSON.stringify(s)):null),setOverlayOpen:async(value:boolean)=>overlays.push(value),
  onAuthRefreshRequested:(fn:any)=>{refreshCallback=fn;return()=>refreshCallback=undefined},
  completeAuthRefresh:async(...args:any[])=>completions.push(args)}
 w.eval(bundle);await tick()
 return{w,bridges,overlays,completions,assurances,errors,notify,runIntervals:(ms:number)=>{for(const timer of timers.values())if(timer.ms===ms)timer.fn()},refresh:(value:any)=>refreshCallback(value),
 body:()=>w.document.body.textContent as string,button:(text:string)=>[...w.document.querySelectorAll('button')].find((e:any)=>e.textContent.trim()===text) as HTMLButtonElement,
 input:(selector:string,value:string)=>{const input=w.document.querySelector(selector);assert.ok(input);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}))},
 close:()=>{w.__dispose();w.close()}}
}
test('Root initial and SIGNED_IN events never bridge AAL1 before existing MFA; verified session creates one workspace',async()=>{
 const h=await mount(session('owner','aal1'));try{
 assert.equal(h.bridges.length,0);assert.equal(h.w.__mounts,0);assert.match(h.body(),/安全验证/)
 h.notify('SIGNED_IN',session('owner','aal1'));await tick();assert.equal(h.bridges.length,0)
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 assert.equal(h.w.__mounts,1);assert.equal(h.bridges.filter(x=>x?.accessToken.includes('aal1')).length,0)
 assert.equal(h.bridges.at(-1).accessToken,'owner-aal2-verified');assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('Root same-owner rejected session preserves App instance and draft through fresh password plus MFA',async()=>{
 const h=await mount(session(),{refresh:async()=>({data:{session:null},error:{code:'session_not_found',message:'missing session'}})});try{
 h.input('.fixture-draft','draft retained')
 h.refresh({id:'refresh-1',userId:'owner',reason:'rejected'});await tick()
 assert.equal(h.w.__mounts,1);assert.equal(h.w.__unmounts,0);assert.match(h.body(),/登录会话已失效/)
 assert.equal(h.overlays.at(-1),true);assert.deepEqual(h.completions.at(-1),['refresh-1',false,true])
 h.notify('SIGNED_IN',session('owner','aal1','-new'));await tick();assert.match(h.body(),/安全验证/)
 assert.equal(h.w.document.querySelector('.fixture-draft').value,'draft retained')
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 assert.equal(h.w.__mounts,1);assert.equal(h.w.__unmounts,0);assert.equal(h.w.document.querySelector('.fixture-draft').value,'draft retained')
 assert.equal(h.overlays.at(-1),false);assert.doesNotMatch(h.body(),/登录会话已失效/)
 }finally{h.close()}
})
test('Root network outage preserves same-owner workspace and recovers without login or stale bridge',async()=>{
 const h=await mount(session(),{refresh:async()=>({data:{session:null},error:{code:'network_error'}})});try{
 h.input('.fixture-draft','keep')
 h.refresh({id:'network-1',userId:'owner',reason:'rejected'});await tick()
 assert.equal(h.w.__unmounts,0);assert.doesNotMatch(h.body(),/登录会话已失效/);assert.deepEqual(h.completions.at(-1),['network-1',false,false])
 h.notify('TOKEN_REFRESHED',session('owner','aal2','-new'));await tick()
 assert.equal(h.w.__mounts,1);assert.equal(h.w.document.querySelector('.fixture-draft').value,'keep')
 }finally{h.close()}
})
test('Root clears old owner before new owner assurance resolves and ignores superseded validation',async()=>{
 const pending=deferred()
 const h=await mount(session(),{assurance:async(jwt)=>jwt.startsWith('other-')?pending.promise:{data:{currentLevel:'aal2',nextLevel:'aal2'},error:null}});try{
 h.input('.fixture-draft','private old owner draft')
 h.notify('SIGNED_IN',session('other','aal1'));await tick()
 assert.equal(h.w.document.querySelector('.fixture-workspace'),null);assert.equal(h.bridges.at(-1),null)
 h.notify('SIGNED_IN',session('third'));await tick();assert.match(h.body(),/third/)
 pending.resolve({data:{currentLevel:'aal2',nextLevel:'aal2'},error:null});await tick()
 assert.equal(h.bridges.some(x=>x?.userId==='other'),false);assert.equal(h.bridges.at(-1).userId,'third')
 assert.doesNotMatch(h.body(),/private old owner draft/)
 }finally{h.close()}
})
test('Root cannot apply delayed assurance after explicit signout or unmount',async()=>{
 const pending=deferred(),h=await mount(session('owner','aal1'),{assurance:()=>pending.promise})
 try{
 h.notify('SIGNED_OUT',null);await tick()
 pending.resolve({data:{currentLevel:'aal2',nextLevel:'aal2'},error:null});await tick()
 assert.equal(h.bridges.some(Boolean),false);assert.equal(h.w.__mounts,0)
 }finally{h.close()}
})

test('real Supabase SDK session_not_found conversion requires login despite having no error code',()=>{
 const error=new AuthSessionMissingError();assert.equal(error.code,undefined);assert.equal(error.name,'AuthSessionMissingError')
 assert.equal(requiresSessionLogin(error),true)
})

test('SDK automatic SIGNED_OUT during rejected-token recovery keeps same-owner draft behind login gate',async()=>{
 const h=await mount(session());try{
 h.input('.fixture-draft','keep through SDK invalidation')
 h.w.__client.auth.refreshSession=async()=>{h.notify('SIGNED_OUT',null);return{data:{session:null},error:new AuthSessionMissingError()}}
 h.refresh({id:'expired-sdk',userId:'owner',reason:'rejected'});await tick()
 assert.equal(h.w.__unmounts,0);assert.equal(h.w.document.querySelector('.fixture-draft').value,'keep through SDK invalidation')
 assert.match(h.body(),/登录会话已失效/);assert.equal(h.overlays.at(-1),true)
 h.runIntervals(30000);h.w.dispatchEvent(new h.w.Event('focus'));await tick()
 assert.equal(h.w.__unmounts,0);assert.match(h.body(),/登录会话已失效/);assert.equal(h.w.document.querySelector('.fixture-draft').value,'keep through SDK invalidation')
 h.w.dispatchEvent(new h.w.Event('translator:signout'));await tick()
 assert.equal(h.w.__unmounts,1);assert.equal(h.w.document.querySelector('.fixture-workspace'),null);assert.equal(h.bridges.at(-1),null)
 }finally{h.close()}
})
