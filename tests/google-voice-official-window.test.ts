import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import test from 'node:test'
import type { GoogleVoiceLauncherDependencies } from '../src/main/platforms/googleVoice/officialWindow.ts'
import { mainHarness } from './main-harness.ts'

const { GoogleVoiceOfficialWindow } = mainHarness().load('src/main/platforms/googleVoice/officialWindow.ts')

const PROFILE = 'D:\\HelloDog\\users\\owner-hash'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
const USER_CHROME = 'D:\\UserAppData\\Local\\Google\\Chrome\\Application\\chrome.exe'

class FakeChild extends EventEmitter {
  unrefCount = 0
  unref() { this.unrefCount++ }
}

function harness(options: Partial<GoogleVoiceLauncherDependencies> = {}) {
  let time = 1000
  const probes: string[] = []
  const directories: string[] = []
  const children: FakeChild[] = []
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = []
  const installed = new Set([CHROME, EDGE])
  const dependencies: GoogleVoiceLauncherDependencies = {
    platform: 'win32',
    environment: { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'D:\\UserAppData\\Local' },
    isFile: async file => { probes.push(file); return installed.has(file) },
    createDirectory: async directory => { directories.push(directory) },
    spawn: (file, args, spawnOptions) => {
      calls.push({ file, args: [...args], options: { ...spawnOptions } })
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child as unknown as ChildProcess
    },
    now: () => time,
    launchTimeoutMs: 5000,
    operationTimeoutMs: 10000,
    ...options
  }
  const launcher = new GoogleVoiceOfficialWindow(PROFILE, dependencies)
  return { launcher, dependencies, probes, directories, children, calls, installed, advance: () => { time += 3000 } }
}

test('launches only the official site in an installed Chrome with a separate persistent profile', async () => {
  const h = harness()
  assert.deepEqual(JSON.parse(JSON.stringify(await h.launcher.open())), { browser: 'chrome', launched: true })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].file, CHROME)
  assert.deepEqual(h.calls[0].args, [
    '--app=https://voice.google.com/',
    '--user-data-dir=D:\\HelloDog\\users\\owner-hash\\official-browser\\chrome',
    '--no-first-run', '--no-default-browser-check'
  ])
  assert.deepEqual(h.calls[0].options, { shell: false, detached: true, windowsHide: false, stdio: 'ignore' })
  assert.deepEqual(h.directories, ['D:\\HelloDog\\users\\owner-hash\\official-browser\\chrome'])
  assert.equal(h.children[0].unrefCount, 1)
  assert.equal(h.probes.length, 1)
})

test('read-only browser resolution allows reusing a verified surviving window without spawning',async()=>{
  const h=harness(),details=await h.launcher.resolveDetails()
  assert.equal(details.executable,CHROME);assert.equal(h.calls.length,0);assert.equal(h.directories.length,0)
  assert.equal(details.profile,'D:\\HelloDog\\users\\owner-hash\\official-browser\\chrome')
})

test('extension setup opens only the selected browser profile and fixed management page',async()=>{
  const h=harness();await h.launcher.openExtensions(()=>true)
  assert.equal(h.calls[0].file,CHROME)
  assert.deepEqual(h.calls[0].args,['--user-data-dir=D:\\HelloDog\\users\\owner-hash\\official-browser\\chrome','--no-first-run','--no-default-browser-check','--new-window','chrome://extensions/'])
  assert.equal(h.calls[0].options.shell,false)
})

test('persisted Edge choice cannot silently change to Chrome',async()=>{
  const h=harness(),launcher=new GoogleVoiceOfficialWindow(PROFILE,h.dependencies,'edge')
  h.installed.delete(EDGE)
  assert.equal(await launcher.resolveDetails(),undefined)
  await assert.rejects(launcher.open());assert.equal(h.calls.length,0)
})

test('prefers a per-user Chrome installation before falling back to installed Edge', async () => {
  const h = harness()
  h.installed.delete(CHROME)
  h.installed.add(USER_CHROME)
  assert.equal((await h.launcher.open()).browser, 'chrome')
  assert.equal(h.calls[0].file, USER_CHROME)
  assert.equal(new Set(h.probes).size, h.probes.length, 'duplicated environment roots are deduplicated')
})

