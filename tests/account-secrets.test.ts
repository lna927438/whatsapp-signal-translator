import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const require = createRequire(import.meta.url)

function harness(secure = true) {
  let saved: any[] = []
  const encrypted: string[] = []
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(new URL('../src/main/accounts/accountManager.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, Buffer, process,
    require(name: string) {
      if (name === '../../shared/accountConfig') return require('../src/shared/accountConfig.ts')
      if (name === 'electron') return { safeStorage: {
        isEncryptionAvailable: () => secure,
        getSelectedStorageBackend: () => 'test-keychain',
        encryptString(value: string) { encrypted.push(value); return Buffer.from('encrypted-fixture') },
        decryptString: () => 'test-password'
      } }
      if (name === '../storage/jsonStore') return { JsonStore: class { async read() { return structuredClone(saved) }; async write(value: any) { saved = structuredClone(value) } } }
      if (name === '../network/accountProxy') return require('../src/main/network/accountProxy.ts')
      return require(name)
    }
  })
  return { manager: new exports.AccountManager(), saved: () => saved, encrypted }
}

test('proxy passwords are encrypted, omitted from all account responses, retained on blank edits and explicitly removable', async () => {
  const h = harness()
  const account = await h.manager.add('whatsapp', 'Work', undefined, { proxy: { enabled: true, protocol: 'http', host: 'proxy.example', port: 8080, password: 'test-password' } })
  assert.deepEqual(h.encrypted, ['test-password'])
  assert.equal(JSON.stringify(h.saved()).includes('test-password'), false)
  assert.equal(account.proxy.hasPassword, true)
  assert.equal(account.proxySecret, undefined)
  await h.manager.update(account.id, { proxy: { ...account.proxy, password: '' }, label: 'Renamed' })
  assert.equal(await h.manager.proxyPassword(account.id), 'test-password')
  await h.manager.updateContactLanguage(account.id, 'peer', 'en-US', 'Peer', 'manual')
  const auto = await h.manager.updateContactLanguage(account.id, 'peer', 'fr-FR', 'Peer', 'auto')
  assert.equal(auto.contactLanguages.peer.language, 'en-US')
  assert.equal(auto.proxySecret, undefined)
  assert.equal((await h.manager.list())[0].proxySecret, undefined)
  const cleared = await h.manager.update(account.id, { proxy: { ...account.proxy, clearPassword: true } })
  assert.equal(cleared.proxy.hasPassword, false)
  assert.equal(await h.manager.proxyPassword(account.id), '')
})

test('unavailable secure storage refuses to save a password without creating a partial account', async () => {
  const h = harness(false)
  await assert.rejects(h.manager.add('whatsapp', 'Work', undefined, { proxy: { enabled: true, host: 'proxy.example', port: 8080, password: 'test-password' } }), /安全存储/)
  assert.deepEqual(h.saved(), [])
  assert.deepEqual(h.encrypted, [])
})


test('batch creation is atomic, validates limits and isolates IDs while preserving pin/group', async () => {
  const h = harness()
  const created = await h.manager.addBatch('whatsapp','Team',3,{group:'Sales',pinned:true})
  assert.equal(created.length,3); assert.equal(new Set(created.map((a:any)=>a.id)).size,3)
  assert.equal(created[2].label,'Team 3'); assert.equal(created[0].group,'Sales'); assert.equal(created[0].pinned,true)
  await assert.rejects(h.manager.addBatch('whatsapp','Bad',21,{}))
  assert.equal(h.saved().length,3)
  await assert.rejects(h.manager.addBatch('whatsapp','Proxy',2,{proxy:{enabled:true,host:'bad/path',port:80}}))
  assert.equal(h.saved().length,3)
})
