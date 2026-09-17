import test from 'node:test'
import assert from 'node:assert/strict'
import { join, relative } from 'node:path'
import { mainHarness } from './main-harness.ts'

test('Google Voice profiles are owner-scoped, reused and stay under the configured data folder', async () => {
  const h = mainHarness()
  const { createGoogleVoiceAccess } = h.load('src/main/platforms/googleVoice/googleVoiceAccess.ts')
  let owner = 'first-user@example.invalid', revision = 1
  const paths: string[] = [], guards: Array<() => boolean> = []
  const open = createGoogleVoiceAccess(h.directory, () => {
    const captured = owner, version = revision
    return { owner: captured, authorized: () => owner === captured && revision === version }
  }, (path: string) => {
    paths.push(path)
    return { open: async (guard: () => boolean) => { guards.push(guard); return { browser: 'chrome', launched: true } } }
  })
  await open(); await open()
  assert.equal(paths.length, 1)
  assert.match(relative(join(h.directory, 'google-voice'), paths[0]), /^[a-f0-9]{64}$/)
  assert.ok(!paths[0].includes(owner))
  owner = '../../other-user'; revision++
  assert.equal(guards[0](), false)
  await open(); assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1])
  assert.match(relative(join(h.directory, 'google-voice'), paths[1]), /^[a-f0-9]{64}$/)
  owner = 'first-user@example.invalid'; revision++
  await open(); assert.equal(paths.length, 2)
})

test('Google Voice cannot create a profile or launch without a current HelloDog identity', () => {
  const h = mainHarness()
  const { createGoogleVoiceAccess } = h.load('src/main/platforms/googleVoice/googleVoiceAccess.ts')
  let created = 0
  for (const identity of [{ owner: '', authorized: () => true }, { owner: 'user', authorized: () => false }]) {
    const open = createGoogleVoiceAccess(h.directory, () => identity, () => { created++; throw new Error('should not construct') })
    assert.throws(open, /登录/)
  }
  assert.equal(created, 0)
})

test('Google Voice IPC is exclusive to the trusted main frame, never a chat or remote page', () => {
  const h = mainHarness({ app: { isPackaged: true } })
  const handlers = new Map<string, Function>()
  const frame = { url: new URL('../src/renderer/index.html', import.meta.url).href }
  const sender = { id: 1, mainFrame: frame }
  const ipc = h.load('src/main/secureIpc.ts').createSecureIpc(
    { handle: (key: string, fn: Function) => handlers.set(key, fn), on: () => {} },
    { webContents: sender }, { ownsSender: () => true }
  )
  let calls = 0
  ipc.handle('app:google-voice', () => ++calls)
  const call = handlers.get('app:google-voice')!
  assert.equal(call({ sender, senderFrame: frame }), 1)
  assert.throws(() => call({ sender, senderFrame: { ...frame } }))
  for (const url of ['https://web.whatsapp.com/', 'https://voice.google.com/', 'https://evil.invalid/']) {
    const remote = { url }, web = { id: 2, mainFrame: remote }
    assert.throws(() => call({ sender: web, senderFrame: remote }))
  }
  frame.url = 'https://voice.google.com/'
  assert.throws(() => call({ sender, senderFrame: frame }))
  assert.equal(calls, 1)
})
