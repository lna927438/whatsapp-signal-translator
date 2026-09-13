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
      ready = response.ok && health.ok === true && health.release === 'hellodog-notices-0.5.7'
        && ['translationQuality', 'translationStatus', 'accountSnapshot', 'adminUsers', 'providerUsage', 'clientNotices'].every(name => health.features?.[name] === true)
      if (ready) break
    } catch { /* Allow the deployment time to reach both hostnames. */ }
    await delay(5000)
  }
  assert.ok(ready, `${origin} did not serve the expected gateway release`)
  const readiness = await fetch(`${origin}/health/translation`, { signal: AbortSignal.timeout(12000) })
  assert.equal(readiness.status, 200)
  const diagnostic = await readiness.json()
  assert.equal(diagnostic.release, 'hellodog-deepseek-v1')
  assert.equal(diagnostic.provider.inferenceTested, false)
  assert.ok(['available', 'attention', 'unverified'].includes(diagnostic.provider.status))
  console.log(`${origin}: PROVIDER_READINESS ${JSON.stringify(diagnostic.provider)}`)
  const wallet = await fetch(`${origin}/api/wallet`, { signal: AbortSignal.timeout(10000) })
  assert.equal(wallet.status, 401, `${origin} must reject an unauthenticated wallet read`)
  for (const section of ['session', 'overview', 'users', 'announcements']) {
    const admin = await fetch(`${origin}/api/admin/${section}`, {
      headers: { Origin: 'https://admin.hellodog.net' }, signal: AbortSignal.timeout(10000)
    })
    assert.equal(admin.status, 401, `${origin} must protect admin ${section}`)
    assert.ok(['*', 'https://admin.hellodog.net'].includes(admin.headers.get('access-control-allow-origin')), 'Admin CORS must allow the official management website')
  }
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

// A healthy translation endpoint alone cannot detect a website overwritten by an old build.
for (const origin of ['https://hellodog.net', 'https://admin.hellodog.net']) {
  const response = await fetch(`${origin}/admin/overview`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') || '', /no-store/, 'Admin HTML must not retain an obsolete release')
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/)
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
  assert.ok(scriptPath?.startsWith('/assets/'), 'Admin shell must reference its app bundle')
  const script = await fetch(new URL(scriptPath, origin), { signal: AbortSignal.timeout(10000) })
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type') || '', /javascript/)
  const code = await script.text()
  const adminChunk = code.match(/AdminView-[\w-]+\.js/)?.[0]
  assert.ok(adminChunk, 'Published app must include the admin view, not the early public-only website')
  const chunk = await fetch(new URL('/assets/' + adminChunk, origin), { signal: AbortSignal.timeout(10000) })
  assert.equal(chunk.status, 200)
  assert.match(chunk.headers.get('content-type') || '', /javascript/)
  assert.match(await chunk.text(), /登录管理后台/)
  console.log(`${origin}: admin route, private headers and admin bundle passed`)
}
