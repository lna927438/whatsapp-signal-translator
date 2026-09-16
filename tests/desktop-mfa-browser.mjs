import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {desktopAuthBundle} from './desktop-auth-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder=new URL('../verification/translation-incident-20260916/mfa-browser/',import.meta.url)
await mkdir(folder,{recursive:true})
const bundle=await desktopAuthBundle()
const css=(await Promise.all(['style.css','auth.css','auth-recovery.css','hellodog.css','workspace.css','compactSidebar.css'].map(name=>readFile(new URL('../src/renderer/src/'+name,import.meta.url),'utf8')))).join('\n')
const icon=await readFile(new URL('../src/renderer/public/hellodog-icon.webp',import.meta.url))
const browser=await chromium.launch({channel:'msedge',headless:true}),results=[]
try{
 for(const [width,height,language] of [[1280,800,'zh-CN'],[900,650,'en']]){
 const page=await browser.newPage({viewport:{width,height}})
 const failures=[];page.on('pageerror',error=>failures.push(error.message))
 await page.route('**/*',route=>route.request().url().endsWith('/hellodog-icon.webp')?route.fulfill({contentType:'image/webp',body:icon}):route.abort())
 await page.setContent('<!doctype html><html><head><base href="https://fixture.example.invalid"></head><body><div id="app"></div></body></html>')
 await page.addStyleTag({content:css})
 await page.evaluate(()=>{
 const session={access_token:'synthetic-aal1',user:{id:'fixture-owner',email:'owner@example.invalid'}}
 window.__props={sessionToVerify:session};window.__authenticated=[];window.__cancelled=0
 window.__client={auth:{getSession:async()=>({data:{session},error:null}),signOut:async()=>({error:null}),mfa:{
 listFactors:async()=>({data:{all:[{id:'synthetic-totp',factor_type:'totp',status:'verified'}]},error:null}),
 getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal2'},error:null}),
 challengeAndVerify:async()=>({error:{code:'mfa_verification_failed',message:'Invalid TOTP code entered'}})
 }}}
 })
 await page.addScriptTag({content:bundle});await page.evaluate(value=>window.__setLanguage(value),language)
 const code=page.locator('input[autocomplete=one-time-code]')
 await code.waitFor({state:'visible'});await code.fill('000000');await page.locator('.auth-submit').click()
 await page.locator('.auth-error').waitFor({state:'visible'})
 const geometry=await page.evaluate(()=>{
 const button=document.querySelector('.auth-submit').getBoundingClientRect(),error=document.querySelector('.auth-error').getBoundingClientRect()
 return{scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,button:{x:button.x,y:button.y,right:button.right,bottom:button.bottom},errorBottom:error.bottom}
 })
 assert.ok(geometry.scrollWidth<=width+1);assert.ok(geometry.button.x>=0&&geometry.button.right<=width);assert.ok(geometry.button.bottom<=height);assert.ok(geometry.errorBottom<=height)
 assert.deepEqual(failures,[]);assert.equal(await page.evaluate(()=>window.__authenticated.length),0)
 const title=await page.locator('h2').innerText(),error=await page.locator('.auth-error').innerText()
 assert.match(title,language==='en'?/Security verification/:/安全验证/)
 assert.match(error,language==='en'?/code is not valid/:/验证码不正确/)
 const file='mfa-'+language+'-'+width+'.png';await page.screenshot({path:new URL(file,folder).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true})
 results.push({width,height,language,title,error,geometry,screenshot:file,passed:true});await page.close()
 }
}finally{await browser.close()}
await writeFile(new URL('results.json',folder),JSON.stringify({at:new Date().toISOString(),passed:true,realBrowser:'headless Edge',syntheticAuthenticationOnly:true,networkBlocked:true,results},null,2)+'\n')
console.log(JSON.stringify({passed:true,checks:results.length,results}))

