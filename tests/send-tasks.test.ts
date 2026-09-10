import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { NewSendTask, SendTaskData } from '../src/main/translation/sendTasks'
const { SendTasks, SendNotStartedError } = createRequire(import.meta.url)('../src/main/translation/sendTasks.ts') as typeof import('../src/main/translation/sendTasks')
const allowed = () => true
const input: NewSendTask = { platform: 'signal', accountId: 'record-1', conversationId: 'signal:peer-1', signalAccount: 'sender-1', recipient: 'peer-1', translate: true, blockChinese: true,
  request: { text: '测试\n第二行', targetLanguage: 'en-US', sourceLanguage: 'zh-CN', context: [{ role: 'incoming', text: 'prior message' }] } }
function fixture() {
  let data: SendTaskData = { tasks: [] }
  const storage = { read: async () => structuredClone(data), write: async (next: SendTaskData) => { data = structuredClone(next) } }
  return { storage, tasks: new SendTasks(storage) }
}

test('lost translation response and application restart retain request ID, language, context and original draft', async () => {
  const { tasks, storage } = fixture()
  const first = await tasks.prepare('user-1', input)
  const requests: any[] = []
  await assert.rejects(tasks.translate('user-1', first.id, async request => { requests.push(request); throw new Error('response lost') }, allowed))
  const restarted = new SendTasks(storage)
  const retry = await restarted.prepare('user-1', { ...input, request: { ...input.request, targetLanguage: 'fr', context: [] } })
  await restarted.translate('user-1', retry.id, async request => { requests.push(request); return 'test\nsecond line' }, allowed)
  assert.equal(first.id, retry.id)
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[1].text, input.request.text)
  assert.equal(requests[1].requestId, first.id)
})

test('concurrent translation and submission coalesce, completed replay never dispatches again', async () => {
  const { tasks } = fixture()
  const task = await tasks.prepare('user', input)
  let translates = 0, sends = 0
  const translate = async () => { translates++; await new Promise(resolve => setTimeout(resolve, 5)); return 'test' }
  await Promise.all([tasks.translate('user', task.id, translate, allowed), tasks.translate('user', task.id, translate, allowed)])
  const send = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 5)); return { receipt: 'one' } }
  const results = await Promise.all([tasks.submit('user', task.id, send, allowed), tasks.submit('user', task.id, send, allowed)])
  assert.deepEqual(results[0], results[1])
  await tasks.submit('user', task.id, send, allowed)
  assert.equal(translates, 1); assert.equal(sends, 1)
  const intentionalNew = await tasks.prepare('user', input)
  assert.notEqual(intentionalNew.id, task.id)
})

test('timeout after dispatch and restart block both same-text retry and a changed-text bypass until user resolves outcome', async () => {
  const { tasks, storage } = fixture()
  const task = await tasks.prepare('user', input)
  await tasks.translate('user', task.id, async () => 'test', allowed)
  let sends = 0
  await assert.rejects(tasks.submit('user', task.id, async () => { sends++; throw new Error('RPC timeout') }, allowed), /未确认/)
  const restarted = new SendTasks(storage)
  const retry = await restarted.prepare('user', { ...input, request: { ...input.request, text: 'different text' } })
  assert.equal(retry.id, task.id)
  await assert.rejects(restarted.submit('user', retry.id, async () => { sends++ }, allowed), /未确认/)
  assert.equal(sends, 1)
  await restarted.confirmNotSent('user', retry.id)
  await restarted.translate('user', retry.id, async () => { throw new Error('must reuse stored translation') }, allowed)
  await restarted.submit('user', retry.id, async () => { sends++ }, allowed)
  assert.equal(sends, 2)
})

test('user confirming a visible sent message resolves uncertainty without calling a platform', async () => {
  const { tasks } = fixture()
  const task = await tasks.prepare('user', input)
  await tasks.translate('user', task.id, async () => 'test', allowed)
  await assert.rejects(tasks.submit('user', task.id, async () => { throw new Error('lost receipt') }, allowed))
  assert.equal((await tasks.confirmSent('user', task.id)).state, 'sent')
  assert.equal(await tasks.pending('user', input.accountId, input.conversationId), null)
})

