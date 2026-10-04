import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

const source = '我父亲当时二十六岁。他已经参与家族事业。我现在仍然叫他叔叔。'
const modelText = 'My father was twenty-six then.\n\nHe was already involved in the family business.\n\nI still call him my uncle.'
const sentText = 'My father was twenty-six then. He was already involved in the family business. I still call him my uncle.'

function fixture() {
  const h = mainHarness(), { TranslationEngine } = h.load('src/main/translation/translationEngine.ts')
  let calls = 0
  const create = () => {
    const engine = new TranslationEngine()
    engine.setOnlineSession('owner', 'fixture')
    engine.settings.get = async () => ({ provider: 'openai' })
    engine.createProvider = () => ({ translate: async (request: any) => {
      calls++
      await engine.receipts.update('owner', request.requestId, {
        state: 'charged', translated: modelText, chargedCharacters: Array.from(request.text).length, balanceAfter: 700
      })
      return modelText
    } })
    return engine
  }
  const request = (platform: string, providerPreference: string) => ({
    text: source, accountId: platform, conversationId: platform + ':peer', messageId: platform + '-message',
    requestId: 'send-' + platform, cacheUserId: 'owner', sourceLanguage: 'zh-CN', targetLanguage: 'en-US', providerPreference
  })
  return { ...h, create, request, get calls() { return calls }, close: () => rmSync(h.directory, { recursive: true, force: true }) }
}

test('all outgoing channels deliver one paragraph for a single-paragraph source, including paid receipts reused after restart', async () => {
  const f = fixture()
  try {
    for (const provider of ['openai', 'deepseek']) for (const platform of ['whatsapp', 'signal', 'google-voice']) {
      const engine = f.create(), request = f.request(platform + '-' + provider, provider)
      assert.equal(await engine.translate(request), sentText)
      const restarted = f.create()
      assert.equal(await restarted.translate(request), sentText)
      assert.equal(await restarted.cached(request), sentText)
      const receipt = await restarted.receipts.get('owner', request.requestId)
      assert.equal(receipt.translated, modelText)
      assert.equal(receipt.state, 'charged')
      assert.equal(receipt.chargedCharacters, Array.from(source).length)
      assert.equal(receipt.balanceAfter, 700)
      assert.equal((await restarted.existingOutgoing(request.requestId, request.accountId, request.conversationId, source, sentText)).requestId, request.requestId)
      // Old preview copies remain tied to their exact receipt. Arbitrary edits
      // cannot impersonate a verified translation just by containing newlines.
      assert.equal((await restarted.existingOutgoing(request.requestId, request.accountId, request.conversationId, source, modelText)).requestId, request.requestId)
      await assert.rejects(restarted.existingOutgoing(request.requestId, request.accountId, request.conversationId, source, sentText + ' Invented content.'), /尚未核实/)
    }
    assert.equal(f.calls, 6)
  } finally { f.close() }
})

test('legacy cache-only sends and native Signal receipt recovery normalize without another paid call', async () => {
  const f = fixture()
  try {
    const engine = f.create(), request = f.request('signal', 'openai')
    await engine.cache.set('openai', request, modelText)
    assert.equal(await engine.cached(request), sentText)
    assert.equal(await engine.translate(request), sentText)
    assert.equal((await engine.restoreSignalOutgoing(request.requestId, request.accountId, request.conversationId, request.messageId, source)).text, sentText)
    assert.equal(f.calls, 0)
    const receipt = await engine.receipts.get('owner', request.requestId)
    assert.equal(receipt.state, 'cached')
    assert.equal(receipt.translated, modelText)
    assert.equal(receipt.chargedCharacters, 0)
  } finally { f.close() }
})

test('author-written paragraphs, incoming translation and manual corrections retain their intended layout', async () => {
  const f = fixture()
  try {
    const engine = f.create(), request = f.request('wa-multiline', 'deepseek')
    assert.equal(await engine.translate({ ...request, text: '第一段。\n\n第二段。' }), modelText)
    const incoming = { ...f.request('incoming', 'openai'), requestId: 'incoming-fixture' }
    assert.equal(await engine.translateIncoming(incoming, true), modelText)
    const outgoing = f.request('manual-correction', 'deepseek')
    assert.equal(await engine.translate(outgoing), sentText)
    await engine.correct(outgoing.requestId, modelText)
    assert.equal(await engine.cached(outgoing), modelText)
    assert.equal(await engine.translate(outgoing), modelText)
    await assert.rejects(engine.existingOutgoing(outgoing.requestId, outgoing.accountId, outgoing.conversationId, source, sentText), /尚未核实/)
    await engine.receipts.update('owner', outgoing.requestId, { correctionSource: undefined })
    assert.equal(await engine.translate(outgoing), modelText)
  } finally { f.close() }
})

test('normalizing a paid send cannot damage a multiline glossary value or make the result unsendable', async () => {
  const f = fixture()
  try {
    const engine = f.create(), literal = 'First [name]\nSecond (name)'
    const request = { ...f.request('glossary', 'openai'), text: '请联系联系人。稍后见。', quality: { glossary: [{ source: '联系人', target: literal }] } }
    const raw = 'Contact ' + literal + '.\n\nSee you later.'
    await engine.receipts.prepare('owner', 'openai', request)
    await engine.receipts.update('owner', request.requestId, { state: 'charged', translated: raw, chargedCharacters: Array.from(request.text).length, balanceAfter: 700 })
    const value = await engine.translate(request)
    assert.equal(value, 'Contact ' + literal + '. See you later.')
    assert.equal(f.load('src/main/translation/translationValidation.ts').validateTranslation(request, value), value)
    assert.equal(await f.create().translate(request), value)
    assert.equal(f.calls, 0)
  } finally { f.close() }
})

test('legacy paid results and manual corrections containing Chinese cannot leave the translation engine for a foreign target', async () => {
  const f = fixture()
  try {
    const engine = f.create(), request = f.request('legacy-chinese', 'openai')
    await engine.receipts.prepare('owner', 'openai', request)
    await engine.receipts.update('owner', request.requestId, { state: 'charged', translated: 'Your package is ready. 请查收', chargedCharacters: Array.from(source).length, balanceAfter: 700 })
    await assert.rejects(engine.translate(request), /仍含中文/)
    await assert.rejects(engine.cached(request), /仍含中文/)
    assert.equal((await engine.receipts.get('owner', request.requestId)).state, 'charged')
    await engine.correct(request.requestId, 'Please confirm. 谢谢')
    await assert.rejects(engine.translate(request), /仍含中文/)
    assert.equal(f.calls, 0)
  } finally { f.close() }
})
