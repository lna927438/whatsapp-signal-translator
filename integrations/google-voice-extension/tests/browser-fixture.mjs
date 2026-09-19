import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = new URL('../', import.meta.url), output = new URL('./artifacts/', import.meta.url)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  // This isolated browser never reaches Google, a user profile or a native host.
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', value => errors.push(value.message))
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>Local synthetic fixture</title></head><body><h1>Local fixture — no Google account</h1><div id="thread" data-id="fixture-1"><textarea id="draft">你好</textarea><button id="send">原站发送</button></div><button id="confirm">确认预览发送</button><p id="preview"></p><p id="sent"></p></body></html>' }))
  await page.goto('https://voice.google.com/__hellodog_fixture__')
  await page.addScriptTag({ type: 'module', content: (await readFile(new URL('protocol.mjs', root), 'utf8')) + '\n' + (await readFile(new URL('send-guard.mjs', root), 'utf8')).replace(/^import[^\n]*\n/, '') + `
    const draft=document.getElementById('draft'),send=document.getElementById('send'),thread=document.getElementById('thread');
    window.sent=[];window.fail=false;window.authorized=true;let revision=0,allowButton=null;
    draft.addEventListener('input',()=>revision++);
    const adapter={supported:true,snapshot:()=>({conversationId:thread.dataset.id,text:draft.value,revision,composer:draft,sendButton:send}),
      replace:(old,text)=>{if(old.conversationId!==thread.dataset.id||old.text!==draft.value)return false;draft.value=text;revision++;return true},
      dispatch:()=>{allowButton=send;try{send.click()}finally{allowButton=null}},
      isSendEvent:event=>{if(event.type==='click')return event.target===send&&allowButton!==send;if(!draft.contains(event.target))return false;return (event.key==='Enter'&&!event.shiftKey)||event.type==='beforeinput'&&event.inputType==='insertParagraph'} };
    const bridge={status:async()=>({connected:true,sendAutoTranslate:true,targetLanguage:'en-US'}),translate:async()=>{if(window.fail)throw new Error('fixture offline');return{enabled:true,text:'Hello fixture',requestId:'fixture-request'}},authorize:async()=>({authorized:window.authorized,requestId:'fixture-request',attempt:1})};
    const guard=new SendGuard(adapter,bridge);window.guard=guard;
    installSendInterception(window,adapter,async()=>{const result=await guard.prepare();document.getElementById('preview').textContent=result.text},error=>{window.lastError=error.message});
    send.addEventListener('click',()=>{window.sent.push(draft.value);document.getElementById('sent').textContent=draft.value});
    document.getElementById('confirm').onclick=()=>guard.confirm().catch(error=>{window.lastError=error.message});
    window.fixtureReady=true;
  ` })
  await page.waitForFunction(() => window.fixtureReady)
  await page.locator('#draft').press('Enter')
  await page.waitForFunction(() => window.guard.state === 'preview')
  assert.deepEqual(await page.evaluate(() => window.sent), [])
  assert.equal(await page.locator('#draft').inputValue(), '你好')
  await page.locator('#draft').fill('草稿已变化')
  await page.locator('#confirm').click()
  await page.waitForFunction(() => window.lastError?.includes('变化'))
  assert.deepEqual(await page.evaluate(() => window.sent), [])
  await page.evaluate(() => { window.fail = true })
  await page.locator('#send').click()
  await page.waitForFunction(() => window.lastError === 'fixture offline')
  assert.deepEqual(await page.evaluate(() => window.sent), [])
  await page.evaluate(() => { window.fail = false })
  await page.locator('#send').click()
  await page.waitForFunction(() => window.guard.state === 'preview')
  await page.locator('#confirm').click()
  await page.waitForFunction(() => window.sent.length === 1)
  assert.deepEqual(await page.evaluate(() => window.sent), ['Hello fixture'])
  await page.locator('#confirm').click()
  assert.deepEqual(await page.evaluate(() => window.sent), ['Hello fixture'])

  // Verify actual production preview rendering and document-bound reply ticket.
  await page.evaluate(() => { window.chrome = { runtime: { id: 'kigfaejcipjibnmnpinplphfldjahknn', onMessage: { addListener: fn => { window.extensionMessage = fn }, removeListener: fn => { if (window.extensionMessage === fn) window.extensionMessage = null } } } } })
  await page.addScriptTag({ content: await readFile(new URL('content.js', root), 'utf8') })
  const proof = await page.evaluate(() => {
    let response; const id = crypto.randomUUID(), sender = { id: chrome.runtime.id }
    window.extensionMessage({ v: 1, type: 'selection.open', id }, sender, result => { response = result })
    window.extensionMessage({ v: 1, type: 'selection.begin', id, key: 'a'.repeat(64) }, sender, result => { response = result })
    window.extensionMessage({ v: 1, type: 'selection.result', id, ticket: 'wrong-ticket', text: 'must not render' }, sender, () => {})
    const before = document.body.children.length
    window.extensionMessage({ v: 1, type: 'selection.result', id, ticket: response.ticket, text: '<img src=x onerror=alert(1)> literal text' }, sender, () => {})
    return { before, after: document.body.children.length, images: document.querySelectorAll('img').length }
  })
  assert.equal(proof.after, proof.before + 1); assert.equal(proof.images, 0)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: fileURLToPath(new URL('fixture.png', output)) })
  const result = { at: new Date().toISOString(), passed: true, scope: 'Isolated Edge local fixture, all network routes fulfilled locally; no real extension installation, accounts, native host, messages or calls', checks: ['capture Enter', 'capture send click', 'explicit preview confirm', 'draft changed blocks send', 'translation failure preserves source', 'translated text dispatched once', 'uncertain cannot replay', 'document ticket binds selection result', 'HTML rendered as literal text', 'no page errors'] }
  await writeFile(new URL('browser-results.json', output), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser.close() }
