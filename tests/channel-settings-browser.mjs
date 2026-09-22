import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
const require=createRequire(import.meta.url)
const {chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const folder=new URL('../verification/two-model-settings-20260922/',import.meta.url);await mkdir(folder,{recursive:true})
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
 await select.selectOption('openai');await page.waitForFunction(()=>window.__settings.translationProvider==='openai')
 await page.screenshot({path:fileURLToPath(new URL('settings-'+width+'.png',folder))})
 await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByText('模型翻译测试 · OpenAI · gpt-5.6-luna',{exact:true}).waitFor();await page.getByRole('button',{name:'测试翻译',exact:true}).click();await page.getByText('云端翻译连接成功。',{exact:true}).waitFor()
 const tested=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='testTranslationConfig'));assert.equal(tested.length,1);assert.equal(tested[0][1].translationProvider,'openai');assert.equal(tested[0][1].provider,'openai')
 // A change while session recovery waits cancels before any paid test request.
 await page.evaluate(()=>window.__holdAuth=true);await page.getByRole('button',{name:'测试翻译',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseAuth==='function')
 await page.locator('.api-test-card textarea').fill('Changed while checking session')
 await page.getByRole('button',{name:'翻译',exact:true}).click();await select.selectOption('deepseek');await page.waitForFunction(()=>window.__settings.translationProvider==='deepseek')
 await page.evaluate(()=>{window.__holdAuth=false;window.__releaseAuth()});await page.waitForFunction(()=>!document.querySelector('.api-test-card button').disabled)
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='testTranslationConfig').length),1)
 // Once dispatched, the test keeps the clicked model/text; a newer selection hides its late result.
 await select.selectOption('openai');await page.waitForFunction(()=>window.__settings.translationProvider==='openai');await page.getByRole('button',{name:'连接',exact:true}).click();await page.locator('.api-test-card textarea').fill('Snapshot text')
 await page.evaluate(()=>window.__holdTest=true);await page.getByRole('button',{name:'测试翻译',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseTest==='function')
 await page.locator('.api-test-card textarea').fill('Newer draft')
 await page.getByRole('button',{name:'翻译',exact:true}).click();await select.selectOption('deepseek');await page.waitForFunction(()=>window.__settings.translationProvider==='deepseek')
 await page.evaluate(()=>{window.__holdTest=false;window.__releaseTest()});await page.getByRole('button',{name:'连接',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.api-test-card button').disabled)
 const delayed=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='testTranslationConfig').at(-1));assert.equal(delayed[1].translationProvider,'openai');assert.equal(delayed[2],'Snapshot text');assert.equal(delayed[3],'zh-CN')
 assert.equal(await page.locator('.api-result').count(),0);assert.equal(await page.locator('.api-badge').innerText(),'未测试');await page.getByText('模型翻译测试 · DeepSeek · deepseek-v4-pro',{exact:true}).waitFor()
 await page.getByRole('button',{name:'翻译',exact:true}).click();await select.selectOption('openai');await page.waitForFunction(()=>window.__settings.translationProvider==='openai')
 await page.getByRole('button',{name:'翻译',exact:true}).click();await page.evaluate(()=>window.__saveFails=true);await select.selectOption('deepseek');await page.getByRole('status').filter({hasText:'模拟保存失败'}).waitFor();assert.equal(await select.inputValue(),'openai');await page.evaluate(()=>window.__saveFails=false)
 await select.selectOption('deepseek');await page.waitForFunction(()=>window.__settings.translationProvider==='deepseek');await page.evaluate(()=>window.__openaiAvailable=false);await page.getByRole('button',{name:'刷新模型状态',exact:true}).click();await page.waitForFunction(()=>document.querySelector('option[value="openai"]')?.disabled===true)
 assert.match(await select.locator('option[value="openai"]').innerText(),/OpenAI · gpt-5.6-luna · 暂不可用/)
 const channelChecks=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='translationChannels'));assert.equal(channelChecks[0][1],false);assert.equal(channelChecks.at(-1)[1],true)
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 await page.evaluate(()=>window.__dispose());results.push({width,height,passed:true,networkRequests:requests.length});await page.close()
}}finally{await browser.close()}
await writeFile(new URL('results.json',folder),JSON.stringify({passed:true,syntheticOnly:true,results},null,2)+'\n');console.log(JSON.stringify({passed:true,results}))
