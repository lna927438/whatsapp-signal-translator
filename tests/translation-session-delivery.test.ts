import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

test('a late provider response after account change preserves the debit but never delivers to the next account', async () => {
  const h = mainHarness()
  try {
    const { TranslationEngine } = h.load('src/main/translation/translationEngine.ts'), engine = new TranslationEngine()
    engine.setOnlineSession('owner-a', 'fixture-a')
    engine.settings.get = async () => ({ provider: 'openai' })
    let ready!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const provider = new Promise<void>(resolve => { finish = resolve })
    engine.createProvider = () => ({ translate: async (request: any) => {
      ready(); await provider
      await engine.receipts.update('owner-a', request.requestId, { state: 'charged', translated: 'Your package will arrive tomorrow.', chargedCharacters: 9, balanceAfter: 100 })
      return 'Your package will arrive tomorrow.'
    } })
    const request = { requestId: 'send-owner-a', text: '你的包裹明天送到。', targetLanguage: 'en-US', accountId: 'wa-a', conversationId: 'peer-a' }
    const result = engine.translate(request)
    const rejected = assert.rejects(result, /登录状态已变化/)
    await started
    engine.setOnlineSession('owner-b', 'fixture-b'); finish()
    await rejected
    assert.equal((await engine.receipts.get('owner-a', request.requestId)).state, 'charged')
    assert.equal((await engine.receipts.list('owner-b')).length, 0)
    assert.equal(engine.metrics().activeRequests, 0)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})
