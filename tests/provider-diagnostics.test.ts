import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { type Env } from '../server/worker/src/index.ts'
import { classifyProviderFailure, checkProviderReadiness } from '../server/worker/src/providerDiagnostics.ts'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const env = (): Env => ({ SUPABASE_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-service', OPENAI_API_KEY: 'test-secret-never-returned', OPENAI_MODEL: 'test-model' })

test('provider failures distinguish authentication, billing quota, rate limits, model access and parameters without echoing payloads', () => {
  for (const [status, code, expected] of [[401, 'invalid_api_key', 'provider_auth'], [429, 'insufficient_quota', 'provider_quota'], [429, 'rate_limit_exceeded', 'provider_rate_limit'], [404, 'model_not_found', 'provider_model'], [403, '', 'provider_permission'], [400, 'unsupported_value', 'provider_request'], [503, '', 'provider_unavailable']] as const) {
    const error = classifyProviderFailure(status, { error: { code, message: 'test-secret-never-returned source text must not escape' } })
    assert.equal(error.code, expected)
    assert.ok(!error.message.includes('test-secret'))
    assert.ok(!JSON.stringify(error).includes('source text'))
  }
})

test('readiness only retrieves model metadata, coalesces calls and never starts paid inference', async () => {
  const settings = env()
  let requests = 0
  globalThis.fetch = async (url, init) => {
    requests++
    assert.equal(String(url), 'https://api.openai.com/v1/models/test-model')
    assert.ok(!init?.method || init.method === 'GET')
    assert.equal(init?.body, undefined)
    return new Response(JSON.stringify({ id: 'test-model' }))
  }
  const [first, second] = await Promise.all([checkProviderReadiness(settings), checkProviderReadiness(settings)])
  assert.deepEqual(first, second); assert.equal(requests, 1)
  assert.equal(first.status, 'available'); assert.equal(first.inferenceTested, false)
  assert.ok(!JSON.stringify(first).includes(settings.OPENAI_API_KEY))
})

test('model-read permission failure stays unverified instead of incorrectly declaring inference unavailable', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'restricted permission' } }), { status: 403 })
  const result = await checkProviderReadiness(env())
  assert.equal(result.status, 'unverified'); assert.equal(result.code, 'provider_permission')
})

test('public readiness detects missing or invalid credentials but returns no credential content', async () => {
  const settings = env()
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: settings.OPENAI_API_KEY } }), { status: 401 })
  const response = await worker.fetch(new Request('https://worker.invalid/health/translation'), settings)
  const body = await response.json()
  assert.equal(body.provider.code, 'provider_auth'); assert.equal(body.provider.status, 'attention')
  assert.equal(body.provider.inferenceTested, false)
  assert.ok(!JSON.stringify(body).includes(settings.OPENAI_API_KEY))
  globalThis.fetch = async () => { assert.fail('missing key must not call upstream') }
  assert.equal((await checkProviderReadiness({ ...env(), OPENAI_API_KEY: '' })).code, 'provider_auth')
})
