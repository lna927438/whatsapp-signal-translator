import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import worker, { type Env } from '../server/worker/src/index.ts'
const require = createRequire(import.meta.url)
const { SessionRefresh, authenticatedFetch } = require('../src/main/network/sessionRefresh.ts')
const { OutgoingCredit } = require('../src/main/translation/outgoingCredit.ts')
const { SendTasks } = require('../src/main/translation/sendTasks.ts')
const { hasBlockedChinese } = require('../src/main/translation/outgoingPolicy.ts')
const { lowCharacterBalance } = require('../src/shared/characterQuota.ts')
const { installSendBootstrapGuard } = require('../src/preload/sendBootstrapGuard.ts')
const { whatsappInjectionScript } = require('../src/main/platforms/whatsapp/inject/script.ts')
const token = (seconds: number, value = 'x') => 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+seconds, value })).toString('base64url') + '.test'
const request = { text: '你好', sourceLanguage: 'zh-CN', targetLanguage: 'en-US', requestId: 'send-quota-fixture' }
const snapshot = (balance: unknown, reserved = 0) => ({user:{id:'owner'},profile:{status:'active'},wallet:{balance,reserved_characters:reserved}})

test('expired concurrent requests share one refresh; an account change cancels the old wait', async () => {
  let identity:any = {userId:'owner',accessToken:token(-10)}, pending:any, prompts=0
  const gate = new SessionRefresh(()=>identity,(value:any)=>{pending=value;prompts++},1000)
  const a=gate.token('owner'),b=gate.token('owner');assert.equal(prompts,1)
  identity={userId:'owner',accessToken:token(3600)};gate.complete(pending.id,true)
  assert.equal(await a,identity.accessToken);assert.equal(await b,identity.accessToken)
  identity={userId:'owner',accessToken:token(-10)}
  const previous=gate.token('owner');const rejected=assert.rejects(previous,/登录/)
  identity={userId:'other',accessToken:token(3600,'other')};gate.changed();await rejected
})
test('a 401 for a replaced token reuses the fresh token without a second refresh storm', async () => {
  const expired=token(-10),fresh=token(3600)
  const gate=new SessionRefresh(()=>({userId:'owner',accessToken:fresh}),()=>assert.fail('Unexpected refresh'))
  assert.equal(await gate.token('owner',true,expired),fresh)
})
test('refresh timeout blocks the request instead of returning the expired token', async () => {
  const gate=new SessionRefresh(()=>({userId:'owner',accessToken:token(-10)}),()=>{},5)
  await assert.rejects(gate.token('owner'),/草稿已保留/)
})
test('authentication retry preserves the original translation request and performs only one retry', async () => {
  const prior=globalThis.fetch,calls:any[]=[],refreshes:boolean[]=[]
  globalThis.fetch=async(_url,init)=>{calls.push(init);return new Response('{}',{status:calls.length===1?401:200})}
  try {
    const body=JSON.stringify({requestId:'send-original',text:'你好'})
    const result=await authenticatedFetch(async(force:boolean)=>{refreshes.push(force);return force?'fresh':'old'},'https://test.invalid/api/translate',{method:'POST',body,headers:{'x-request-id':'send-original'}},1000)
    assert.equal(result.status,200);assert.equal(calls.length,2);assert.deepEqual(refreshes,[false,true])
    assert.equal(calls[0].body,calls[1].body);assert.equal(new Headers(calls[1].headers).get('x-request-id'),'send-original')
    assert.equal(new Headers(calls[1].headers).get('Authorization'),'Bearer fresh')
  } finally {globalThis.fetch=prior}
})
test('network/service failures do not force sign-out or automatically resubmit a translation', async () => {
  const prior=globalThis.fetch;let calls=0
  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:503})}
  try { const result=await authenticatedFetch((force:boolean)=>{assert.equal(force,false);return 'current'},'https://test.invalid/api/translate',{method:'POST',body:'original'},1000);assert.equal(result.status,503);assert.equal(calls,1) }
  finally {globalThis.fetch=prior}
})
test('zero and fully reserved balances block new translated messages, including cache reuse', async () => {
  for(const [balance,reserved] of [[0,0],[20,20],[10,11]]){
    let lookups=0
    const quota=new OutgoingCredit(()=> 'owner',async()=>snapshot(balance,reserved),async()=>{lookups++;return {state:'not_found'}})
    await assert.rejects(quota.check('owner',request,true),/字符已用完/);assert.equal(lookups,1)
  }
})
test('the exact paid request may finish after using the final characters, but another cached request may not', async () => {
  const quota=new OutgoingCredit(()=> 'owner',async()=>snapshot(0),async(id:string)=>({state:'completed',response:{requestId:request.requestId,sourceCharacters:2,translation:'Hello'}}))
  await quota.check('owner',request,true)
  await assert.rejects(quota.check('owner',{...request,requestId:'send-another'},true),/字符已用完/)
})
test('balance checks coalesce, invalidate after billing, and reject stale or malformed snapshots', async () => {
  let calls=0,balance:any=10,owner='owner'
  const quota=new OutgoingCredit(()=>owner,async()=>{calls++;return snapshot(balance)},async()=>({state:'not_found'}))
  await Promise.all([quota.check('owner',request,true),quota.check('owner',request,true)]);assert.equal(calls,1)
  balance=0;quota.invalidate();await assert.rejects(quota.check('owner',request,true),/字符已用完/);assert.equal(calls,2)
  balance='1000';quota.invalidate();await assert.rejects(quota.check('owner',request,true),/尚未核实/)
  owner='other';await assert.rejects(quota.check('owner',request,true),/登录状态/)
  const offline=new OutgoingCredit(()=> 'owner',async()=>{throw new Error('offline')},async()=>({state:'not_found'}))
  await assert.rejects(offline.check('owner',request,true),/offline/)
})
test('untranslated English and emoji do not invent a character charge', async () => {
  const quota=new OutgoingCredit(()=> 'owner',async()=>assert.fail('No translated text to authorize'),async()=>assert.fail())
  await quota.check('owner',{...request,text:'Thank you!'},true)
  await quota.check('owner',{...request,text:'👍'},true)
})
test('final dispatch refreshes the wallet even if a preparatory snapshot is still cached',async()=>{
 let balance=100,calls=0;const quota=new OutgoingCredit(()=> 'owner',async()=>{calls++;return snapshot(balance)},async()=>({state:'not_found'}));
 await quota.check('owner',request,true);balance=0;
 await assert.rejects(quota.check('owner',request,true,true),/字符已用完/);assert.equal(calls,2);
})
test('strict Chinese protection survives old disabled preferences and covers rare Han code points', async () => {
  assert.equal(hasBlockedChinese('Hello 𠀀','en-US'),true)
  for(const translate of [true,false]) {
    let data:any={tasks:[]},sent=0
    const tasks=new SendTasks({read:async()=>structuredClone(data),write:async(value:any)=>{data=value}})
    const task=await tasks.prepare('owner',{platform:'whatsapp',accountId:'a',conversationId:'c',translate,blockChinese:false,request})
    await tasks.translate('owner',task.id,async()=> '你好',()=>true)
    await assert.rejects(tasks.submit('owner',task.id,async()=>{sent++},()=>true),/仍包含中文/)
    assert.equal(sent,0);assert.equal((await tasks.get('owner',task.id)).state,'ready')
  }
})
test('50,000-character warning uses the absolute threshold, including zero',()=>{
  for(const value of [0,1,49999])assert.equal(lowCharacterBalance(value),true)
  for(const value of [50000,50001,1000000,undefined,null,NaN,-1,'1'])assert.equal(lowCharacterBalance(value),false)
})
test('early page loading blocks Send and Ctrl+Enter before WhatsApp can send raw Chinese',()=>{
  const dom=new JSDOM('<div id="main"><footer><div role="textbox" contenteditable="true">你好</div><button aria-label="Send">Send</button></footer></div>',{runScripts:'outside-only'})
  const win:any=dom.window;win.ready=false;win.blocked=0;win.__name=(value:any)=>value;let sent=0
  win.eval('('+installSendBootstrapGuard.toString()+')(()=>window.ready,()=>window.blocked++)')
  win.document.addEventListener('keydown',(event:any)=>{if(event.key==='Enter'&&!event.shiftKey)sent++})
  win.document.querySelector('button').addEventListener('click',()=>sent++)
  const editor=win.document.querySelector('[contenteditable]')
  editor.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))
  win.document.querySelector('button').click();assert.equal(sent,0);assert.equal(win.blocked,2)
  const ime=new win.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});editor.dispatchEvent(ime)
  assert.equal(ime.defaultPrevented,false);assert.equal(sent,0);assert.equal(editor.textContent,'你好')
  dom.window.close()
})
for(const modifiers of [{ctrlKey:true},{altKey:true},{metaKey:true},{ctrlKey:true,shiftKey:true}])test('WhatsApp modified Enter enters translation instead of native send '+JSON.stringify(modifiers),async()=>{
  const dom=new JSDOM('<div id="main"><header><span title="Alex">Alex</span></header><footer><div role="textbox" contenteditable="true">你好</div><button aria-label="Send">Send</button></footer></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'})
  const win:any=dom.window;let sent=0,prepared=0
  win.setInterval=()=>0
  win.document.addEventListener('keydown',(event:any)=>{if(event.key==='Enter')sent++})
  win.realtimeTranslator={prepareSend:async()=>{prepared++;throw new Error('Test stops before translation')},getRuntimeSettings:async()=>({receiveAutoTranslate:false}),reportConversation:()=>{},reportStatus:()=>{}}
  win.eval(whatsappInjectionScript)
  win.document.querySelector('[contenteditable]').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...modifiers}))
  await new Promise(resolve=>setImmediate(resolve));assert.equal(prepared,1);assert.equal(sent,0);dom.window.close()
})
test('temporary upstream auth outages are 503, not a fabricated expired-login error',async()=>{
  const prior=globalThis.fetch
  const env={API_RATE_LIMITER:{limit:async()=>({success:true})},SUPABASE_URL:'https://auth.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture'} as unknown as Env
  try {
    for(const status of [429,500,503]){globalThis.fetch=async()=>new Response('{}',{status});const response=await worker.fetch(new Request('https://api.invalid/api/me',{headers:{Authorization:'Bearer fixture'}}),env);assert.equal(response.status,503);assert.equal((await response.json() as any).error,'auth_unavailable')}
    globalThis.fetch=async()=>{throw new TypeError('offline')};assert.equal((await worker.fetch(new Request('https://api.invalid/api/me',{headers:{Authorization:'Bearer fixture'}}),env)).status,503)
  } finally {globalThis.fetch=prior}
})

test('Chinese media captions and edits cannot send through an auxiliary dialog or borrow the normal draft',async()=>{
  const dom=new JSDOM('<div id="main"><header><span title="Alex">Alex</span></header><footer><div contenteditable="true" role="textbox">next draft</div></footer></div><div role="dialog"><div contenteditable="true" role="textbox">未翻译的图片说明</div><button aria-label="Send"><span data-icon="send"></span></button></div>',{url:'https://web.whatsapp.com',runScripts:'outside-only'})
  const win:any=dom.window;let sent=0,prepared=0;win.setInterval=()=>0;
  win.realtimeTranslator={prepareSend:async()=>{prepared++},getRuntimeSettings:async()=>({receiveAutoTranslate:false}),reportConversation(){},reportStatus(){}};
  win.eval(whatsappInjectionScript);const dialog=win.document.querySelector('[role="dialog"]'),button=dialog.querySelector('button');button.addEventListener('click',()=>sent++);
  button.click();dialog.querySelector('[contenteditable]').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(sent,0);assert.equal(prepared,0);assert.equal(win.document.querySelector('footer [contenteditable]').textContent,'next draft');
  dialog.querySelector('[contenteditable]').textContent='';button.click();assert.equal(sent,1);dom.window.close();
})
