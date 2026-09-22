import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'
import { updateSigningBytes, verifyUpdateSignature } from '../src/shared/updateSignature.ts'

function fixture() {
  const pair = generateKeyPairSync('ed25519'), trust = { keys: { fixture: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, windowsPublisherSubjects: [] }
  const signed = (version = '0.5.17', dates = {}) => {
    const value = { schemaVersion: 1 as const, version, versionKey: 'windows/v' + version + '/HelloDog.exe', sha256: 'a'.repeat(64), size: 1234, channel: 'stable' as const, notes: 'Signed release notes ' + version, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), ...dates }
    return { ...value, signature: { algorithm: 'Ed25519' as const, keyId: 'fixture', value: sign(null, updateSigningBytes(value), pair.privateKey).toString('base64') } }
  }
  let directory = '', version = '0.5.16', calls = 0, result: unknown = signed(), offline = false
  const h = mainHarness({ app: { getPath: () => directory, getVersion: () => version } }, async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 4)); if (offline) throw Error('synthetic offline')
    return new Response(JSON.stringify(result))
  }, { './updateTrust': { trustedUpdate: async (raw: unknown) => verifyUpdateSignature(raw, trust) } })
  directory = h.directory
  const { UpdateManager } = h.load('src/main/updates.ts'), { JsonStore } = h.load('src/main/storage/jsonStore.ts')
  return { manager: new UpdateManager(), UpdateManager, store: new JsonStore('update-notice.json', {}), signed, setVersion: (next: string) => { version = next }, setResponse: (next: unknown) => { result = next }, setOffline: (next: boolean) => { offline = next }, calls: () => calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('signature-verified version comparison distinguishes update, current, ahead and unrecognized local version', async () => {
  const f = fixture()
  try {
    const first = await Promise.all([f.manager.notice(), f.manager.notice(), f.manager.notice()])
    assert.equal(f.calls(), 1); assert.ok(first.every(value => value.verified && value.status === 'available' && value.available && value.show))
    assert.equal(first[0].notes, 'Signed release notes 0.5.17')
    f.setVersion('0.5.17'); const current = await f.manager.notice(); assert.equal(current.status, 'current'); assert.equal(current.available, false); assert.equal(current.show, false); assert.equal(current.verified, true)
    f.setVersion('0.5.18'); const ahead = await f.manager.notice(); assert.equal(ahead.status, 'ahead'); assert.equal(ahead.available, false); assert.equal(ahead.show, false)
    f.setVersion('invalid'); assert.equal((await f.manager.notice()).status, 'unknown')
    assert.equal(f.calls(), 1)
  } finally { f.cleanup() }
})

test('network failure invalidates current claims, remains unknown across restart, and manual check bypasses backoff', async () => {
  const f = fixture()
  try {
    f.setVersion('0.5.17'); assert.equal((await f.manager.notice()).status, 'current')
    f.setOffline(true); const failed = await f.manager.notice(true)
    assert.equal(failed.status, 'unknown'); assert.equal(failed.verified, false); assert.equal(failed.latestVersion, undefined); assert.equal(failed.notes, undefined)
    assert.equal((await new f.UpdateManager().notice()).status, 'unknown')
    const before = f.calls(); await f.manager.notice(); assert.equal(f.calls(), before)
    f.setOffline(false); assert.equal((await f.manager.notice(true)).status, 'current'); assert.equal(f.calls(), before + 1)
  } finally { f.cleanup() }
})

test('unsigned, tampered and expired manifests never become latest-version content', async () => {
  for (const kind of ['unsigned', 'tampered', 'expired']) {
    const f = fixture()
    try {
      const value = kind === 'expired' ? f.signed('0.5.17', { issuedAt: new Date(Date.now() - 86400000 * 2).toISOString(), expiresAt: new Date(Date.now() - 86400000).toISOString() }) : f.signed()
      f.setResponse(kind === 'unsigned' ? { ...value, signature: undefined } : kind === 'tampered' ? { ...value, notes: 'Unverified injected text' } : value)
      const result = await f.manager.notice()
      assert.equal(result.status, 'unknown'); assert.equal(result.verified, false); assert.equal(result.notes, undefined); assert.equal(result.show, false)
    } finally { f.cleanup() }
  }
})

test('cached notes are reverified and a signed lower version cannot cause a downgrade reminder', async () => {
  const f = fixture()
  try {
    await f.manager.notice(); const saved = await f.store.read()
    await f.store.write({ ...saved, latest: { ...saved.latest, notes: 'Untrusted cached notes' } })
    const tampered = await f.manager.notice(); assert.equal(tampered.verified, false); assert.equal(tampered.notes, undefined)
    await f.manager.notice(true); f.setResponse(f.signed('0.5.16'))
    const rollback = await f.manager.notice(true); assert.equal(rollback.status, 'unknown'); assert.equal(rollback.show, false)
    f.setResponse(f.signed()); const restored = await f.manager.notice(true); assert.equal(restored.status, 'available')
    await f.manager.snooze('0.5.17'); assert.equal((await new f.UpdateManager().notice()).show, false)
  } finally { f.cleanup() }
})
