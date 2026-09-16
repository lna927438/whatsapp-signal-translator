import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {desktopAuthBundle} from './desktop-auth-fixture.ts'
import {createRequire} from 'node:module'
const {inspectDesktopAssurance,confirmDesktopMfa,verifiedTotpFactors}=createRequire(import.meta.url)('../src/renderer/src/lib/desktopMfa.ts') as typeof import('../src/renderer/src/lib/desktopMfa')
import type {BridgedSession} from '../src/renderer/src/lib/sessionCoordinator.ts'

const session=(level='aal1',owner='owner'):BridgedSession=>({access_token:owner+'-'+level,user:{id:owner,email:owner+'@example.invalid'}})
const factor={id:'totp-verified',factor_type:'totp',status:'verified',friendly_name:'Personal authenticator'}
let bundle:string
before(async()=>{bundle=await desktopAuthBundle()})
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve}}
function client(initial=session(),needsMfa=true){
 const state={session:initial as BridgedSession|null,needsMfa,level:'aal1',calls:[] as Array<[string,unknown]>,signouts:[] as any[]}
 const api:any={auth:{
  signInWithPassword:async()=>{state.calls.push(['password',null]);return {data:{session:state.session},error:null}},
  getSession:async()=>({data:{session:state.session},error:null}),
  signOut:async(options:any)=>{state.signouts.push(options===undefined?undefined:JSON.parse(JSON.stringify(options)));state.session=null;return{error:null}},
  resetPasswordForEmail:async()=>({error:null}),
  verifyOtp:async()=>({data:{session:state.session,user:state.session?.user},error:null}),
  updateUser:async()=>({error:null}),
  mfa:{
   getAuthenticatorAssuranceLevel:async(jwt:string)=>{state.calls.push(['assurance',jwt]);return{data:{currentLevel:state.level,nextLevel:state.needsMfa?'aal2':state.level},error:null}},
   listFactors:async()=>{state.calls.push(['factors',null]);return{data:{all:[factor]},error:null}},
   challengeAndVerify:async(body:any)=>{state.calls.push(['verify',body]);if(body.code!=='123456')return{error:new Error('Invalid TOTP code entered')};state.level='aal2';state.session=session('aal2',state.session!.user.id);return{data:state.session,error:null}}
  }},
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>{state.calls.push(['profile',null]);return{data:{username:'fixture-name'},error:null}}})})})
 }
 return{api,state}
}
async function mount(c=client(),props:any={},recovery?:ReturnType<typeof client>){
 const errors:string[]=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)))
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://client.example.invalid',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window as any
 w.__client=c.api;w.__recoveryClient=recovery?.api;w.__props=props;w.__authenticated=[];w.__cancelled=0
 w.eval(bundle);await tick()
 return {w,c,errors,body:()=>w.document.body.textContent as string,button:(label:string)=>[...w.document.querySelectorAll('button')].find((e:any)=>e.textContent.trim()===label) as HTMLButtonElement,
  input:(selector:string,value:string)=>{const e=w.document.querySelector(selector);assert.ok(e,'input '+selector);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}))},
  close:()=>{w.__dispose();w.close()}}
}
async function signIn(h:Awaited<ReturnType<typeof mount>>){h.input('input[type=email]','owner@example.invalid');h.input('input[autocomplete=current-password]','fixture-password');h.button('登录').click();await tick()}

