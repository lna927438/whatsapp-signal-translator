import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SessionCoordinator } = require('../src/renderer/src/lib/sessionCoordinator.ts') as typeof import('../src/renderer/src/lib/sessionCoordinator')
const { AuthStorage } = require('../src/renderer/src/lib/authStorage.ts') as typeof import('../src/renderer/src/lib/authStorage')
const { readDraft, saveDraft, clearSentDraft, upsertMessage } = require('../src/renderer/src/lib/signalState.ts') as typeof import('../src/renderer/src/lib/signalState')
const session = (id: string, token = 'test-token') => ({ user: { id }, access_token: token })
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }

test('token refresh and repeated sign-in for the same user preserve the workspace', async () => {
  const events: any[] = [], bridged: any[] = []
  const coordinator = new SessionCoordinator(async value => { bridged.push(value) }, state => events.push(state))
  await coordinator.apply(session('user'))
  const revision = events.at(-1).revision
  await coordinator.apply(session('user', 'rotated-test-token'))
  await coordinator.apply(session('user', 'rotated-test-token'))
  assert.ok(events.every(state => state.revision === revision))
  assert.equal(bridged.at(-1).access_token, 'rotated-test-token')
})

test('late initial session cannot resurrect a signed-out workspace', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const events: any[] = []
  const coordinator = new SessionCoordinator(async value => { if (value) await pending }, state => events.push(state))
  const initial = coordinator.apply(session('user'))
  await coordinator.apply(null)
  release(); await initial
  assert.equal(events.at(-1).userId, null)
  assert.ok(events.every(state => state.userId === null))
})

test('changing user hides the prior workspace before a slow bridge finishes', async () => {
  let release!: () => void
  const events: any[] = []
  const coordinator = new SessionCoordinator(async value => { if (value?.user.id === 'second') await new Promise<void>(resolve => { release = resolve }) }, state => events.push(state))
  await coordinator.apply(session('first'))
  const changing = coordinator.apply(session('second'))
  assert.equal(events.at(-1).userId, null)
  release(); await changing
  assert.equal(events.at(-1).userId, 'second')
})

test('remember-me controls durable auth storage and local logout does not delete drafts', () => {
  const persistent = storage(), temporary = storage()
  const auth = new AuthStorage(persistent, temporary)
  persistent.setItem('draft', 'unsent work')
  auth.setRemember(true); auth.setItem('test-auth', 'test-session')
  assert.equal(new AuthStorage(persistent, storage()).getItem('test-auth'), 'test-session')
  auth.setRemember(false); auth.setItem('test-auth', 'temporary-session')
  assert.equal(persistent.getItem('test-auth'), null)
  assert.equal(new AuthStorage(persistent, storage()).getItem('test-auth'), null)
  assert.equal(auth.getItem('test-auth'), 'temporary-session')
  auth.clearSession()
  assert.equal(auth.getItem('test-auth'), null)
  assert.equal(persistent.getItem('draft'), 'unsent work')
})

test('drafts survive reload without crossing users, accounts or recipients, and late send success cannot erase new text', () => {
  const disk = storage(), scope = { userId: 'one', recordId: 'record', account: 'sender', peer: 'recipient-a' }
  saveDraft(disk, scope, 'original draft')
  assert.equal(readDraft(disk, scope), 'original draft')
  assert.equal(readDraft(disk, { ...scope, userId: 'two' }), '')
  assert.equal(readDraft(disk, { ...scope, account: 'other' }), '')
  assert.equal(readDraft(disk, { ...scope, peer: 'recipient-b' }), '')
  saveDraft(disk, scope, 'newly typed draft')
  assert.equal(clearSentDraft(disk, scope, 'original draft'), false)
  assert.equal(readDraft(disk, scope), 'newly typed draft')
  assert.equal(clearSentDraft(disk, scope, 'newly typed draft'), true)
})

test('Signal event and RPC receipt produce one bubble and sync events preserve the original text', () => {
  const sent = { taskId: 'task', account: 'sender', peer: 'peer', timestamp: 1, fromMe: true, original: '原文', translated: 'translation' }
  let messages: Array<Omit<typeof sent, 'taskId'> & { taskId?: string }> = upsertMessage([], sent)
  messages = upsertMessage(messages, { ...sent })
  messages = upsertMessage(messages, { ...sent, taskId: undefined, original: 'translation' })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].original, '原文')
  assert.equal(upsertMessage(messages, { ...sent, taskId: 'second', peer: 'different' }).length, 2)
})
