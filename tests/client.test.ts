import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { CloudflareProvider } = createRequire(import.meta.url)('../src/main/translation/providers/cloudflare.ts') as typeof import('../src/main/translation/providers/cloudflare.ts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const req = { text: 'hello', targetLanguage: 'zh-CN', messageId: 'message-123', accountId: 'account-a', conversationId: 'chat-a' }
const receipt = (id:string) => ({ requestId:id, translation:'你好', sourceCharacters:5, balanceAfter:95 })

test('a lost POST and a pending result only query the original request; no automatic translation POST is repeated', async () => {
  const calls:Array<{url:string;method:string;body:unknown;id:string|null}>=[]
  let id=''
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),method:init?.method||'GET',body:init?.body,id:new Headers(init?.headers).get('x-request-id')})
    if(calls.length===1) { id=JSON.parse(String(init?.body)).requestId; throw new TypeError('lost response') }
    return Response.json(calls.length===2 ? {state:'processing'} : {state:'completed',response:receipt(id)})
  }
  const settled:any[]=[]
  assert.equal(await new CloudflareProvider('test','https://worker.invalid',async r=>{settled.push(r)}).translate(req),'你好')
  assert.deepEqual(calls.map(c=>c.method),['POST','GET','GET'])
  assert.equal(calls[0].id,id)
  for(const call of calls.slice(1)) { assert.equal(new URL(call.url).searchParams.get('requestId'),id);assert.equal(call.body,undefined) }
  assert.deepEqual(settled,[receipt(id)])
})

test('provider instances retain a message identity while identical text on another message is a distinct operation', async () => {
  const ids:string[]=[]
  globalThis.fetch=async(_url,init)=>{ const id=JSON.parse(String(init?.body)).requestId;ids.push(id);return Response.json(receipt(id)) }
  await new CloudflareProvider('first').translate(req)
  await new CloudflareProvider('refreshed').translate(req)
  await new CloudflareProvider('refreshed').translate({...req,messageId:'different-message'})
  assert.equal(ids[0],ids[1]);assert.notEqual(ids[1],ids[2])
})

test('account suspension never retries and retains any earlier billing uncertainty', async () => {
  let count=0
  globalThis.fetch=async()=>{ count++;return Response.json({error:'account_disabled'},{status:403}) }
  await assert.rejects(new CloudflareProvider('test').translate(req),/账号已停用/)
  assert.equal(count,1)
})

test('reconciliation uses a refreshed token and retains the original request identity', async () => {
  let token='initial',id=''
  const tokens:string[]=[]
  globalThis.fetch=async(url,init)=>{
    tokens.push(new Headers(init?.headers).get('authorization')!)
    if(tokens.length===1){ id=JSON.parse(String(init?.body)).requestId;token='rotated';throw new TypeError('lost response') }
    assert.equal(new URL(String(url)).searchParams.get('requestId'),id)
    return Response.json({state:'completed',response:receipt(id)})
  }
  await new CloudflareProvider(()=>token).translate(req)
  assert.deepEqual(tokens,['Bearer initial','Bearer rotated'])
})

test('changing users during recovery never sends a request with the next user token', async () => {
  let changed=false,calls=0
  globalThis.fetch=async()=>{ calls++;changed=true;throw new TypeError('lost response') }
  await assert.rejects(new CloudflareProvider(()=>{if(changed)throw new Error('登录状态已变化');return 'initial'}).translate(req),/登录状态已变化/)
  assert.equal(calls,1)
})

test('missing or mismatched settlement metadata is never accepted as a paid success', async () => {
  for(const change of [{balanceAfter:null},{requestId:'another'},{sourceCharacters:99}]) {
    globalThis.fetch=async(_url,init)=>Response.json({...receipt(JSON.parse(String(init?.body)).requestId),...change})
    await assert.rejects(new CloudflareProvider('test').translate(req),/回执不完整/)
  }
})

test('an old server without status queries preserves uncertainty without issuing another POST', async () => {
  const methods:string[]=[]
  globalThis.fetch=async(_url,init)=>{ methods.push(init?.method||'GET');if(methods.length===1)throw new TypeError('lost response');return Response.json({error:'not_found'},{status:404}) }
  await assert.rejects(new CloudflareProvider('test').translate(req),/尚未提供结果查询/)
  assert.deepEqual(methods,['POST','GET'])
})
