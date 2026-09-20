import test from 'node:test'
import assert from 'node:assert/strict'
import type { GoogleVoiceData } from '../src/main/platforms/googleVoice/windowRecords.ts'
import { mainHarness } from './main-harness.ts'

const proxy = { enabled: true, protocol: 'http', host: 'proxy.example.test', port: 8181, username: 'fixture-user', password: 'fixture-password' }
function fixture() {
  let data: GoogleVoiceData = { windows: [] }, available = true, decryptionFails = false, writes = 0
  const storage = { read: async () => structuredClone(data), write: async (next: GoogleVoiceData) => { data = structuredClone(next); writes++ } }
  const h = mainHarness({ safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from('encrypted-fixture:' + value.split('').reverse().join('')),
    decryptString: (value: Buffer) => { if (decryptionFails) throw new Error('private encryption diagnostic'); return value.toString().replace('encrypted-fixture:', '').split('').reverse().join('') }
  } })
  const { GoogleVoiceRecords } = h.load('src/main/platforms/googleVoice/windowRecords.ts') as typeof import('../src/main/platforms/googleVoice/windowRecords.ts')
  return { records: new GoogleVoiceRecords(storage), reload: () => new GoogleVoiceRecords(storage), storage, setAvailable: (value: boolean) => { available = value }, setDecryptionFailure: () => { decryptionFails = true }, get writes() { return writes } }
}

test('old Voice records retain system routing; new proxy passwords are encrypted and never returned', async () => {
  const h = fixture(), legacy = await h.records.add('owner'), added = await h.records.add('owner', { label: '代理窗口', proxy })
  assert.equal(legacy.proxy, undefined); assert.equal(added.label, '代理窗口'); assert.equal(added.proxy?.hasPassword, true)
  const stored = await h.storage.read()
  assert.ok(stored.windows[1].proxySecret); assert.ok(!JSON.stringify(stored).includes(proxy.password))
  const publicResults = [added, await h.records.get('owner', added.id), await h.records.list('owner'), await h.records.update('owner', added.id, { label: '更名' }), await h.records.reorder('owner', [added.id, legacy.id])]
  for (const result of publicResults) { assert.ok(!JSON.stringify(result).includes('proxySecret')); assert.ok(!JSON.stringify(result).includes(proxy.password)) }
  assert.equal(await h.records.proxyPassword('owner', added.id), proxy.password)
})

test('new system-network windows accept unused default ports and reject malformed options clearly', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy: { enabled: false, protocol: 'http', host: '', port: 8080 } })
  assert.equal(added.proxy?.enabled, false)
  for (const input of [null, [], 'invalid']) {
    await assert.rejects(h.records.add('owner', input as any), /窗口设置无效/)
    await assert.rejects(h.records.update('owner', added.id, input as any), /窗口设置无效/)
  }
})

test('saved proxy password is preserved only for the same endpoint and can be explicitly cleared', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy })
  const kept = await h.records.update('owner', added.id, { proxy: { ...proxy, password: '' } })
  assert.equal(kept.proxy?.hasPassword, true); assert.equal(await h.records.proxyPassword('owner', added.id), proxy.password)
  for (const change of [{ host: 'other.example.test' }, { port: 3128 }, { username: 'other-user' }, { protocol: 'https' }]) {
    await assert.rejects(h.records.update('owner', added.id, { proxy: { ...proxy, password: '', ...change } }), /重新填写密码/)
    await assert.rejects(h.records.proxyForTest('owner', added.id, { ...proxy, password: '', ...change }), /重新填写密码/)
  }
  const cleared = await h.records.update('owner', added.id, { proxy: { ...proxy, password: '', host: 'other.example.test', clearPassword: true } })
  assert.equal(cleared.proxy?.hasPassword, false); assert.equal(await h.records.proxyPassword('owner', added.id), '')
})

