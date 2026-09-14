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

test('retention scrubs aged original aliases after task pruning without touching unfinished sends or another owner',async()=>{
  const {tasks,storage}=fixture()
  const task=await tasks.prepare('user',{...input,platform:'whatsapp',conversationId:'wa:fixture',targetKey:'peer:fixture@c.us'})
  await tasks.translate('user',task.id,async()=> 'sent translation',allowed)
  await tasks.submit('user',task.id,async()=>({messageId:'old-message',confirmed:true}),allowed)
  const unfinished=await tasks.prepare('user',{...input,request:{...input.request,text:'unsent draft'}})
  const other=await tasks.prepare('other',{...input,request:{...input.request,text:'other owner'}})
  const data=await storage.read(),old=Date.now()-40*86400000
  data.tasks=data.tasks.filter(item=>item.id!==task.id)
  for(const item of data.tasks)item.updatedAt=old
  for(const item of Object.values(data.originals||{}))item.at=old
  await storage.write(data)
  assert.equal(await tasks.originalForMessage('user','record-1','old-message','sent translation'),input.request.text)
  await tasks.expireOlderContent('user',Date.now()-30*86400000)
  assert.equal(await tasks.originalForMessage('user','record-1','old-message','sent translation'),undefined)
  const remaining=await storage.read()
  assert.equal(remaining.tasks.find(item=>item.id===unfinished.id)?.request.text,'unsent draft')
  assert.equal(remaining.tasks.find(item=>item.id===other.id)?.request.text,'other owner')
})

test('WhatsApp originals survive completed-task pruning and restart, scoped to account and message ID', async () => {
  const {tasks,storage}=fixture()
  const task=await tasks.prepare('user',{...input,platform:'whatsapp',conversationId:'wa:fixture',targetKey:'peer:fixture@c.us'})
  await tasks.translate('user',task.id,async()=> 'shared translated text',allowed)
  await tasks.submit('user',task.id,async()=>({messageId:'true_fixture@c.us_first',confirmed:true}),allowed)
  const journal=await storage.read();journal.tasks=[];await storage.write(journal)
  const restarted=new SendTasks(storage)
  assert.equal(await restarted.originalForMessage('user','record-1','true_fixture@c.us_first','shared translated text'),input.request.text)
  assert.equal(await restarted.originalForMessage('other-user','record-1','true_fixture@c.us_first','shared translated text'),undefined)
  assert.equal(await restarted.originalForMessage('user','other-account','true_fixture@c.us_first','shared translated text'),undefined)
  assert.equal(await restarted.originalForMessage('user','record-1','true_fixture@c.us_second','shared translated text'),undefined)
  assert.equal(await restarted.originalForMessage('user','record-1','true_fixture@c.us_first','edited after sending'),undefined)
})

test('late WhatsApp confirmation restores the original, but an unknown send has no fabricated original mapping',async()=>{
  const {tasks,storage}=fixture()
  const task=await tasks.prepare('user',{...input,platform:'whatsapp',conversationId:'wa:fixture'})
  await tasks.translate('user',task.id,async()=> 'translated',allowed)
  await assert.rejects(tasks.submit('user',task.id,async()=>{throw Error('unknown')},allowed))
  assert.equal(await tasks.originalForMessage('user','record-1','true_fixture@c.us_late','translated'),undefined)
  await tasks.resolveWithEvidence('user',task.id,{messageId:'3EB0000000000000000001'})
  assert.equal(await new SendTasks(storage).originalForMessage('user','record-1','3EB0000000000000000001','translated'),input.request.text)
})

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

test('different compose intents with identical text remain separate while one intent survives replay', async () => {
  const {tasks,storage}=fixture()
  const first=await tasks.prepare('user',{...input,intentId:'intent-first-123'})
  const second=await tasks.prepare('user',{...input,intentId:'intent-second-123'})
  assert.notEqual(first.id,second.id)
  const restarted=new SendTasks(storage)
  assert.equal((await restarted.prepare('user',{...input,intentId:'intent-first-123'})).id,first.id)
  assert.equal((await restarted.prepare('user',{...input,intentId:'intent-second-123'})).id,second.id)
  await restarted.translate('user',first.id,async()=> 'done',allowed)
  await restarted.submit('user',first.id,async()=>({receipt:'one'}),allowed)
  const completedReplay=await new SendTasks(storage).prepare('user',{...input,intentId:'intent-first-123'})
  assert.equal(completedReplay.id,first.id);assert.equal(completedReplay.state,'sent')
  await assert.rejects(restarted.prepare('user',{...input,intentId:'intent-first-123',recipient:'another-peer'}),/不一致/)
})

test('an unknown result keeps the original request without blocking a different next message', async () => {
  const { tasks, storage } = fixture()
  const task = await tasks.prepare('user', input)
  await tasks.translate('user', task.id, async () => 'test', allowed)
  let sends = 0
  await assert.rejects(tasks.submit('user', task.id, async () => { sends++; throw new Error('RPC timeout') }, allowed), /后台确认/)
  const restarted = new SendTasks(storage)
  const next = await restarted.prepare('user', { ...input, request: { ...input.request, text: 'different text' } })
  assert.notEqual(next.id, task.id)
  const retry = await restarted.prepare('user', input)
  assert.equal(retry.id, task.id)
  await assert.rejects(restarted.submit('user', retry.id, async () => { sends++ }, allowed), /后台确认/)
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


test('editing preview retains original translation charge identity and cannot alter a submitted task', async () => {
  const {tasks}=fixture();const task=await tasks.prepare('user',input)
  let calls=0;await tasks.translate('user',task.id,async()=>{calls++;return 'first translation'},allowed)
  const edited=await tasks.editPreview('user',task.id,'reviewed translation')
  assert.equal(edited.request.requestId,task.request.requestId);assert.equal(edited.request.text,input.request.text)
  const sent=await tasks.submit('user',task.id,async(value)=>{assert.equal(value.translated,'reviewed translation');return {ok:true}},allowed)
  assert.equal(calls,1);assert.equal(sent.state,'sent')
  await assert.rejects(tasks.editPreview('user',task.id,'too late'))
  await assert.rejects(tasks.editPreview('other-user',task.id,'not owned'))
})
