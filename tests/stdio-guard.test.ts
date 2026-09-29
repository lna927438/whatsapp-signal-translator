import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Console } from 'node:console'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

type Write = (...args: any[]) => boolean
function stream(write: Write = () => true) {
  return Object.assign(new EventEmitter(), { write, _writableState: { errorEmitted: false } })
}
function harness(stdout = stream(), stderr = stream()) {
  const exports: any = {}
  const source = readFileSync(new URL('../src/main/stdioGuard.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, process: { stdout, stderr, nextTick: process.nextTick.bind(process) } })
  return { stdout, stderr, install: exports.installStdioGuard as (streams?: unknown[]) => void }
}
const pipeError = (code = 'EPIPE') => Object.assign(new Error('fixture closed console'), { code })
const nextTick = () => new Promise<void>(resolve => process.nextTick(resolve))

test('main installs the stdio guard before loading other main-process modules', () => {
  const entry = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /^import '\.\/stdioGuard'\r?\n/)
})

test('healthy writes retain their context, arguments, callbacks and backpressure', () => {
  const calls: unknown[][] = []
  const stdout = stream(function (this: unknown, ...args: any[]) { calls.push([this, ...args]); args.at(-1)(null); return false })
  const h = harness(stdout)
  let callbackCount = 0
  const callback = (error: unknown) => { assert.equal(error, null); callbackCount++ }
  assert.equal(h.stdout.write('fixture output', 'utf8', callback), false)
  assert.deepEqual(calls, [[stdout, 'fixture output', 'utf8', callback]])
  assert.equal(callbackCount, 1)
})

for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
  test(`${code} synchronous writes do not crash and stop writing to that stream`, async () => {
    const error = pipeError(code)
    let attempts = 0
    const stderr = stream(() => { attempts++; throw error })
    const h = harness(stream(), stderr)
    const console = new Console({ stdout: h.stdout as any, stderr: h.stderr as any, ignoreErrors: false })
    assert.doesNotThrow(() => console.error('fixture failure'))
    assert.doesNotThrow(() => console.error('fixture failure again'))
    assert.equal(attempts, 1)
    const errors: unknown[] = []
    assert.equal(stderr.write('fixture explicit write', (value: unknown) => errors.push(value)), true)
    assert.equal(errors.length, 0)
    await nextTick()
    assert.deepEqual(errors, [error])
  })
}

test('asynchronous pipe error events are contained and stdout remains usable', async () => {
  let attempts = 0
  let healthyWrites = 0
  const error = pipeError()
  const stderr = stream((_value, callback) => {
    attempts++
    process.nextTick(() => { callback?.(error); stderr.emit('error', error) })
    return false
  })
  const h = harness(stream(() => { healthyWrites++; return true }), stderr)
  const console = new Console({ stdout: h.stdout as any, stderr: h.stderr as any })
  console.error('fixture rejected IPC')
  await nextTick()
  console.error('fixture later rejected IPC')
  console.log('fixture healthy stdout')
  await nextTick()
  assert.equal(attempts, 1)
  assert.equal(healthyWrites, 1)
})

test('unrelated errors still throw and do not disable subsequent writes', () => {
  const error = Object.assign(new Error('fixture unrelated failure'), { code: 'EIO' })
  let attempts = 0
  const h = harness(stream(() => { attempts++; if (attempts === 1) throw error; return true }))
  assert.throws(() => h.stdout.write('fixture'), value => value === error)
  assert.equal(h.stdout.write('fixture retry'), true)
  assert.throws(() => h.stderr.emit('error', error), value => value === error)
  assert.throws(() => h.stderr.emit('error', new Error('EPIPE appears only in message')), /appears only/)
})

test('existing stream error listeners keep handling unrelated failures', () => {
  const errors: unknown[] = []
  const stdout = stream()
  stdout.on('error', error => errors.push(error))
  const h = harness(stdout)
  const error = Object.assign(new Error('fixture custom error handler'), { code: 'EIO' })
  assert.doesNotThrow(() => h.stdout.emit('error', error))
  assert.deepEqual(errors, [error])
})

test('existing once-listeners retain their normal one-error behavior', () => {
  const errors: unknown[] = []
  const stdout = stream()
  stdout.once('error', error => errors.push(error))
  const h = harness(stdout)
  const error = Object.assign(new Error('fixture one-time handler'), { code: 'EIO' })
  assert.doesNotThrow(() => h.stdout.emit('error', error))
  assert.deepEqual(errors, [error])
  assert.throws(() => h.stdout.emit('error', error), value => value === error)
})

test('reinstalling does not wrap streams or register handlers again', () => {
  const h = harness()
  const stdoutWrite = h.stdout.write
  const stderrWrite = h.stderr.write
  h.install()
  h.install([h.stdout, h.stderr])
  assert.equal(h.stdout.write, stdoutWrite)
  assert.equal(h.stderr.write, stderrWrite)
  assert.equal(h.stdout.listenerCount('error'), 1)
  assert.equal(h.stderr.listenerCount('error'), 1)
})
