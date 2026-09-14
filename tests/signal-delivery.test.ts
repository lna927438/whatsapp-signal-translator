import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'

test('Signal hidden-number aliases share archive, mute, unread and read-receipt preferences', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts')
    const adapter = new SignalAdapter({ cached: async () => undefined, history: async () => [] })
    const account = '+12025550100', number = '+12025550123', uuid = '10000000-0000-4000-8000-000000000001'
    const events: any[] = [], requests: any[] = []
    adapter.setOnlineUser('owner'); adapter.start = async () => {}
    adapter.attachMainWindow({ webContents: { send: (channel: string, value: any) => events.push({ channel, value }) } })
    adapter.accounts.list = async () => [{ id: 'a', platform: 'signal', signalAccount: account }]
    adapter.accounts.updateContactLanguage = async () => {}
    adapter.settings.runtime = async () => ({ localLanguage: 'en-US', receiveAutoTranslate: false })
    adapter.cli.call = async (method: string, params: any) => { requests.push({ method, params }); return method === 'listContacts' ? [{ number, uuid, name: 'Alex', isArchived: true }] : [] }
    await adapter.listContacts(account)
    await adapter.preferences.save('owner', account, { readReceipts: true })
    await adapter.preferences.conversation('owner', account, number, { mutedUntil: Number.MAX_SAFE_INTEGER })
    await adapter.onReceive({ account, envelope: { sourceUuid: uuid, dataMessage: { timestamp: 42, message: 'hello' } } })
    let prefs = await adapter.preferences.get('owner', account)
    assert.equal(prefs.conversations[number].archived, false)
    assert.equal(prefs.conversations[number].mutedUntil, Number.MAX_SAFE_INTEGER)
    assert.equal(events.filter(event => event.channel === 'accounts:unread').at(-1).value.count, 1)
    await adapter.markRead(account, uuid)
    prefs = await adapter.preferences.get('owner', account)
    assert.equal(prefs.conversations[number].lastReadAt, 42); assert.equal(prefs.conversations[uuid], undefined)
    assert.equal(events.filter(event => event.channel === 'accounts:unread').at(-1).value.count, 0)
    await new Promise(resolve => setImmediate(resolve))
    const receipt = requests.find(request => request.method === 'sendReceipt')
    assert.equal(receipt.params.recipient, number); assert.deepEqual(Array.from(receipt.params.targetTimestamp), [42])
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal receipts never mark another peer or a partly read group as read', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({})
    const account = '+12025550100', first = '+12025550123', second = '+12025550124'
    adapter.setOnlineUser('owner')
    for (const peer of [first, second, 'group:YWJj']) await adapter.rememberMessage('owner', { account, peer, fromMe: true, original: 'test', timestamp: 123, delivery: 'sent', recipients: peer.startsWith('group:') ? [first, second] : undefined })
    await adapter.onReceive({ account, envelope: { sourceNumber: first, receiptMessage: { timestamps: [123], isRead: true } } })
    let rows = await adapter.historyStore.read()
    assert.equal(rows.find((row: any) => row.peer === first).delivery, 'read')
    assert.equal(rows.find((row: any) => row.peer === second).delivery, 'sent')
    assert.equal(rows.find((row: any) => row.peer.startsWith('group:')).delivery, 'sent')
    await adapter.onReceive({ account, envelope: { sourceNumber: second, receiptMessage: { timestamps: [123], isRead: true } } })
    rows = await adapter.historyStore.read()
    assert.equal(rows.find((row: any) => row.peer.startsWith('group:')).delivery, 'read')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal late success keeps the original disappearing-message deadline', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({})
    const account = '+12025550100', peer = '+12025550123', timestamp = Date.now()
    adapter.setOnlineUser('owner'); adapter.start = async () => {}
    adapter.accounts.list = async () => [{ id: 'a', platform: 'signal', signalAccount: account }]
    adapter.expirations.set(account + ':' + peer, 30)
    let late: Function = () => {}, resolve: (message: any) => void = () => {}
    const confirmed = new Promise<any>(done => { resolve = done })
    adapter.onSendConfirmed(async (_owner: string, _id: string, message: any) => resolve(message))
    adapter.cli.call = async (_method: string, _params: any, _timeout: number, callback: Function) => { late = callback; throw new Error('RPC timeout') }
    await assert.rejects(adapter.submitTask({ id: 'task', accountId: 'a', signalAccount: account, recipient: peer, conversationId: 'signal:' + peer, request: { text: 'hello' }, translated: 'hello' }, () => true), /后台确认/)
    late({ timestamp, results: [{ type: 'SUCCESS' }] })
    const message = await confirmed
    assert.equal(message.expiresAt, timestamp + 30000); assert.equal(message.delivery, 'sent')
    await adapter.flushHistory()
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})
