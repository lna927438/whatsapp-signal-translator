import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { root, requireMacArm64 } from './macos-build-common.mjs'
requireMacArm64()
const output = join(root, 'release/macos-arm64'), executable = join(output, 'mac-arm64/HelloDog.app/Contents/MacOS/HelloDog')
const profile = join(homedir(), 'Library/Application Support/HelloDog-test-mac-ci-smoke'), marker = join(profile, 'mac-ci-smoke-ready.json')
assert.equal(await access(profile).then(() => true, () => false), false, 'Smoke profile must be fresh; existing data is preserved.')
await mkdir(output, { recursive: true })
const started = Date.now(), child = spawn(executable, ['--isolated-test', '--test-profile=mac-ci-smoke'], { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
let errorText = '', exited = false, exitCode, exitSignal, spawnError
child.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-6000) })
const finished = new Promise(resolve => { child.once('error', error => { spawnError = error; exited = true; resolve() }); child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; resolve() }) })
let ready, report
try {
  while (Date.now() - started < 45000 && !exited) {
    ready = await readFile(marker, 'utf8').then(JSON.parse, () => undefined)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (spawnError) throw spawnError
  assert.equal(exited, false, 'Packaged application exited before its login window was ready.')
  assert.equal(ready?.ready, true, 'Packaged login window never reported ready-to-show.')
  assert.equal(ready.platform, 'darwin'); assert.equal(ready.arch, 'arm64')
  assert.equal(ready.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal(exited, false, 'Packaged application exited immediately after showing its login window.')
  assert.doesNotMatch(errorText, /uncaught exception|cannot find module|dlopen.*failed|code signature.*invalid/i)
  report = { passed: true, version: ready.version, platform: 'darwin', arch: 'arm64', isolatedProfile: true, loginWindowReady: true, elapsedMs: Date.now() - started, authenticatedAccountTested: false, realChatTested: false }
} finally {
  if (!exited) child.kill('SIGTERM')
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 10000))])
  if (!exited) { child.kill('SIGKILL'); await finished }
  if (!ready) await writeFile(join(output, 'MAC-SMOKE-FAILURE.json'), JSON.stringify({ passed: false, exitCode, exitSignal, stderr: errorText }, null, 2) + '\n')
}
const signalProfile = join(homedir(), 'Library/Application Support/HelloDog-MacCI-Signal')
assert.equal(await access(signalProfile).then(() => true, () => false), false, 'Signal smoke profile must be fresh; existing data is preserved.')
const signalEnv = { ...process.env, NODE_ENV: 'production', HELLODOG_EMBEDDED: '1', HELLODOG_SIGNAL_USER_DATA: signalProfile }
delete signalEnv.ELECTRON_RUN_AS_NODE
const signalStarted = Date.now()
const core = spawn(join(output, 'mac-arm64/HelloDog.app/Contents/Resources/signal-desktop/Signal.app/Contents/MacOS/Signal'), [], { env: signalEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], shell: false })
let coreReady, coreExited = false, coreCode, coreError, coreStderr = ''
core.stderr.on('data', data => { coreStderr = (coreStderr + data.toString()).slice(-6000) })
core.on('message', message => { if (message?.channel === 'hellodog' && message.type === 'ready' && message.pid === core.pid) coreReady = message })
const coreFinished = new Promise(resolve => { core.once('error', error => { coreError = error; coreExited = true; resolve() }); core.once('exit', code => { coreExited = true; coreCode = code; resolve() }) })
try {
  while (!coreReady && !coreExited && Date.now() - signalStarted < 90000) await new Promise(resolve => setTimeout(resolve, 250))
  if (coreError) throw coreError
  assert.equal(coreExited, false, 'Mac Signal core exited before the private bridge was ready.')
  const lock = JSON.parse(await readFile(join(root, 'integrations/signal-desktop.lock.json'), 'utf8'))
  assert.equal(coreReady?.version, lock.tag.replace(/^v/, ''), 'Packaged Mac Signal did not report the pinned version over private IPC.')
  assert.doesNotMatch(coreStderr, /cannot find module|dlopen.*failed|code signature.*invalid/i)
  core.send({ channel: 'hellodog', type: 'quit' })
  await Promise.race([coreFinished, new Promise(resolve => setTimeout(resolve, 15000))])
  assert.equal(coreExited, true, 'Mac Signal did not gracefully close through its private bridge.')
  assert.equal(coreCode, 0, 'Mac Signal shutdown was unsuccessful.')
  Object.assign(report, { signalPrivateBridgeReady: true, signalVersion: coreReady.version, signalGracefulQuit: true, signalElapsedMs: Date.now() - signalStarted })
} finally {
  if (!coreExited) { core.kill('SIGTERM'); await Promise.race([coreFinished, new Promise(resolve => setTimeout(resolve, 5000))]) }
  if (!coreExited) { core.kill('SIGKILL'); await coreFinished }
}
await writeFile(join(output, 'MAC-SMOKE.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
