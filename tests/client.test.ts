import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { CloudflareProvider } = createRequire(import.meta.url)('../src/main/translation/providers/cloudflare.ts') as typeof import('../src/main/translation/providers/cloudflare.ts')

const originalFetch=globalThis.fetch
afterEach(()=>{ globalThis.fetch=originalFetch })
const req={ text:'hello',targetLanguage:'zh-CN',messageId:'message-123',accountId:'account-a',conversationId:'chat-a' }

test('transport and pending retries reuse exactly the same header, body and request ID', async()=>{
  const calls: Array<{ id:string|null; body:string }>=[]
  globalThis.fetch=async(_url,init)=>{
    calls.push({ id:new Headers(init?.headers).get('x-request-id'),body:String(init?.body) })
    if(calls.length===1) throw new TypeError('simulated transport failure')
    if(calls.length===2) return new Response(JSON.stringify({ error:'translation_processing' }),{ status:202 })
    return new Response(JSON.stringify({ translation:'你好' }))
  }
  const p=new CloudflareProvider('test-user','https://worker.invalid')
  assert.equal(await p.translate(req),'你好')
  assert.equal(calls.length,3)
  assert.deepEqual(calls[0],calls[1]); assert.deepEqual(calls[1],calls[2])
  assert.equal(calls[0].id,JSON.parse(calls[0].body).requestId)
})

test('message retries retain identity across provider instances while distinct messages remain distinct', async()=>{
  const ids:string[]=[]
  globalThis.fetch=async(_url,init)=>{ ids.push(JSON.parse(String(init?.body)).requestId); return new Response(JSON.stringify({ translation:'你好' })) }
  await new CloudflareProvider('first-token').translate(req)
  await new CloudflareProvider('refreshed-token').translate(req)
  await new CloudflareProvider('refreshed-token').translate({ ...req,messageId:'different-message' })
  assert.equal(ids[0],ids[1]); assert.notEqual(ids[1],ids[2])
})

test('account suspension is not retried', async()=>{
  let count=0
  globalThis.fetch=async()=>{ count++; return new Response(JSON.stringify({ error:'account_disabled' }),{ status:403 }) }
  await assert.rejects(new CloudflareProvider('test-user').translate(req),/账号已停用/)
  assert.equal(count,1)
})

test('an in-flight transport retry uses a rotated session token without changing the translation request', async () => {
  let token = 'initial-test-token'
  const calls: Array<{ token: string | null; body: string }> = []
  globalThis.fetch = async (_url, init) => {
    calls.push({ token: new Headers(init?.headers).get('authorization'), body: String(init?.body) })
    if (calls.length === 1) { token = 'rotated-test-token'; throw new TypeError('lost response') }
    return new Response(JSON.stringify({ translation: '你好' }))
  }
  await new CloudflareProvider(() => token).translate(req)
  assert.notEqual(calls[0].token, calls[1].token)
  assert.equal(calls[0].body, calls[1].body)
})

test('a user change between provider retries prevents any request under the next user token', async () => {
  let changed = false, calls = 0
  globalThis.fetch = async () => { calls++; changed = true; throw new TypeError('lost response') }
  await assert.rejects(new CloudflareProvider(() => {
    if (changed) throw new Error('登录状态已变化')
    return 'initial-test-token'
  }).translate(req), /登录状态已变化/)
  assert.equal(calls, 1)
})
