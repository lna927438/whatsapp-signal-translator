import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { posix, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { mainHarness } from './main-harness.ts'

const { chromium }=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const modules=mainHarness(),baseline='08f7d3d66f515957a2687989fb34760ad380e129'
const output=new URL('../verification/voice-performance-20261012/',import.meta.url);await mkdir(output,{recursive:true})
function script(file,name,old=false){
 if(!old)return modules.load(file)[name]
 const source=execFileSync('git',['show',baseline+':'+file],{encoding:'utf8'}),exports={}
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 runInNewContext(code,{exports,require:name=>modules.load(posix.normalize(posix.join(posix.dirname(file),name)))})
 return exports[name]
}
const browser=await chromium.launch({channel:'msedge',headless:true})
async function whatsapp(old){
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 const rows=Array.from({length:80},(_,i)=>`<div class="message-in" data-id="false_123@c.us_${i}"><button data-icon="audio-play">Play</button><audio src="blob:https://web.whatsapp.com/voice-${i}"></audio></div>`).join('')
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><body><div id="side"></div><div id="main"><header><span title="Test" dir="auto">Test</span></header>${rows}</div></body>`}));await page.goto('https://web.whatsapp.com')
 await page.evaluate(()=>{
  window.counts={rowQueries:0,audioQueries:0};window.translations=0
  const list=Element.prototype.querySelectorAll;Element.prototype.querySelectorAll=function(selector){if(selector==='.message-in,.message-out,[data-testid="msg-container"],[data-id]')window.counts.rowQueries++;return list.call(this,selector)}
  const all=Document.prototype.querySelectorAll;Document.prototype.querySelectorAll=function(selector){if(selector==='audio')window.counts.audioQueries++;return all.call(this,selector)}
  window.realtimeTranslator={translateVoiceMessage:()=>{window.translations++;throw Error('No automatic translation allowed')}}
 })
 await page.evaluate(script('src/main/platforms/whatsapp/inject/voiceMessages.ts','whatsappVoiceScript',old));await page.waitForTimeout(350)
 assert.equal(await page.locator('.rt-voice-translation').count(),80)
 const initial=await page.evaluate(()=>({...window.counts}));await page.evaluate(()=>window.counts={rowQueries:0,audioQueries:0})
 await page.evaluate(async()=>{for(let i=0;i<100;i++){document.querySelector('header span').title='Test '+i;await Promise.resolve()}});await page.waitForTimeout(250)
 const burst=await page.evaluate(()=>({...window.counts}));await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.counts={rowQueries:0,audioQueries:0}})
 await page.evaluate(async()=>{for(let i=0;i<100;i++){document.querySelector('header span').title='Background '+i;await Promise.resolve()}});await page.waitForTimeout(250)
 const hidden=await page.evaluate(()=>({...window.counts}));assert.equal(await page.evaluate(()=>window.translations),0);assert.deepEqual(errors,[]);await page.close();return {initial,burst,hidden}
}
async function telegram(old){
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 const row='<div class="Message" data-message-id="10"><div class="message-content"><div class="Audio inline"><button class="toggle-play">Play</button><div class="duration">0:18</div></div></div></div>'
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><body><div id="LeftColumn"></div><div id="MiddleColumn"><div class="MessageList"><div class="messages-container">${row}<div class="list-bottom-marker"></div></div></div><div class="Composer"><div id="editable-message-text" contenteditable="true"></div></div></div></body>`}));await page.goto('https://web.telegram.org/a/#12345')
 await page.evaluate(()=>{
  window.scans=0;window.translations=0
  const list=Element.prototype.querySelectorAll;Element.prototype.querySelectorAll=function(selector){if(selector==='.Message[data-message-id]')window.scans++;return list.call(this,selector)}
  window.realtimeTranslator={getRuntimeSettings:async()=>({receiveAutoTranslate:false,historyMode:'manual'}),pendingSends:async()=>[],reportConversation(){},reportConnection(){},reportUnread(){},reportStatus(){},translateVoiceMessage(){window.translations++;throw Error('No automatic translation allowed')}}
 })
 await page.evaluate(script('src/main/platforms/telegram/inject/script.ts','telegramInjectionScript',old));await page.waitForTimeout(1250);assert.equal(await page.locator('[data-rt-ui="voice"]').count(),1)
 await page.evaluate(()=>window.scans=0)
 for(let i=0;i<6;i++){await page.evaluate(n=>{document.querySelector('.duration').textContent='0:'+n;document.querySelector('.toggle-play').classList.toggle('playing')},i);await page.waitForTimeout(220)}
 const playbackQueries=await page.evaluate(()=>window.scans);assert.equal(await page.evaluate(()=>window.translations),0);assert.deepEqual(errors,[]);await page.close();return {playbackQueries}
}
try{
 const before={whatsapp:await whatsapp(true),telegram:await telegram(true)},after={whatsapp:await whatsapp(false),telegram:await telegram(false)}
 assert.equal(after.whatsapp.burst.rowQueries,1);assert.equal(after.whatsapp.burst.audioQueries,1);assert.equal(after.whatsapp.hidden.rowQueries,0);assert.equal(after.whatsapp.hidden.audioQueries,0);assert.equal(after.telegram.playbackQueries,0)
 assert.ok(before.whatsapp.burst.rowQueries>after.whatsapp.burst.rowQueries);assert.ok(before.whatsapp.burst.audioQueries>after.whatsapp.burst.audioQueries);assert.ok(before.telegram.playbackQueries>after.telegram.playbackQueries)
 const report={passed:true,at:new Date().toISOString(),baseline,before,after,workload:{whatsappVoiceRows:80,mutationMicrotasks:100,telegramPlaybackTicks:6},scope:'Synthetic isolated Edge DOM with no account, recognition or translation calls. Counts measure full message/audio query overhead, not provider latency or real-client FPS.'}
 await writeFile(new URL('scan-performance.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close();assert.match(relative(resolve(tmpdir()),resolve(modules.directory)),/^hellodog-test-[A-Za-z0-9]+$/);await rm(modules.directory,{recursive:true,force:true})}
