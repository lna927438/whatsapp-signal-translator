import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, readFileSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'
import { normalizeSignalPeer, signalContacts, signalEnvelopePeer, signalSendParameters, signalSendTimestamp } from '../src/shared/signalProtocol.ts'

test('Signal status queries finish with the same terminal state for event listeners and callers', async () => {
  const h = mainHarness()
  try {
    const { SignalRuntimeManager } = h.load('src/main/platforms/signal/signalRuntime.ts')
    const runtime = new SignalRuntimeManager(), states: any[] = []
    runtime.locate = async () => ({ signalCliPath: 'verified', source: 'bundled' })
    runtime.on('status', (value: any) => states.push(value))
    for (let i = 0; i < 4; i++) assert.equal((await runtime.status()).state, 'ready')
    assert.equal(states.at(-1).state, 'ready')
    assert.equal(states.some(value => value.state === 'checking'), false)
    runtime.locate = async () => undefined
    assert.equal((await runtime.status()).state, 'missing'); assert.equal(states.at(-1).state, 'missing')
    runtime.locate = async () => { throw new Error('disk unavailable') }
    assert.equal((await runtime.status()).state, 'error'); assert.equal(states.at(-1).state, 'error')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('background Signal status reads preserve active download progress', async () => {
  const h = mainHarness()
  try {
    const { SignalRuntimeManager } = h.load('src/main/platforms/signal/signalRuntime.ts')
    const runtime = new SignalRuntimeManager()
    runtime.currentStatus = { state: 'downloading-java', message: '下载中', progress: 46 }
    runtime.installing = new Promise(() => {})
    runtime.locate = () => { throw new Error('Should not inspect partial files') }
    assert.equal((await runtime.status()).progress, 46)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal concurrent starts wait for the verified handshake and do not spawn twice', async () => {
  const h = mainHarness()
  try {
    const { SignalCli } = h.load('src/main/platforms/signal/signalCli.ts'), cli = new SignalCli()
    let release!: () => void, launches = 0, completed = 0
    cli.runtime.ensureReady = async () => ({ source: 'env' })
    cli.launch = async () => { launches++; cli.child = { killed: false, kill() {} }; await new Promise<void>(resolve => { release = resolve }); cli.ready = true }
    const first = cli.start().then(() => completed++)
    await Promise.resolve(); await Promise.resolve()
    const second = cli.start().then(() => completed++)
    await Promise.resolve(); assert.equal(completed, 0); assert.equal(cli.running, false)
    release(); await Promise.all([first, second]); assert.equal(launches, 1); assert.equal(completed, 2); assert.equal(cli.running, true)
    cli.stop()
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('cancelled Signal startup cannot launch after a slow runtime lookup returns', async () => {
  const h = mainHarness()
  try {
    const { SignalCli } = h.load('src/main/platforms/signal/signalCli.ts'), cli = new SignalCli()
    let release!: (value: any) => void, launches = 0
    cli.runtime.ensureReady = () => new Promise(resolve => { release = resolve })
    cli.launch = async () => { launches++ }
    const starting = cli.start(); cli.stop(); release({ source: 'env' })
    await assert.rejects(starting, /取消/); assert.equal(launches, 0)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal public JSON-RPC payloads support numbers, usernames and group recipients', () => {
  assert.equal(normalizeSignalPeer('+1 (202) 555-0123'), '+12025550123')
  assert.equal(normalizeSignalPeer('@alex.42'), 'u:alex.42')
  assert.deepEqual(signalSendParameters('+12025550100', '+12025550123', 'hello'), { account: '+12025550100', recipient: ['+12025550123'], message: 'hello' })
  assert.deepEqual(signalSendParameters('+12025550100', 'group:YXNkZg==', 'hello'), { account: '+12025550100', groupId: 'YXNkZg==', message: 'hello' })
  for (const peer of ['', 'alice', '123', '+1; delete']) assert.throws(() => normalizeSignalPeer(peer))
})

test('Signal private-number contacts and groups retain address aliases and usable display names', () => {
  const contacts = signalContacts([
    { uuid: '10000000-0000-4000-8000-000000000001', profile: { givenName: 'Alex', familyName: 'Lee' } },
    { number: '+12025550123', uuid: '20000000-0000-4000-8000-000000000001', name: 'Morgan' },
    { number: '+12025550124', name: 'Blocked', isBlocked: true }
  ], [{ id: 'YXNkZg==', name: 'Team', isMember: true }, { id: 'b2xk', isMember: false }])
  assert.equal(contacts.length, 4); assert.equal(contacts[0].name, 'Alex Lee'); assert.equal(contacts[1].aliases.length, 2); assert.equal(contacts[2].blocked, true); assert.equal(contacts[3].id, 'group:YXNkZg==')
})

test('Signal envelopes route hidden numbers, groups and other-device sent sync to the correct conversation', () => {
  const uuid = '10000000-0000-4000-8000-000000000001'
  assert.equal(signalEnvelopePeer({ sourceUuid: uuid, dataMessage: { message: 'hello' } }), uuid)
  assert.equal(signalEnvelopePeer({ sourceNumber: '+12025550123', dataMessage: { groupInfo: { groupId: 'YXNkZg==' } } }), 'group:YXNkZg==')
  assert.equal(signalEnvelopePeer({ sourceNumber: '+12025550100', syncMessage: { sentMessage: { destinationUuid: uuid } } }), uuid)
  assert.equal(signalEnvelopePeer({ syncMessage: { sentMessage: {} } }), '')
})

test('Signal never invents success from a missing timestamp or a partial recipient failure', () => {
  assert.equal(signalSendTimestamp({ timestamp: 12345, results: [{ type: 'SUCCESS' }] }), 12345)
  for (const result of [{}, { timestamp: 0 }, { timestamp: '12345' }, { timestamp: 12345, results: [{ type: 'NETWORK_FAILURE' }] }]) assert.throws(() => signalSendTimestamp(result))
})

test('a stale Signal account cannot block another account from subscribing', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({})
    adapter.setOnlineUser('owner'); adapter.cli.start = async () => {}
    adapter.accounts.list = async () => [{ id: 'stale', platform: 'signal', signalAccount: '+12025550100' }, { id: 'ok', platform: 'signal', signalAccount: '+12025550101' }]
    adapter.cli.call = async (_method: string, params: any) => { if (params.account === '+12025550100') throw new Error('Unknown account'); return 7 }
    await adapter.start(); assert.equal(adapter.subscriptions.get('+12025550101'), 7); assert.equal(adapter.subscriptions.size, 1)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal emits a private-number message into a persistent, selectable conversation', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({ cached: async () => undefined, history: async () => [] })
    adapter.setOnlineUser('owner')
    adapter.accounts.list = async () => [{ id: 'a', platform: 'signal', signalAccount: '+12025550100' }]
    adapter.accounts.updateContactLanguage = async () => {}
    adapter.settings.runtime = async () => ({ localLanguage: 'en-US', receiveAutoTranslate: false })
    const uuid = '10000000-0000-4000-8000-000000000001'
    await adapter.onReceive({ subscription: 1, result: { account: '+12025550100', envelope: { sourceUuid: uuid, sourceName: 'Alex', dataMessage: { timestamp: 42, message: 'Hi' } } } })
    const history = await adapter.loadHistory('+12025550100')
    assert.equal(history[0].peer, uuid); assert.equal(history[0].senderName, 'Alex')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal launch includes an explicit data directory and scrubbed logging', () => {
  const h = mainHarness()
  try {
    const { createLaunchPlan } = h.load('src/main/platforms/signal/signalCli.ts')
    const plan = createLaunchPlan({ signalCliPath: 'signal-cli', source: 'env' })
    assert.ok(plan.args.includes('--scrub-log')); assert.ok(plan.args.includes('--data-dir'))
    assert.ok(plan.args[plan.args.indexOf('--data-dir') + 1].startsWith(h.directory))
    assert.equal(plan.args.at(-1), '--receive-mode=manual')
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('paused Signal accounts cannot restart receiving through a contact refresh', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({})
    let starts = 0
    adapter.start = async () => { starts++ }
    adapter.accounts.list = async () => [{ id: 'a', platform: 'signal', signalAccount: '+12025550100', runtimeMode: 'paused' }]
    await assert.rejects(adapter.listContacts('+12025550100'), /暂停/)
    await assert.rejects(adapter.syncContacts('+12025550100'), /暂停/)
    assert.equal(starts, 0)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('record-window recovery validates the main window and owner and never invokes sending', async () => {
  const handlers = new Map<string, Function>(), calls: string[] = []
  const h = mainHarness({ app: { getPath: () => h.directory, getVersion: () => 'test' }, ipcMain: { on() {}, handle: (name: string, callback: Function) => handlers.set(name, callback) }, powerMonitor: { on() {}, removeListener() {} } })
  try {
    const register = h.load('src/main/reliabilityIpc.ts').registerReliabilityIpc
    const tasks = {
      get: async (owner: string, id: string) => { if (owner !== 'owner' || id !== 'original') throw new Error('任务不存在'); return { accountId: 'a' } },
      confirmSent: async () => { calls.push('sent'); return {} }, confirmNotSent: async () => { calls.push('not-sent'); return {} }, cancel: async () => { calls.push('cancel'); return {} }
    }
    register({ webContents: { id: 7, send() {} }, on() {} }, {}, {}, tasks, {onContentCleanup(){},sweepContent:async()=>{}}, {}, {}, () => 'owner')
    const resolve = handlers.get('reliability:resolve-send')!
    const frame={url:new URL('../src/renderer/index.html',import.meta.url).href},event=(id:number)=>({sender:{id,mainFrame:frame},senderFrame:frame})
    assert.throws(()=>resolve(event(8), 'original', 'sent'), /阻止/)
    await assert.rejects(resolve(event(7), 'other-owner-task', 'sent'), /不存在/)
    await resolve(event(7), 'original', 'not-sent')
    assert.deepEqual(calls, ['not-sent'])
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})

test('Signal persisted history uses recoverable incoming translation and preserves manual retry intent',async()=>{
 const h=mainHarness(),seen:any[]=[];
 try{
  const {SignalAdapter}=h.load('src/main/platforms/signal/signalAdapter.ts');
  const adapter=new SignalAdapter({cached:async()=>undefined,translate:async()=>{throw Error('wrong translation path')},translateIncoming:async(r:any,manual:boolean)=>{seen.push({r,manual});if(seen.length===1)throw Error('temporarily unavailable');return '历史译文'}});
  const identity={account:'+12025550100',peer:'10000000-0000-4000-8000-000000000001',timestamp:1,fromMe:false};
  adapter.setOnlineUser('owner');adapter.accounts.list=async()=>[{id:'a',platform:'signal',signalAccount:identity.account}];
  adapter.settings.runtime=async()=>({localLanguage:'zh-CN',receiveAutoTranslate:true,historyMode:'visible'});
  await adapter.historyStore.write([{...identity,owner:'owner',original:'How was your day?'}]);
  await assert.rejects(adapter.translateMessage('a',identity),/unavailable/);
  assert.equal(await adapter.translateMessage('a',identity,true),'历史译文');
  assert.equal(seen.length,2);assert.equal(seen[0].manual,false);assert.equal(seen[1].manual,true);
  assert.equal(seen[0].r.messageId,seen[1].r.messageId);assert.equal(seen[1].r.text,'How was your day?');
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('Signal reconnects after an unexpected process exit and stop cancels the retry', async () => {
  const h = mainHarness()
  try {
    const { SignalAdapter } = h.load('src/main/platforms/signal/signalAdapter.ts'), adapter = new SignalAdapter({})
    adapter.setOnlineUser('owner'); adapter.reconnectDelay = 5; adapter.accounts.list = async () => []
    let recoveries = 0
    adapter.resumeReceiving = async () => { recoveries++ }
    adapter.cli.emit('exit', 1)
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(recoveries, 1)
    adapter.reconnectDelay = 5; adapter.cli.emit('exit', 1); adapter.stop()
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(recoveries, 1)
  } finally { rmSync(h.directory, { recursive: true, force: true }) }
})
