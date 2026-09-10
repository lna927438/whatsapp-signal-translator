import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const origins = ['https://api.hellodog.net', 'https://realtime-translator-api.lna927438.workers.dev']
for (const origin of origins) {
  let ready = false
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const response = await fetch(`${origin}/health?release-check=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000)
      })
      const health = await response.json()
      ready = response.ok && health.ok === true && health.release === 'translation-coordination-v1'
      if (ready) break
    } catch { /* Allow the deployment time to reach both hostnames. */ }
    await delay(5000)
  }
  assert.ok(ready, `${origin} did not serve the expected gateway release`)
  const wallet = await fetch(`${origin}/api/wallet`, { signal: AbortSignal.timeout(10000) })
  assert.equal(wallet.status, 401, `${origin} must reject an unauthenticated wallet read`)
  const translation = await fetch(`${origin}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'unauthenticated-smoke-check', text: 'test', targetLanguage: 'zh-CN' }),
    signal: AbortSignal.timeout(10000)
  })
  assert.equal(translation.status, 401, `${origin} must reject an unauthenticated translation before inference`)
  const preflight = await fetch(`${origin}/api/translate`, {
    method: 'OPTIONS', signal: AbortSignal.timeout(10000)
  })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /x-request-id/i)
  console.log(`${origin}: release marker, unauthorized wallet/translation rejection and CORS passed`)
}