test('uses Edge with an Edge-only profile when no Chrome is installed', async () => {
  const h = harness()
  h.installed.delete(CHROME)
  assert.equal((await h.launcher.open()).browser, 'edge')
  assert.equal(h.calls[0].file, EDGE)
  assert.equal(h.calls[0].args[1], '--user-data-dir=D:\\HelloDog\\users\\owner-hash\\official-browser\\edge')
})

test('falls back only when the first browser definitely fails before spawning', async () => {
  const attempts: string[] = []
  const h = harness({ spawn: (file) => {
    attempts.push(file)
    const child = new FakeChild()
    queueMicrotask(() => file === CHROME ? child.emit('error', new Error('launch failed')) : child.emit('spawn'))
    return child as unknown as ChildProcess
  } })
  assert.equal((await h.launcher.open()).browser, 'edge')
  assert.deepEqual(attempts, [CHROME, EDGE])
  assert.deepEqual(h.directories, [PROFILE + '\\official-browser\\chrome', PROFILE + '\\official-browser\\edge'])
})

test('a synchronous OS launch failure may fall back to Edge', async () => {
  const h = harness({ spawn: file => {
    if (file === CHROME) throw new Error('not executable')
    const child = new FakeChild()
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  } })
  assert.equal((await h.launcher.open()).browser, 'edge')
})

test('missing browsers fail clearly without creating profiles or downloading anything', async () => {
  const h = harness()
  h.installed.clear()
  await assert.rejects(h.launcher.open(), /未找到已安装的 Chrome 或 Edge/)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.directories, [])
})

test('failed launches release the pending operation so a user can retry', async () => {
  const h = harness()
  h.installed.clear()
  await assert.rejects(h.launcher.open(), /未找到/)
  h.installed.add(CHROME)
  assert.equal((await h.launcher.open()).browser, 'chrome')
})

test('coalesces concurrent clicks, briefly debounces success, then permits reopening the same browser', async () => {
  const h = harness()
  const first = h.launcher.open()
  const second = h.launcher.open()
  assert.strictEqual(first, second)
  await Promise.all([first, second])
  await h.launcher.open()
  assert.equal(h.calls.length, 1)
  h.advance()
  await h.launcher.open()
  assert.equal(h.calls.length, 2)
  assert.ok(h.calls.every(call => call.file === CHROME))
})

test('keeps the selected browser after launch and never opens another browser on a later failure', async () => {
  const h = harness()
  h.installed.delete(CHROME)
  await h.launcher.open()
  h.installed.add(CHROME)
  h.advance()
  await h.launcher.open()
  assert.ok(h.calls.every(call => call.file === EDGE))
  h.installed.delete(EDGE)
  h.advance()
  await assert.rejects(h.launcher.open(), /之前使用的浏览器/)
  assert.equal(h.calls.length, 2)
})

test('does not confuse a short-lived spawned browser handoff with a failed launch', async () => {
  const h = harness()
  await h.launcher.open()
  h.children[0].emit('close', 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.children[0].eventNames().length, 0)
})

test('bounds child listeners and cleans them when each process closes without terminating it', async () => {
  const h = harness()
  for (let index = 0; index < 8; index++) {
    h.advance()
    await h.launcher.open()
    const child = h.children[index]
    assert.equal(child.listenerCount('spawn'), 0)
    assert.equal(child.listenerCount('error'), 1)
    assert.equal(child.listenerCount('close'), 1)
    child.emit('error', new Error('late process error'))
    child.emit('close', 0)
    assert.equal(child.eventNames().length, 0)
  }
})

test('a spawn timeout is bounded and never automatically launches another browser', async () => {
  const children: FakeChild[] = []
  const attempts: string[] = []
  const h = harness({ launchTimeoutMs: 5, spawn: file => {
    attempts.push(file)
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  } })
  await assert.rejects(h.launcher.open(), /启动尚未确认/)
  assert.deepEqual(attempts, [CHROME])
  h.installed.delete(CHROME)
  await assert.rejects(h.launcher.open(), /之前使用的浏览器/)
  assert.deepEqual(attempts, [CHROME])
  children[0].emit('spawn') // A late OS event must not cause another launch or rejection.
  children[0].emit('close', 0)
  assert.equal(children[0].eventNames().length, 0)
})

