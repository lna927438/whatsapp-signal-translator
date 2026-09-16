import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SessionRefresh, authenticatedFetch } = require('../src/main/network/sessionRefresh.ts') as typeof import('../src/main/network/sessionRefresh')
const { requiresSessionLogin, boundedAuthWork } = require('../src/renderer/src/lib/sessionRecovery.ts') as typeof import('../src/renderer/src/lib/sessionRecovery')
const token = (label: string) => 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, label })).toString('base64url') + '.fixture'

test('an unexpired server-revoked session stops retrying until a new login supplies a new token', async () => {
  let identity = { userId: 'owner', accessToken: token('revoked') }, prompts: any[] = []
  const gate = new SessionRefresh(() => identity, value => prompts.push(value))
  const rejected = gate.token('owner', true, identity.accessToken)
  assert.equal(prompts[0].reason, 'rejected')
  const fails = assert.rejects(rejected, /登录会话已失效/)
  gate.complete(prompts[0].id, false, true)
  await fails
  for (let i = 0; i < 5; i++) await assert.rejects(gate.token('owner'), /登录会话已失效/)
  assert.equal(prompts.length, 1)
  identity = { ...identity, accessToken: token('new-login') }; gate.changed()
  assert.equal(await gate.token('owner'), identity.accessToken)
  assert.equal(prompts.length, 1)
})

test('temporary refresh errors do not blacklist a still-valid session or another account', async () => {
  let identity = { userId: 'owner', accessToken: token('original') }, prompt: any
  const gate = new SessionRefresh(() => identity, value => { prompt = value })
  const attempt = gate.token('owner', true, identity.accessToken)
  const fails = assert.rejects(attempt, /暂时无法恢复/)
  gate.complete(prompt.id, false); await fails
  assert.equal(await gate.token('owner'), identity.accessToken)
  const old = gate.token('owner', true, identity.accessToken), oldId = prompt.id
  const changed = assert.rejects(old, /登录/)
  identity = { userId: 'new-owner', accessToken: token('new-owner') }; gate.changed()
  gate.complete(oldId, false, true); await changed
  assert.equal(await gate.token('new-owner'), identity.accessToken)
})

test('late permanent rejection cannot poison a concurrently replaced token', async () => {
  let identity = { userId: 'owner', accessToken: token('old') }, prompt: any
  const gate = new SessionRefresh(() => identity, value => { prompt = value })
  const attempt = gate.token('owner', true, identity.accessToken), failure = assert.rejects(attempt, /登录/)
  identity = { ...identity, accessToken: token('new') }; gate.changed()
  gate.complete(prompt.id, false, true); await failure
  assert.equal(await gate.token('owner'), identity.accessToken)
})

test('login preparation does not consume the entire API request deadline', async () => {
  const original = globalThis.fetch, bodies: unknown[] = []
  globalThis.fetch = async (_input, init) => { assert.equal(init?.signal?.aborted, false); bodies.push(init?.body); return new Response('{}', { status: bodies.length === 1 ? 401 : 200 }) }
  try {
    const result = await authenticatedFetch(async force => {
      await new Promise(resolve => setTimeout(resolve, 25)); return force ? 'new' : 'old'
    }, 'https://fixture.invalid/api/translate', { method: 'POST', body: 'unchanged-request-and-id' }, 10)
    assert.equal(result.status, 200); assert.deepEqual(bodies, ['unchanged-request-and-id', 'unchanged-request-and-id'])
  } finally { globalThis.fetch = original }
})

test('only explicit revoked/expired credential codes require login', () => {
  for (const code of ['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found']) assert.equal(requiresSessionLogin({ code }), true)
  for (const error of [{ status: 500 }, { status: 429 }, { code: 'unexpected_failure' }, new TypeError('Failed to fetch'), new Error('offline'), null]) assert.equal(requiresSessionLogin(error), false)
})

test('bounded auth timeout leaves later recovery usable and consumes late rejections', async () => {
  let reject!: (error: Error) => void
  await assert.rejects(boundedAuthWork(new Promise((_resolve, fail) => { reject = fail }), 5), /登录服务/)
  reject(new Error('late transport failure'))
  assert.equal(await boundedAuthWork(Promise.resolve('recovered'), 5), 'recovered')
})