test('pre-dispatch navigation failure is safely retryable, while logout prevents any submission', async () => {
  const { tasks } = fixture()
  const task = await tasks.prepare('user', input)
  await tasks.translate('user', task.id, async () => 'test', allowed)
  await assert.rejects(tasks.submit('user', task.id, async () => { throw new SendNotStartedError('chat changed') }, allowed), /chat changed/)
  assert.equal((await tasks.get('user', task.id)).state, 'ready')
  await assert.rejects(tasks.submit('user', task.id, async () => { assert.fail('must not dispatch') }, () => false), /登录状态/)
})

test('logout during translation saves the paid result without allowing a send', async () => {
  const { tasks } = fixture()
  const task = await tasks.prepare('user', input)
  let authorized = true
  await assert.rejects(tasks.translate('user', task.id, async () => { authorized = false; return 'test' }, () => authorized), /未发送/)
  assert.equal((await tasks.get('user', task.id)).translated, 'test')
})

test('task ownership and chat address keep different users and same-name contacts separate', async () => {
  const { tasks } = fixture()
  const first = await tasks.prepare('user-a', { ...input, targetKey: 'peer:a' })
  const second = await tasks.prepare('user-a', { ...input, targetKey: 'peer:b' })
  assert.notEqual(first.id, second.id)
  await assert.rejects(tasks.get('user-b', first.id), /不属于/)
  await assert.rejects(tasks.confirmNotSent('user-b', first.id), /不属于/)
  assert.equal(await tasks.pending('user-b', input.accountId, input.conversationId, 'peer:a'), null)
})

test('persisting submission intent must succeed before any platform call', async () => {
  const { tasks, storage } = fixture()
  const task = await tasks.prepare('user', input)
  await tasks.translate('user', task.id, async () => 'test', allowed)
  const write = storage.write
  storage.write = async data => { if (data.tasks.some(item => item.state === 'submitting')) throw new Error('disk full'); await write(data) }
  await assert.rejects(tasks.submit('user', task.id, async () => { assert.fail('must not dispatch') }, allowed), /disk full/)
})

test('Chinese-send block and explicit no-translation setting remain enforced', async () => {
  const { tasks } = fixture()
  const task = await tasks.prepare('user', { ...input, translate: false })
  await tasks.translate('user', task.id, async () => { assert.fail('provider must not run') }, allowed)
  await assert.rejects(tasks.submit('user', task.id, async () => { assert.fail('must not send Chinese') }, allowed), /包含中文/)
})

test('cancelling a failed/ready task permits an explicit new language but cannot erase uncertain dispatches', async () => {
  const { tasks } = fixture()
  const first = await tasks.prepare('user', input)
  await tasks.translate('user', first.id, async () => 'test', allowed)
  await tasks.cancel('user', first.id)
  await assert.rejects(tasks.submit('user', first.id, async () => { assert.fail('cancelled task must not send') }, allowed), /取消/)
  const replacement = await tasks.prepare('user', { ...input, request: { ...input.request, targetLanguage: 'fr' } })
  assert.notEqual(replacement.id, first.id)
  assert.equal(replacement.request.targetLanguage, 'fr')
  await tasks.translate('user', replacement.id, async () => 'bonjour', allowed)
  await assert.rejects(tasks.submit('user', replacement.id, async () => { throw new Error('lost receipt') }, allowed))
  await assert.rejects(tasks.cancel('user', replacement.id), /不能取消/)
})

test('an initially empty WhatsApp chat retains its saved task when its stable address appears later', async () => {
  const { tasks } = fixture()
  const first = await tasks.prepare('user', { ...input, platform: 'whatsapp', conversationId: 'wa:alex', targetKey: 'title:wa:alex' })
  const resumed = await tasks.prepare('user', { ...input, platform: 'whatsapp', conversationId: 'wa:alex', targetKey: 'peer:alex@c.us' })
  assert.equal(first.id, resumed.id)
  assert.equal((await tasks.pending('user', input.accountId, 'wa:alex', 'peer:alex@c.us'))?.id, first.id)
})
