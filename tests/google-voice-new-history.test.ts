import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mainHarness } from './main-harness.ts'

const h = mainHarness()
const { GoogleVoiceIncomingHistory, googleVoiceMessageTime, isVerifiedGoogleVoiceIncoming } = h.load('src/main/platforms/googleVoice/incomingHistory.ts') as typeof import('../src/main/platforms/googleVoice/incomingHistory.ts')
const { createGoogleVoiceTranslator } = h.load('src/main/platforms/googleVoice/translationBridge.ts') as typeof import('../src/main/platforms/googleVoice/translationBridge.ts')
const anchor = '00000000-0000-5000-a000-000000000001'
const stamp = (minute: number) => `Message from Synthetic sender, , Sunday, September 20 2026, 12:${String(minute).padStart(2, '0')} PM.`
const at = (minute: number) => new Date(2026, 8, 20, 12, minute).getTime()
function message(timestamp = stamp(2), text = 'New received message') {
  const signature = ['gv_fixture', 'incoming', timestamp, text]
  const hash = createHash('sha256').update(JSON.stringify(signature)).digest('hex')
  return { direction: 'incoming', conversationId: 'gv_fixture', text, id: `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}` }
}
function fixture() {
  let now = at(1) + 30000, valid = true
  const history = new GoogleVoiceIncomingHistory(() => now), page = { authorized: () => valid }
  const baseline = history.begin('owner/window', 'gv_fixture', [anchor], page)
  const proof = { token: baseline.token, anchorId: anchor, messageDirection: 'incoming', timestamp: stamp(2) }
  now = at(2) + 1000
  return { history, page, baseline, proof, setNow: (value: number) => { now = value }, invalidate: () => { valid = false } }
}

test('only complete verified local English dates with valid calendar and weekday can prove newness', () => {
  assert.equal(googleVoiceMessageTime(stamp(2)), at(2))
  for (const value of ['today 12:02 PM', '20/09/26 12:02', stamp(2).replace('Sunday', 'Monday'), stamp(2).replace('20 2026', '31 2026'), stamp(2).replace('12:02', '13:02'), stamp(2).replace('2026', '26'), stamp(2).replace('September', '九月'), stamp(2) + ' injected']) assert.equal(googleVoiceMessageTime(value), undefined)
})

test('baseline rejects empty, sparse, forged and oversized IDs before issuing a capability', () => {
  const h = fixture()
  for (const ids of [[], new Array(1), [undefined], ['not-an-id'], Array(501).fill(anchor)]) assert.throws(() => h.history.begin('other', 'gv_fixture', ids, h.page))
})

test('new incoming identity is admitted once; initial IDs, forged flags and JSON copies have no capability', () => {
  const h = fixture(), payload = message()
  assert.equal(isVerifiedGoogleVoiceIncoming({ ...payload, new: true, newMessage: h.proof }), false)
  h.history.attest('owner/window', payload, h.proof, h.page)
  assert.equal(isVerifiedGoogleVoiceIncoming(payload), true)
  assert.equal(isVerifiedGoogleVoiceIncoming(JSON.parse(JSON.stringify(payload))), false)
  const replay = message(); h.history.attest('owner/window', replay, h.proof, h.page)
  assert.equal(isVerifiedGoogleVoiceIncoming(replay), false)
  const initial = { ...message(), id: anchor }; h.history.attest('owner/window', initial, h.proof, h.page)
  assert.equal(isVerifiedGoogleVoiceIncoming(initial), false)
})

test('historical pagination, same-minute boundary, future dates and changed source identities cannot bill', () => {
  for (const timestamp of [stamp(0), stamp(1), stamp(3)]) {
    const h = fixture(), payload = message(timestamp)
    h.history.attest('owner/window', payload, { ...h.proof, timestamp }, h.page)
    assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  }
  for (const change of [{ text: 'changed' }, { id: anchor }, { conversationId: 'another' }]) {
    const h = fixture(), payload = { ...message(), ...change }
    h.history.attest('owner/window', payload, h.proof, h.page)
    assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  }
  const h = fixture(), payload = message()
  h.history.attest('owner/window', payload, { ...h.proof, messageDirection: 'outgoing' }, h.page)
  assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
})

test('cross owner/window/conversation/token/anchor and detached current page are rejected', () => {
  for (const scope of ['other/window', 'owner/other']) {
    const h = fixture(), payload = message(); h.history.attest(scope, payload, h.proof, h.page)
    assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  }
  for (const change of [{ token: 'forged' }, { anchorId: undefined }, { anchorId: 'forged' }]) {
    const h = fixture(), payload = message(); h.history.attest('owner/window', payload, { ...h.proof, ...change }, h.page)
    assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  }
  const h = fixture(), payload = message(); h.history.attest('owner/window', payload, h.proof, { authorized: () => false })
  assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
})

test('navigation/reload/popup lifecycle invalidates baseline even when a replacement has the same URL', () => {
  const h = fixture(), payload = message()
  h.history.attest('owner/window', payload, h.proof, h.page); assert.equal(isVerifiedGoogleVoiceIncoming(payload), true)
  h.invalidate(); assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  const sameUrlNewDocument = { authorized: () => true }, next = message()
  h.history.attest('owner/window', next, h.proof, sameUrlNewDocument)
  assert.equal(isVerifiedGoogleVoiceIncoming(next), false)
})

test('exact expiry or replacement baseline invalidates old capabilities; new baseline never replays old work', () => {
  const h = fixture(), payload = message()
  h.history.attest('owner/window', payload, h.proof, h.page)
  h.setNow(h.baseline.expiresAt); assert.equal(isVerifiedGoogleVoiceIncoming(payload), false)
  const next = message(); h.history.attest('owner/window', next, h.proof, h.page); assert.equal(isVerifiedGoogleVoiceIncoming(next), false)
  const replacement = h.history.begin('owner/window', 'gv_fixture', [payload.id], h.page)
  assert.notEqual(replacement.token, h.baseline.token)
  h.history.attest('owner/window', next, { ...h.proof, token: replacement.token, anchorId: next.id }, h.page)
  assert.equal(isVerifiedGoogleVoiceIncoming(next), false)
})

test('translation rechecks capability after async cache and never changes durable request IDs', async () => {
  let calls = 0, cachedHook = () => {}, mode = 'new'
  const requests: any[] = []
  const translator = { preserveIncomingRequest: async (value: any) => { requests.push(value); return value }, cached: async () => { cachedHook(); return undefined }, translateIncoming: async () => { calls++; return '收到' } } as any
  const run = createGoogleVoiceTranslator(translator, {} as any, async () => ({ historyMode: mode, receiveAutoTranslate: true, translationsVisible: true, localLanguage: 'zh-CN', targetLanguage: 'en-US' }) as any, {} as any)
  const h = fixture(), payload = message(); h.history.attest('owner/window', payload, h.proof, h.page)
  await run('owner', 'window', 'translate', payload, () => true); assert.equal(calls, 1)
  const id = requests[0].requestId
  const expired = fixture(), stale = message(); expired.history.attest('owner/window', stale, expired.proof, expired.page)
  cachedHook = () => expired.setNow(expired.baseline.expiresAt)
  await run('owner', 'window', 'translate', stale, () => true); assert.equal(calls, 1)
  assert.equal(requests[1].requestId, id)
  mode = 'manual'; cachedHook = () => {}
  await run('owner', 'window', 'translate', payload, () => true); assert.equal(calls, 1)
  await run('owner', 'window', 'translate', { ...payload, manual: true }, () => true); assert.equal(calls, 2)
  assert.ok(requests.every(request => request.requestId === id))
})
