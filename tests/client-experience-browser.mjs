import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { googleVoiceAppBundle } from './google-voice-ui-fixture.mjs'
const { chromium } = createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder = new URL('../verification/chat-display-20260923/', import.meta.url)
await mkdir(folder, { recursive: true })
const bundle = await googleVoiceAppBundle(['TranslationChannelSelector.vue','ConfirmColor.vue','AccountSetup.vue','NotificationCenter.vue','WorkspaceTools.vue'])
const css = (await Promise.all(['style.css','hellodog.css','workspace.css','compactSidebar.css'].map(name => readFile(new URL('../src/renderer/src/'+name,import.meta.url),'utf8')))).join('\n')
const assets = Object.fromEntries(await Promise.all(['google-voice.svg','whatsapp.svg','signal.svg','hellodog-icon.webp'].map(async name => [name,await readFile(new URL('../src/renderer/public/'+name,import.meta.url))])))
const browser = await chromium.launch({channel:'msedge',headless:true}), results=[]
try {
  for (const [width,height] of [[1280,800],[960,640]]) {
    const page=await browser.newPage({viewport:{width,height}}),errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/*',route=>{const name=route.request().url().split('/').at(-1);if(route.request().url()==='https://fixture.example.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="app"></div></body></html>'});return assets[name]?route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/webp',body:assets[name]}):route.abort()})
    await page.goto('https://fixture.example.invalid/');await page.addStyleTag({content:css})
    await page.evaluate(()=>{
      window.__calls=[];window.__events={};window.__cloudBalance=100000;window.__saveFails=false;window.__settings={provider:'openai',workspaceTheme:'charcoal',accountNavigationPosition:'top'}
      const accounts=[{id:'wa1',platform:'whatsapp',label:'Office',translationProvider:'deepseek',translationColor:'#a4cab8',note:'obsolete hidden note'},{id:'s1',platform:'signal',label:'Signal',signalEngine:'cli'}]
      const voice=[{id:'gv-one',label:'Voice 1',translationProvider:'deepseek'}]
      const snapshot={notices:[],unread:0,update:{verified:true,status:'current',currentVersion:'0.5.16',latestVersion:'0.5.16',notes:'Synthetic release notes'}}
      const methods={focusPlatform:async()=>({state:'ready'}),refreshAccount:async id=>{if(window.__holdRefresh)await new Promise(resolve=>window.__releaseRefresh=resolve);window.__events.onAccountAction({action:'page-ready',accountId:id});return true},listAccounts:async()=>structuredClone(accounts),getSettings:async()=>structuredClone(window.__settings),getLanguages:async()=>[{code:'zh-CN',zhName:'中文'},{code:'en-US',zhName:'英语'}],measureRoutes:async()=>[],reliabilityStatus:async()=>({online:true,accounts:[],pendingSends:[]}),getAccountUnread:async()=>({}),noticesSnapshot:async()=>snapshot,refreshNotices:async()=>snapshot,listGoogleVoiceWindows:async()=>structuredClone(voice),translationChannels:async()=>({defaultProvider:'deepseek',deepseek:{available:true,model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{available:true,model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'}}),updateAccount:async(id,patch)=>{if(window.__holdAccountSave)await new Promise(resolve=>{window.__releaseAccountSave=resolve});if(window.__saveFails)throw Error('模拟保存失败');const item=accounts.find(row=>row.id===id);Object.assign(item,patch);return structuredClone(item)},updateGoogleVoiceWindow:async(id,patch)=>{Object.assign(voice.find(row=>row.id===id),patch);return structuredClone(voice.find(row=>row.id===id))},addGoogleVoiceWindow:async options=>{const record={id:'gv-created',label:options.label,translationProvider:'deepseek'};voice.push(record);return structuredClone(record)}}
      window.desktopAPI=new Proxy({},{get(_target,key){if(String(key).startsWith('on'))return listener=>{window.__events[key]=listener;return()=>delete window.__events[key]};return async(...args)=>{window.__calls.push([key,...args]);return methods[key]?.(...args)}}})
    })
    await page.addScriptTag({content:bundle});await page.locator('.app-home .platform-cards button').last().waitFor()
    assert.equal(await page.locator('.app-home .platform-cards button').count(),3);assert.equal(await page.locator('.account-navigation').count(),0)
    assert.equal(await page.locator('.rail-label').count(),10)
    assert.equal(await page.getByRole('button',{name:'翻译记录与恢复',exact:true}).count(),0)
    assert.deepEqual(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='setOverlayOpen')[0]),['setOverlayOpen',false])
    await page.screenshot({path:fileURLToPath(new URL('home-'+width+'.png',folder))})
    await page.locator('.app-home .platform-cards button').first().click();const setup=page.getByRole('dialog',{name:'新建 WhatsApp 窗口'});await setup.waitFor();assert.doesNotMatch(await setup.innerText(),/账号备注/);await setup.getByRole('button',{name:'关闭',exact:true}).click()
    await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.locator('.channel-control').waitFor()
    assert.doesNotMatch(await page.locator('.account-navigation').innerText(),/obsolete/)
    await page.locator('.channel-buttons').getByRole('button',{name:'OpenAI · gpt-5.6-luna',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.channel-buttons button[aria-pressed=true]')?.textContent==='OpenAI · gpt-5.6-luna')
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='updateAccount').at(-1)[1]),'wa1')
    await page.evaluate(()=>window.__saveFails=true);await page.locator('.channel-buttons').getByRole('button',{name:'DeepSeek · deepseek-v4-pro',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();assert.equal(await page.locator('.channel-buttons button[aria-pressed=true]').innerText(),'OpenAI · gpt-5.6-luna');await page.evaluate(()=>window.__saveFails=false)
    const originalWrites=await page.evaluate(()=>window.__calls.filter(call=>call[0]==='updateAccount').length)
    await page.locator('.color-trigger').click();await page.locator('.color-editor input').fill('#00ff00');await page.locator('.color-editor').getByRole('button',{name:'取消'}).click();assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='updateAccount').length),originalWrites)
    await page.locator('.color-trigger').click();await page.locator('.color-editor input').fill('#aabbcc');await page.locator('.color-editor').getByRole('button',{name:'确定'}).click();await page.locator('.color-editor').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='updateAccount').at(-1)[2].translationColor),'#aabbcc')
    await page.screenshot({path:fileURLToPath(new URL('window-save-failure-'+width+'.png',folder))})
    await page.evaluate(()=>window.__holdAccountSave=true)
    await page.locator('.channel-buttons').getByRole('button',{name:'DeepSeek · deepseek-v4-pro',exact:true}).click()
    await page.getByRole('button',{name:'Signal',exact:true}).click()
    await page.evaluate(()=>{window.__holdAccountSave=false;window.__releaseAccountSave()})
    await page.waitForFunction(()=>window.__calls.filter(call=>call[0]==='updateAccount').at(-1)[1]==='wa1')
    assert.equal(await page.locator('.channel-buttons button[aria-pressed=true]').innerText(),'DeepSeek · deepseek-v4-pro')
    assert.equal(await page.locator('.channel-message').count(),0,'old-window save feedback cannot leak into the selected window')
    await page.getByRole('button',{name:'WhatsApp',exact:true}).click()
    await page.locator('.color-trigger').click();await page.locator('.color-editor input').fill('#334455')
    await page.evaluate(()=>window.__holdAccountSave=true);await page.locator('.color-editor').getByRole('button',{name:'确定'}).click()
    await page.getByRole('button',{name:'Signal',exact:true}).click()
    await page.evaluate(()=>{window.__holdAccountSave=false;window.__releaseAccountSave()})
    await page.waitForFunction(()=>window.__calls.filter(call=>call[0]==='updateAccount').at(-1)[2].translationColor==='#334455')
    assert.equal(await page.locator('.color-editor').count(),0)
    assert.notEqual(await page.locator('.color-trigger i').evaluate(el=>el.style.backgroundColor),'rgb(51, 68, 85)')
    await page.getByRole('button',{name:'WhatsApp',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('.color-trigger i')?.style.backgroundColor==='rgb(51, 68, 85)')
    await page.screenshot({path:fileURLToPath(new URL('window-'+width+'.png',folder))})

    await page.getByRole('button',{name:'消息中心',exact:true}).click();await page.getByText('已是当前最新版本',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'前往官网更新',exact:true}).count(),0);assert.equal(await page.locator('.notices-panel').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 30, 36)');await page.screenshot({path:fileURLToPath(new URL('notifications-'+width+'.png',folder))});await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'HelloDog 工作台',exact:true}).click();await page.locator('.app-home .platform-cards button').last().click();const gv=page.getByRole('dialog',{name:'新增 Google Voice 窗口',exact:true});await gv.getByLabel('窗口名称',{exact:true}).fill('New Voice');await gv.getByRole('button',{name:'创建窗口',exact:true}).click();await page.locator('[data-account-id="gv-created"] [aria-current="true"]').waitFor()
    const focusCount=await page.evaluate(()=>window.__calls.filter(call=>call[0]==='focusGoogleVoiceWindow').length)
    await page.locator('.channel-buttons').getByRole('button',{name:'OpenAI · gpt-5.6-luna',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.channel-buttons button[aria-pressed=true]')?.textContent==='OpenAI · gpt-5.6-luna');assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='focusGoogleVoiceWindow').length),focusCount)
    await page.getByRole('button',{name:'WhatsApp',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('.chat-page-placeholder'))
    await page.evaluate(()=>window.__events.onAccountAction({action:'page-failed',accountId:'wa1'}))
    await page.getByRole('heading',{name:'聊天页面未能显示'}).waitFor()
    const refresh=page.locator('.workspace-tools').getByRole('button',{name:'刷新当前聊天',exact:true})
    await page.evaluate(()=>window.__holdRefresh=true)
    const beforeRefresh=await page.evaluate(()=>window.__calls.filter(call=>call[0]==='refreshAccount').length)
    await refresh.click();await page.keyboard.press('F5');await page.keyboard.press('F5')
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='refreshAccount').length),beforeRefresh+1)
    await page.getByRole('button',{name:'Signal',exact:true}).click()
    await page.evaluate(()=>{window.__holdRefresh=false;window.__releaseRefresh()})
    await page.waitForFunction(()=>document.querySelector('[data-account-id="s1"] [aria-current="true"]'))
    await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.chat-page-placeholder'))
    await page.getByRole('button',{name:'设置与连接诊断',exact:true}).click()
    await page.keyboard.press('F5')
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='refreshAccount').length),beforeRefresh+1,'modal F5 cannot reload the hidden chat')
    await page.keyboard.press('Escape')
    assert.deepEqual(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='setOverlayOpen').at(-1)),['setOverlayOpen',false])
    await page.getByRole('button',{name:'HelloDog 官网',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='openOfficialWebsite').length),1)
    await page.getByRole('button',{name:'一键重启',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='restartApp').length),1)
    await page.screenshot({path:fileURLToPath(new URL('display-recovered-'+width+'.png',folder))})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[])
    await page.evaluate(()=>window.__dispose());results.push({width,height,passed:true});await page.close()
  }
} finally {await browser.close()}
await writeFile(new URL('results.json',folder),JSON.stringify({passed:true,syntheticOnly:true,results},null,2)+'\n');console.log(JSON.stringify({passed:true,results}))