test('the overall budget also bounds browser discovery; late filesystem completion never spawns', async () => {
  let finishProbe!: (value: boolean) => void
  const h = harness({ operationTimeoutMs: 5, isFile: () => new Promise(resolve => { finishProbe = resolve }) })
  await assert.rejects(h.launcher.open(), /打开超时/)
  finishProbe(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 0)
  assert.equal(h.directories.length, 0)
})

test('the overall budget bounds profile creation; late completion never spawns', async () => {
  let finishDirectory!: () => void
  const h = harness({ operationTimeoutMs: 5, createDirectory: () => new Promise(resolve => { finishDirectory = resolve }) })
  await assert.rejects(h.launcher.open(), /打开超时/)
  finishDirectory()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 0)
})

test('refuses unauthorized callers even when a launch is cached or in flight', async () => {
  const h = harness()
  const launch = h.launcher.open()
  await assert.rejects(h.launcher.open(() => false), /登录状态已变化/)
  await launch
  await assert.rejects(h.launcher.open(() => false), /登录状态已变化/)
  assert.equal(h.calls.length, 1)
})

test('changing owner while finding the browser stops launch before profile creation', async () => {
  let authorized = true
  const h = harness({ isFile: async () => { authorized = false; return true } })
  await assert.rejects(h.launcher.open(() => authorized), /登录状态已变化/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.directories.length, 0)
})

test('changing owner while creating the profile stops launch immediately before spawn', async () => {
  let authorized = true
  const h = harness({ createDirectory: async () => { authorized = false } })
  await assert.rejects(h.launcher.open(() => authorized), /登录状态已变化/)
  assert.equal(h.calls.length, 0)
})

test('changing owner during a failed first launch prevents launching the fallback browser', async () => {
  let authorized = true
  const attempts: string[] = []
  const h = harness({ spawn: file => {
    attempts.push(file)
    const child = new FakeChild()
    queueMicrotask(() => { authorized = false; child.emit('error', new Error('failed')) })
    return child as unknown as ChildProcess
  } })
  await assert.rejects(h.launcher.open(() => authorized), /登录状态已变化/)
  assert.deepEqual(attempts, [CHROME])
})

test('an identity lookup exception fails closed without filesystem or process work', async () => {
  const h = harness()
  await assert.rejects(h.launcher.open(() => { throw new Error('auth unavailable') }), /登录状态已变化/)
  assert.equal(h.probes.length, 0)
  assert.equal(h.calls.length, 0)
})

test('profile creation failure preserves old profiles and does not launch a different browser', async () => {
  const h = harness({ createDirectory: async () => { throw new Error('denied') } })
  await assert.rejects(h.launcher.open(), /磁盘空间和目录权限/)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.probes, [CHROME])
})

test('refuses unsupported platforms before checking installations', async () => {
  const h = harness({ platform: 'linux' })
  await assert.rejects(h.launcher.open(), /仅支持 Windows/)
  assert.equal(h.probes.length, 0)
})

test('rejects relative, network, device, traversal and switch-like profile roots', () => {
  for (const root of ['relative', 'D:relative', '\\\\server\\share', '\\\\?\\D:\\profile', 'D:\\owned\\..\\other', '--user-data-dir=evil', 'D:\\bad\" --remote-debugging-port=9222', 'D:\\bad\0path']) {
    assert.throws(() => new GoogleVoiceOfficialWindow(root), /数据目录无效/)
  }
})

test('ignores browser paths and flags from arbitrary environment variables and invalid installation roots', async () => {
  const h = harness({ environment: {
    ProgramFiles: '\\\\server\\share', LOCALAPPDATA: 'relative',
    CHROME_PATH: 'D:\\attacker.exe', PATH: 'D:\\attacker', CHROME_FLAGS: '--no-sandbox'
  } })
  await assert.rejects(h.launcher.open(), /未找到/)
  assert.equal(h.probes.length, 0)
  assert.equal(h.calls.length, 0)
})

test('allows spaces, Unicode and apostrophes in the trusted D-drive root without shell quoting', async () => {
  const h = harness()
  const launcher = new GoogleVoiceOfficialWindow("D:\\资料\\HelloDog User's", h.dependencies)
  await launcher.open()
  assert.equal(h.calls[0].args[1], "--user-data-dir=D:\\资料\\HelloDog User's\\official-browser\\chrome")
  assert.equal(h.calls[0].options.shell, false)
})
