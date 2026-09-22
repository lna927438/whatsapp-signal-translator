import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
const require=createRequire(import.meta.url)
const {chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const folder=new URL('../verification/settings-updates-20260923/',import.meta.url);await mkdir(folder,{recursive:true})
const bundle=await build({stdin:{resolveDir:fileURLToPath(new URL('../src/renderer/src/',import.meta.url)),contents:`import {createApp} from 'vue';import SettingsPanel from './components/SettingsPanel.vue';const app=createApp(SettingsPanel,{initialTab:"updates"});app.mount('#app');window.__dispose=()=>app.unmount();`,loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'isolated-settings',setup(build){
 build.onResolve({filter:/(?:^|\/)supabase$/},()=>({path:'supabase',namespace:'fixture-auth'}))
 build.onLoad({filter:/.*/,namespace:'fixture-auth'},()=>({loader:'js',contents:'export const requireSupabase=()=>({auth:{getSession:async()=>({data:{session:{user:{id:"fixture-user"},access_token:"synthetic-not-real"}}})}});'}))
 build.onLoad({filter:/\.vue$/},async({path})=>{const {descriptor}=parse(await readFile(path,'utf8'),{filename:path}),id='data-v-fixture-'+path.replace(/\W/g,''),script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component='),css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:path,id,scoped:style.scoped}).code).join('\n');return{loader:'ts',resolveDir:dirname(path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}})
}}]})
const css=(await Promise.all(['style.css','hellodog.css','workspace.css','compactSidebar.css'].map(name=>readFile(new URL('../src/renderer/src/'+name,import.meta.url),'utf8')))).join('\n')
const browser=await chromium.launch({channel:'msedge',headless:true}),results=[]
try{for(const [width,height] of [[1280,800],[960,700]]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{if(route.request().url()==='https://fixture.example.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div class="app-shell compact-shell" data-theme="charcoal"><div id="app"></div></div></body></html>'});requests.push(route.request().url());return route.abort()})
 await page.goto('https://fixture.example.invalid/');await page.addStyleTag({content:css})
 await page.evaluate(()=>{
  window.__calls=[];window.__versionStatus='current';window.__phase='available';window.__failRestart=false;window.__failWebsite=false
  const methods={getSettings:async()=>({provider:'openai',translationProvider:'deepseek',translationQuality:{},localLanguage:'zh-CN',targetLanguage:'en-US'}),getLanguages:async()=>[],translationChannels:async()=>({deepseek:{available:true},openai:{available:false}}),updateNotice:async()=>({verified:window.__versionStatus!=='unknown',status:window.__versionStatus,currentVersion:'0.5.17',latestVersion:window.__versionStatus==='available'?'0.5.18':'0.5.17',notes:'提升窗口恢复与连接稳定性。'}),updateInfo:async()=>({currentVersion:'0.5.17',manifest:{version:window.__versionStatus==='available'?'0.5.18':'0.5.1',channel:'stable',size:104857600},newer:window.__versionStatus==='available',phase:window.__phase}),checkUpdate:async()=>({version:'0.5.18'}),downloadUpdate:async()=>{window.__phase='verified'},openUpdateInstaller:async()=>{window.__phase='opened'},restartApp:async()=>{if(window.__failRestart)throw Error('草稿保存失败，暂未重启');await window.__HELLODOG_PREPARE_RESTART__?.()},openOfficialWebsite:async()=>{if(window.__failWebsite)throw Error('官网暂时无法打开，请稍后重试。')}}
  window.desktopAPI=new Proxy({},{get(_target,key){if(String(key).startsWith('on'))return()=>()=>{};return async(...args)=>{window.__calls.push([key,...args]);return methods[key]?.(...args)}}})
 })
 await page.addScriptTag({content:bundle.outputFiles[0].text});await page.getByText('已是当前最新版本',{exact:true}).waitFor()
 assert.equal(await page.locator('.settings-tabs button[aria-pressed=true]').innerText(),'版本与更新');assert.equal(await page.getByRole('button',{name:'前往官网更新',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'打开已校验的安装包',exact:true}).count(),0)
 await page.screenshot({path:fileURLToPath(new URL('current-'+width+'.png',folder))})
 await page.evaluate(()=>window.__versionStatus='available');await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByText('发现新版本 0.5.18',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.version-summary button').disabled)
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='updateNotice').at(-1)[1]),true)
 await page.screenshot({path:fileURLToPath(new URL('available-'+width+'.png',folder))})
 await page.getByRole('button',{name:'下载并校验',exact:true}).click();await page.getByRole('button',{name:'打开已校验的安装包',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.version-actions button').disabled)
 await page.evaluate(()=>{const prepare=window.__HELLODOG_PREPARE_RESTART__;window.__prepared=0;window.__HELLODOG_PREPARE_RESTART__=async()=>{window.__prepared++;return prepare?.()}})
 await page.getByRole('button',{name:'打开已校验的安装包',exact:true}).click();await page.getByText('安装程序已打开，请按提示完成更新。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__prepared),1)
 await page.evaluate(()=>window.__failRestart=true);await page.getByRole('button',{name:'一键重启',exact:true}).click();await page.getByRole('alert').filter({hasText:'草稿保存失败，暂未重启'}).waitFor()
 await page.evaluate(()=>window.__failRestart=false);await page.getByRole('button',{name:'一键重启',exact:true}).click();await page.waitForFunction(()=>window.__prepared===2)
 await page.evaluate(()=>window.__failWebsite=true);await page.getByRole('button',{name:'前往官网',exact:true}).click();await page.getByRole('alert').filter({hasText:'官网暂时无法打开'}).waitFor()
 await page.evaluate(()=>window.__versionStatus='unknown');await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByText('版本检查尚未完成',{exact:true}).waitFor();await page.getByRole('alert').filter({hasText:'暂时无法确认最新版本'}).waitFor()
 assert.equal(await page.getByRole('button',{name:'前往官网更新',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'打开已校验的安装包',exact:true}).count(),0)
 const forbidden=await page.evaluate(()=>window.__calls.filter(c=>['reliabilityHistory','reliabilityStatus','contentRetention','getProfile','cloudRead'].includes(c[0])));assert.deepEqual(forbidden,[])
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 await page.evaluate(()=>window.__dispose());results.push({width,height,passed:true,networkRequests:requests.length});await page.close()
}}finally{await browser.close()}
await writeFile(new URL('results.json',folder),JSON.stringify({passed:true,syntheticOnly:true,results},null,2)+'\n');console.log(JSON.stringify({passed:true,results}))
