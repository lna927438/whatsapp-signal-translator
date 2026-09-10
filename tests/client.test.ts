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