test('assurance inspection validates explicit JWT, distinguishes ready/MFA and preserves server/network errors',async()=>{
 const c=client();assert.equal(await inspectDesktopAssurance(c.api,session()),'mfa');assert.deepEqual(c.state.calls,[['assurance','owner-aal1']])
 c.state.needsMfa=false;assert.equal(await inspectDesktopAssurance(c.api,session()),'ready')
 c.state.level='aal2';assert.equal(await inspectDesktopAssurance(c.api,session('aal2')),'ready')
 const error=Object.assign(new Error('Session no longer exists'),{code:'session_not_found'})
 c.api.auth.mfa.getAuthenticatorAssuranceLevel=async()=>({data:null,error});await assert.rejects(inspectDesktopAssurance(c.api,session()),e=>e===error)
 c.api.auth.mfa.getAuthenticatorAssuranceLevel=async()=>({data:null,error:null});await assert.rejects(inspectDesktopAssurance(c.api,session()),/安全状态/)
})
test('MFA completion requires actual AAL2; only verified TOTP factors are offered',async()=>{
 const c=client();c.state.needsMfa=false;await assert.rejects(confirmDesktopMfa(c.api,session()),/尚未完成/)
 c.state.level='aal2';await confirmDesktopMfa(c.api,session('aal2'))
 assert.deepEqual(verifiedTotpFactors({all:[factor,{...factor,status:'unverified'},{...factor,factor_type:'phone'},{...factor,id:''}]}),[{id:factor.id,friendly_name:factor.friendly_name}])
})
test('password login with existing MFA emits no session until valid TOTP and permits retry after wrong code',async()=>{
 const h=await mount();try{
 await signIn(h);assert.match(h.body(),/安全验证/);assert.equal(h.w.__authenticated.length,0)
 h.input('input[autocomplete=one-time-code]','000000');h.button('验证并继续').click();await tick()
 assert.match(h.body(),/验证码不正确/);assert.equal(h.w.__authenticated.length,0)
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();h.button('验证中…')?.click();await tick()
 assert.equal(h.w.__authenticated.length,1);assert.equal(h.w.__authenticated[0].access_token,'owner-aal2')
 assert.equal(h.c.state.calls.filter(x=>x[0]==='verify').length,2);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('unconfigured MFA users retain ordinary login with no factor lookup or challenge',async()=>{
 const h=await mount(client(session(),false));try{await signIn(h);assert.equal(h.w.__authenticated.length,1);assert.equal(h.c.state.calls.some(x=>x[0]==='factors'||x[0]==='verify'),false)}finally{h.close()}
})
test('restored session enters MFA, reloads after factor network failure and cancels only local session',async()=>{
 const c=client();let failures=1;c.api.auth.mfa.listFactors=async()=>failures--?{data:null,error:new Error('temporary network failure')}:{data:{all:[factor]},error:null}
 const h=await mount(c,{sessionToVerify:session()});try{
 assert.match(h.body(),/temporary network failure/);assert.equal(h.w.__authenticated.length,0)
 h.button('重新加载').click();await tick();h.button('返回登录').click();await tick()
 assert.deepEqual(c.state.signouts,[{scope:'local'}]);assert.equal(h.w.__cancelled,1);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
})
test('different active account cannot verify the old account factor',async()=>{
 const h=await mount(client(),{sessionToVerify:session()});try{
 h.c.state.session=session('aal1','other');h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 assert.match(h.body(),/登录账号已变化/);assert.equal(h.c.state.calls.some(x=>x[0]==='verify'),false);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
})
test('late verification from replaced session cannot emit authenticated or overwrite new account form',async()=>{
 const c=client(),pending=deferred();c.api.auth.mfa.challengeAndVerify=()=>pending.promise
 const h=await mount(c,{sessionToVerify:session()});try{
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 c.state.session=session('aal1','other');h.w.__setProps({sessionToVerify:c.state.session});await tick()
 pending.resolve({data:session('aal2'),error:null});await tick()
 assert.equal(h.w.__authenticated.length,0);assert.match(h.body(),/other@example.invalid/);assert.doesNotMatch(h.body(),/owner@example.invalid/)
 }finally{h.close()}
})
test('provider reporting challenge success without AAL2 remains gated',async()=>{
 const c=client();c.api.auth.mfa.challengeAndVerify=async()=>({data:session(),error:null})
 const h=await mount(c,{sessionToVerify:session()});try{
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 assert.match(h.body(),/安全验证尚未完成/);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
})
test('username recovery requires existing MFA, reads profile afterward and signs out only transient local session',async()=>{
 const recovery=client(session('aal1','recovery-owner')),h=await mount(client(),{},recovery)
 try{
 h.button('忘记账号？').click();await tick();h.input('input[type=email]','recovery-owner@example.invalid');h.button('发送邮箱验证码').click();await tick()
 h.input('input[inputmode=numeric]','123456');h.button('验证邮箱').click();await tick()
 assert.match(h.body(),/安全验证/);assert.equal(recovery.state.calls.some(x=>x[0]==='profile'),false)
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 assert.match(h.body(),/fixture-name/);assert.deepEqual(recovery.state.signouts,[{scope:'local'}]);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
})
test('password recovery retains global logout safety after MFA and password reset',async()=>{
 const recovery=client(session('aal1','recovery-owner')),h=await mount(client(),{},recovery)
 try{
 h.button('忘记密码？').click();await tick();h.input('input[type=email]','recovery-owner@example.invalid');h.button('发送邮箱验证码').click();await tick()
 h.input('input[inputmode=numeric]','123456');h.button('验证邮箱').click();await tick()
 h.input('input[autocomplete=one-time-code]','123456');h.button('验证并继续').click();await tick()
 const fields=h.w.document.querySelectorAll('input[autocomplete=new-password]');assert.equal(fields.length,2)
 for(const input of fields){input.value='fixture-new-password';input.dispatchEvent(new h.w.Event('input',{bubbles:true}))}
 h.button('确认重置密码').click();await tick();assert.deepEqual(recovery.state.signouts,[undefined]);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
})
test('cancel MFA cannot sign out a newer session while its old getSession response is delayed',async()=>{
 const c=client(),h=await mount(c,{sessionToVerify:session()}),pending=deferred()
 try{
 c.api.auth.getSession=()=>pending.promise;h.button('返回登录').click();await tick()
 const newer=session('aal1','other');c.state.session=newer;h.w.__setProps({sessionToVerify:newer});await tick()
 pending.resolve({data:{session:newer},error:null});await tick()
 assert.equal(c.state.signouts.length,0);assert.equal(h.w.__cancelled,0);assert.match(h.body(),/other@example.invalid/)
 }finally{h.close()}
})

test('missing verified TOTP never bypasses security and unmount discards pending factor lookup',async()=>{
 const c=client();c.api.auth.mfa.listFactors=async()=>({data:{all:[{...factor,status:'unverified'}]},error:null})
 const h=await mount(c,{sessionToVerify:session()});try{
 assert.match(h.body(),/没有可用的验证器/);assert.equal(h.button('验证并继续').disabled,true);assert.equal(h.w.__authenticated.length,0)
 }finally{h.close()}
 const delayed=client(),pending=deferred();delayed.api.auth.mfa.listFactors=()=>pending.promise
 const h2=await mount(delayed,{sessionToVerify:session()});h2.w.__dispose();pending.resolve({data:{all:[factor]},error:null});await tick()
 assert.equal(h2.w.__authenticated.length,0);assert.deepEqual(h2.errors,[]);h2.w.close()
})