test('testing a new or existing proxy does not save it or expose another owner password', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy }), before = h.writes
  const prepared = await h.records.proxyForTest('owner', added.id, { ...proxy, password: '' })
  assert.equal(prepared.password, proxy.password); assert.equal(prepared.proxy.hasPassword, true)
  const fresh = await h.records.proxyForTest('owner', undefined, { ...proxy, host: 'fresh.example.test' })
  assert.equal(fresh.proxy.host, 'fresh.example.test'); assert.equal(fresh.password, proxy.password)
  assert.equal(h.writes, before)
  await assert.rejects(h.records.proxyForTest('another-owner', added.id, proxy), /不存在/)
  await assert.rejects(h.records.proxyPassword('another-owner', added.id), /不存在/)
  await assert.rejects(h.records.update('another-owner', added.id, { proxy }), /不存在/)
  await assert.rejects(h.records.proxyForTest('', undefined, proxy), /请先登录/)
  await h.records.update('owner', added.id, { closed: true })
  await assert.rejects(h.records.proxyPassword('owner', added.id), /不存在/)
})

test('changed endpoint accepts a replacement password, while disabling and re-enabling preserve settings', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy })
  await h.records.update('owner', added.id, { proxy: { enabled: false } })
  assert.equal((await h.records.get('owner', added.id)).proxy?.enabled, false)
  assert.equal(await h.records.proxyPassword('owner', added.id), proxy.password)
  await h.records.update('owner', added.id, { proxy: { enabled: true } })
  await h.records.update('owner', added.id, { proxy: { host: 'changed.example.test', password: 'new-fixture-password' } })
  assert.equal(await h.records.proxyPassword('owner', added.id), 'new-fixture-password')
})

test('invalid input and unavailable encryption leave persisted settings unchanged', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy }), before = await h.storage.read()
  for (const bad of [{ ...proxy, password: 'x'.repeat(1025) }, { ...proxy, host: 'host;direct://' }, { ...proxy, enabled: false, port: 'oops' }, []]) {
    await assert.rejects(h.records.update('owner', added.id, { proxy: bad }))
    await assert.rejects(h.records.add('owner', { proxy: bad }))
  }
  h.setAvailable(false)
  await assert.rejects(h.records.update('owner', added.id, { proxy: { password: 'replacement' } }), /安全存储不可用/)
  await assert.rejects(h.records.proxyPassword('owner', added.id), /无法解密/)
  assert.deepEqual(await h.storage.read(), before)
  h.setAvailable(true); h.setDecryptionFailure()
  await assert.rejects(h.records.proxyForTest('owner', added.id, { password: '' }), (error: any) => /无法解密/.test(error.message) && !/private/.test(error.message))
})

test('concurrent proxy writes and renames serialize without losing either change', async () => {
  const h = fixture(), added = await h.records.add('owner')
  await Promise.all([h.records.update('owner', added.id, { proxy }), h.records.update('owner', added.id, { label: '新窗口' })])
  const row = await h.records.get('owner', added.id)
  assert.equal(row.label, '新窗口'); assert.equal(row.proxy?.host, proxy.host)
  assert.equal(await h.records.proxyPassword('owner', added.id), proxy.password)
})

test('authenticated SOCKS settings persist encrypted and recover without resending password to the renderer', async () => {
  const h = fixture(), added = await h.records.add('owner', { proxy: { ...proxy, protocol: 'socks5' } })
  const reloaded = h.reload(), row = await reloaded.get('owner', added.id)
  assert.equal(row.proxy?.protocol, 'socks5'); assert.equal(row.proxy?.hasPassword, true)
  assert.ok(!JSON.stringify(row).includes('proxySecret')); assert.ok(!JSON.stringify(await h.storage.read()).includes(proxy.password))
  assert.equal(await reloaded.proxyPassword('owner', added.id), proxy.password)
  assert.equal((await reloaded.proxyForTest('owner', added.id, { password: '' })).password, proxy.password)
  await assert.rejects(reloaded.update('owner', added.id, { proxy: { username: 'new-user', password: '' } }), /重新填写密码/)
  await reloaded.update('owner', added.id, { proxy: { username: '', password: '', clearPassword: true } })
  assert.equal((await reloaded.get('owner', added.id)).proxy?.hasPassword, false)
  assert.equal(await reloaded.proxyPassword('owner', added.id), '')
})
