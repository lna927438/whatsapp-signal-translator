import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {workspaceUiBundle} from './workspace-ui-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder=new URL('../verification/workspace-ui-20261012/',import.meta.url);await mkdir(folder,{recursive:true})
const bundle=await workspaceUiBundle(),css=(await Promise.all(['style.css','hellodog.css','workspace.css','compactSidebar.css'].map(name=>readFile(new URL('../src/renderer/src/'+name,import.meta.url),'utf8')))).join('\n')
const icons=Object.fromEntries(await Promise.all(['whatsapp.svg','signal.svg','telegram.svg'].map(async name=>[name,await readFile(new URL('../src/renderer/public/'+name,import.meta.url))])))
const browser=await chromium.launch({channel:'msedge',headless:true}),results=[]
try{
 for(const [platform,position,theme,width,height,language] of [['whatsapp','top','charcoal',1280,800,'zh-CN'],['signal','top','soft',960,640,'en'],['whatsapp','side','charcoal',1100,700,'zh-CN'],['telegram','top','charcoal',960,640,'zh-CN'],['telegram','side','soft',1280,800,'en']]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{const name=route.request().url().split('/').at(-1);return icons[name]?route.fulfill({contentType:'image/svg+xml',body:icons[name]}):route.abort()})
 await page.setContent('<!doctype html><html><head><base href="https://fixture.example.invalid"></head><body><div id="app"></div></body></html>');await page.addStyleTag({content:css})
 await page.evaluate(()=>{window.__calls=[];window.desktopAPI={noticeAction:async(key,action)=>{window.__calls.push([key,action]);return {...window.__state.snapshot,notices:window.__state.snapshot.notices.map(n=>({...n,dismissed:true})),unread:0}},refreshNotices:async()=>{window.__calls.push(['refresh']);return window.__state.snapshot}}})
 await page.addScriptTag({content:bundle});await page.evaluate(({platform,position,theme,language})=>{window.__lang(language);window.__set({platform,position,theme,accounts:[{id:'a',platform,label:'Work',pinned:true},{id:'b',platform,label:'Friends'},{id:'c',platform,label:'Family'}],selectedId:'a'})},{platform,position,theme,language})
 const b=page.locator('[data-account-id=b] .account-switch'),a=page.locator('[data-account-id=a] .account-switch'),c=page.locator('[data-account-id=c] .account-switch')
 await b.click();assert.equal(await page.evaluate(()=>window.__state.selectedId),'b')
 const ra=await a.boundingBox(),rc=await c.boundingBox();await page.mouse.move(ra.x+ra.width/2,ra.y+ra.height/2);await page.mouse.down();await page.mouse.move(rc.x+rc.width/2,rc.y+rc.height/2,{steps:14});await page.mouse.up()
 assert.deepEqual(await page.locator('.account-tab').evaluateAll(nodes=>nodes.map(n=>n.dataset.accountId)),['b','c','a'])
 assert.equal(await page.evaluate(()=>window.__state.selectedId),'b');assert.equal(await page.evaluate(()=>window.__events.filter(e=>e[0]==='remove').length),0)
 assert.equal(await page.locator('.dragging').count(),0)
 await a.focus();await page.keyboard.press('Alt+ArrowLeft');assert.deepEqual(await page.locator('.account-tab').evaluateAll(nodes=>nodes.map(n=>n.dataset.accountId)),['b','a','c'])
 const r=await b.boundingBox();await page.mouse.move(r.x+20,r.y+12);await page.mouse.down();await page.mouse.move(r.x+32,r.y+13);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();assert.equal(await page.locator('.dragging').count(),0)
 await page.locator('[data-account-id=c] .account-close').click();assert.equal(await page.evaluate(()=>window.__events.filter(e=>e[0]==='remove').length),1)
 const beforeReorder=await page.evaluate(()=>window.__events.filter(e=>e[0]==='reorder').length),from=await a.boundingBox(),to=await c.boundingBox()
 await page.mouse.move(from.x+18,from.y+12);await page.mouse.down();await page.mouse.move(to.x+18,to.y+12,{steps:8})
 await page.evaluate(()=>window.__set({accounts:[...window.__state.accounts,{id:'new',label:'Added while dragging',platform:window.__state.platform}]}));await page.mouse.up()
 assert.equal(await page.evaluate(()=>window.__events.filter(e=>e[0]==='reorder').length),beforeReorder);assert.equal(await page.locator('.dragging').count(),0)
 assert.deepEqual(await page.locator('.account-tab').evaluateAll(nodes=>nodes.map(n=>n.dataset.accountId)),['b','a','c','new'])
 await page.locator('#notice-trigger').focus();await page.locator('#notice-trigger').click();await page.locator('.notices-panel').waitFor()
 const background=await page.locator('.notices-panel').evaluate(el=>getComputedStyle(el).backgroundColor);assert.match(background,/^rgb\(/);assert.notEqual(background,'rgba(0, 0, 0, 0)')
 await page.evaluate(()=>window.__set({snapshot:{notices:[{id:'synthetic',revision:1,title:'A clear notice',body:'Readable solid panel. No real notification was sent.',releaseVersion:'0.5.17',starts_at:'2026-09-17T00:00:00Z',action:'download',dismissed:false}],unread:1,update:{verified:true,status:'available',currentVersion:'0.5.16',latestVersion:'0.5.17'}}}))
 const first=page.locator('.notices-panel header button'),last=page.locator('.notice-bottom button');await first.focus();await page.keyboard.press('Shift+Tab');assert.equal(await last.evaluate(el=>el===document.activeElement),true)
 await page.keyboard.press('Tab');assert.equal(await first.evaluate(el=>el===document.activeElement),true)
 await page.locator('.notice-item.unread footer button').first().click();assert.equal(await page.evaluate(()=>window.__state.snapshot.unread),0)
 await page.locator('.notice-item').last().locator('footer button').click();assert.equal(await page.evaluate(()=>window.__calls.filter(x=>x[1]==='open').length),1)
 await last.click();assert.equal(await page.evaluate(()=>window.__calls.filter(x=>x[0]==='refresh').length),1)
 const filename=platform+'-'+position+'-'+theme+'.png';await page.screenshot({path:fileURLToPath(new URL(filename,folder)),fullPage:true})
 await page.keyboard.press('Escape');assert.equal(await page.locator('.notices-panel').count(),0);assert.equal(await page.locator('#notice-trigger').evaluate(el=>document.activeElement===el),true)
 assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 results.push({platform,position,theme,width,height,background,screenshot:filename,passed:true});await page.close()
 }
}finally{await browser.close()}
await writeFile(new URL('browser-results.json',folder),JSON.stringify({passed:true,at:new Date().toISOString(),syntheticOnly:true,realBrowser:'Edge',results},null,2)+'\n');console.log(JSON.stringify({passed:true,results}))
