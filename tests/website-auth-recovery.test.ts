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
 const file=fileURLToPath(new URL('../website/src/views/AuthView.vue',import.meta.url)),{descriptor}=parse(await readFile(file,'utf8'),{filename:file})
 const source=compileScript(descriptor,{id:'website-auth-recovery',inlineTemplate:true}).content
 const result=await build({stdin:{resolveDir:dirname(file),sourcefile:'auth-recovery-fixture.ts',contents:"import {createApp} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Auth from './AuthView.vue';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/login',component:Auth},{path:'/account',component:{render:()=>null}}]});const app=createApp(Auth);app.use(router);window.__dispose=()=>app.unmount();router.push('/login').then(()=>router.isReady()).then(()=>app.mount('#app'));"},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'actual-auth-with-synthetic-client',setup(build:any){
  build.onResolve({filter:/supabase$/},()=>({path:'supabase',namespace:'fixture'}))
  build.onResolve({filter:/authChallenge$/},()=>({path:'captcha',namespace:'fixture'}))
  build.onLoad({filter:/.*/,namespace:'fixture'},(args:any)=>({loader:'ts',contents:args.path==='captcha'?"export const authCaptcha=async()=>undefined;":"export const supabaseConfigured=true;export const requireSupabase=()=>window.__client;"}))
  build.onLoad({filter:/AuthView\.vue$/},()=>({loader:'ts',contents:source,resolveDir:dirname(file)}))
 }}]});bundle=result.outputFiles[0].text
})
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0))}
async function mount(profileError=false){
 const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message))
 const dom=new JSDOM('<div id="app"></div>',{url:'https://hello.example.invalid/login',runScripts:'outside-only',virtualConsole:console}),w=dom.window as any
 const signouts:any[]=[],updates:any[]=[],requests:any[]=[],verifications:any[]=[]
 w.__client={auth:{
  resetPasswordForEmail:async(...args:any[])=>{requests.push(args);return {error:null}},
  verifyOtp:async(value:any)=>{verifications.push(value);return {data:{user:{id:'fixture-user'},session:{}},error:null}},
  updateUser:async(value:any)=>{updates.push(value);return {error:null}},
  signOut:async(value:any)=>{signouts.push(value);return {error:null}}
 },from:(table:string)=>{assert.equal(table,'profiles');return {select:(columns:string)=>{assert.equal(columns,'username');return {eq:(field:string,id:string)=>{assert.equal(field,'id');assert.equal(id,'fixture-user');return {maybeSingle:async()=>profileError?{data:null,error:Error('synthetic profile unavailable')}:{data:{username:'fixture-name'},error:null}}}}}}}}
 w.eval(bundle);await tick()
 const click=async(text:string)=>{const button=[...w.document.querySelectorAll('button')].find((b:any)=>b.textContent.trim()===text) as HTMLButtonElement;assert.ok(button,'Button '+text);button.click();await tick()}
 const fill=(selector:string,value:string)=>{const input=w.document.querySelector(selector);assert.ok(input);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}))}
 const recover=async(kind:'username'|'password')=>{await click(kind==='username'?'忘记账号？':'忘记密码？');fill('input[type=email]','fixture@example.invalid');await click('发送邮箱验证码');fill('.auth-code-input','123456');await click('验证邮箱')}
 return {w,errors,signouts,updates,requests,verifications,click,fill,recover,body:()=>w.document.body.textContent as string,close:()=>{w.__dispose();dom.window.close()}}
}
test('username recovery revokes only its local browser session after verified lookup, leaving other client sessions alone',async()=>{
 const h=await mount();try{await h.recover('username');assert.match(h.body(),/已找到账号/);assert.match(h.body(),/fixture-name/);assert.deepEqual(JSON.parse(JSON.stringify(h.signouts)),[{scope:'local'}]);assert.equal(h.updates.length,0);assert.equal(h.verifications[0].type,'recovery');assert.equal(h.requests.length,1);assert.deepEqual(h.errors,[])}finally{h.close()}
})
test('password reset retains global signout after the password is actually updated',async()=>{
 const h=await mount();try{await h.recover('password');assert.equal(h.signouts.length,0);h.fill('input[autocomplete=new-password]','synthetic-password-1234');const inputs=h.w.document.querySelectorAll('input[autocomplete=new-password]');inputs[1].value='synthetic-password-1234';inputs[1].dispatchEvent(new h.w.Event('input',{bubbles:true}));await h.click('确认重置密码');assert.equal(h.updates.length,1);assert.deepEqual(h.signouts,[undefined]);assert.match(h.body(),/密码已重置/);assert.deepEqual(h.errors,[])}finally{h.close()}
})
test('failed username lookup does not claim recovery success or perform any global logout',async()=>{
 const h=await mount(true);try{await h.recover('username');assert.match(h.body(),/synthetic profile unavailable/);assert.doesNotMatch(h.body(),/已找到账号|fixture-name/);assert.equal(h.signouts.length,0);assert.equal(h.updates.length,0);assert.deepEqual(h.errors,[])}finally{h.close()}
})

