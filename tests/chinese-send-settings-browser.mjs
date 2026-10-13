import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
const require=createRequire(import.meta.url)
const {chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const folder=new URL('../verification/chinese-send-switch-20261013/',import.meta.url);await mkdir(folder,{recursive:true})
const bundle=await build({stdin:{resolveDir:fileURLToPath(new URL('../src/renderer/src/',import.meta.url)),contents:`import {createApp} from 'vue';import SettingsPanel from './components/SettingsPanel.vue';const app=createApp(SettingsPanel);app.mount('#app');window.__dispose=()=>app.unmount();`,loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'isolated-settings',setup(build){
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
  window.__calls=[];window.__saveFails=false;window.__openaiAvailable=true
  window.__settings={provider:'openai',translationProvider:'deepseek',localLanguage:'zh-CN',targetLanguage:'en-US',translationQuality:{},receiveAutoTranslate:true,sendAutoTranslate:true,cloudRoute:'auto'}
  const methods={getSettings:async()=>structuredClone(window.__settings),getLanguages:async()=>[{code:'zh-CN',zhName:'中文'},{code:'en-US',zhName:'英语'}],translationChannels:async()=>({defaultProvider:'deepseek',checked:true,selectionSupported:true,deepseek:{available:true,model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{available:window.__openaiAvailable,model:'gpt-5.6-luna',displayName:'gpt-5.6-luna',reason:window.__openaiAvailable?undefined:'管理员尚未启用此通道'}}),saveSettings:async value=>{if(window.__saveFails)throw Error('模拟保存失败');window.__settings=structuredClone(value)},measureRoutes:async()=>[],diagnoseConnection:async()=>[],testTranslationConfig:async()=>{if(window.__holdTest)await new Promise(resolve=>window.__releaseTest=resolve);return {ok:true,translated:'你好吗？'}},authSetOnlineSession:async()=>{if(window.__holdAuth)await new Promise(resolve=>window.__releaseAuth=resolve);return true}}
  window.desktopAPI=new Proxy({},{get(_target,key){if(String(key).startsWith('on'))return()=>()=>{};return async(...args)=>{window.__calls.push([key,...args]);return methods[key]?.(...args)}}})
 })
 await page.addScriptTag({content:bundle.outputFiles[0].text})
 const select=page.getByRole('combobox',{name:'新窗口默认翻译模型',exact:true});await select.waitFor();await page.waitForFunction(()=>document.querySelector('select[aria-label="新窗口默认翻译模型"] option')?.textContent.includes('deepseek-v4-pro'))
 assert.deepEqual(await select.locator('option').allTextContents(),['DeepSeek · deepseek-v4-pro','OpenAI · gpt-5.6-luna'])
 assert.doesNotMatch(await page.locator('.settings-panel').innerText(),/DeepL|Google Cloud Translation|API Key/)
 const chinese=page.getByRole('checkbox',{name:/禁止发送中文/});assert.equal(await chinese.isEnabled(),true);assert.equal(await chinese.isChecked(),true)
 await chinese.uncheck();await page.waitForFunction(()=>window.__settings.blockChineseSend===false)
 await chinese.check();await page.waitForFunction(()=>window.__settings.blockChineseSend===true)
 await page.evaluate(()=>window.__saveFails=true);await chinese.click();await page.getByRole('status').filter({hasText:'模拟保存失败'}).waitFor();assert.equal(await chinese.isChecked(),true);assert.equal(await page.evaluate(()=>window.__settings.blockChineseSend),true);await page.evaluate(()=>window.__saveFails=false)
 await page.screenshot({path:fileURLToPath(new URL('settings-switch-'+width+'.png',folder))})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 await page.evaluate(()=>window.__dispose());results.push({width,height,enabledToggle:true,offSavesFalse:true,onSavesTrue:true,failedSaveRestores:true,networkRequests:requests.length});await page.close()
}}finally{await browser.close()}
await writeFile(new URL('results.json',folder),JSON.stringify({passed:true,syntheticOnly:true,results},null,2)+'\n');console.log(JSON.stringify({passed:true,results}))