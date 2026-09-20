import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const compiled = { exports: {} as typeof import('../src/main/platforms/googleVoice/unread') }
const source = readFileSync(new URL('../src/main/platforms/googleVoice/unread.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
new Function('exports', code)(compiled.exports)
const { GoogleVoiceUnread } = compiled.exports
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002'
const sample = (count: number | null, sequence: number, documentId = A) => ({ source: 'sms-navigation', count, sequence, documentId })

test('exact account snapshots ignore baseline, duplicates, decreases and malformed counts', () => {
  const tracker = new GoogleVoiceUnread()
  assert.deepEqual(tracker.observe('window', sample(3, 1)), { count: 3, increased: false })
  assert.equal(tracker.observe('window', sample(3, 2)), undefined)
  assert.deepEqual(tracker.observe('window', sample(4, 3)), { count: 4, increased: true })
  assert.deepEqual(tracker.observe('window', sample(0, 4)), { count: 0, increased: false })
  for (const count of [-1, 100000, 1.5, NaN, '2', undefined]) assert.equal(tracker.observe('window', { ...sample(0, 5), count }), undefined)
  for (const change of [{ source: 'message-body' }, { sequence: 0 }, { documentId: 'invalid' }]) assert.equal(tracker.observe('window', { ...sample(9, 6), ...change }), undefined)
})

test('new documents establish silent baselines and retired or older reports cannot overwrite them', () => {
  const tracker = new GoogleVoiceUnread()
  tracker.observe('window', sample(1, 1))
  assert.deepEqual(tracker.observe('window', sample(7, 1, B)), { count: 7, increased: false })
  assert.equal(tracker.observe('window', sample(9, 2)), undefined)
  assert.equal(tracker.observe('window', sample(8, 1, B)), undefined)
  assert.deepEqual(tracker.observe('window', sample(8, 2, B)), { count: 8, increased: true })
})

test('unknown counts reset notification baseline, window cleanup is independent and restored documents start silent', () => {
  const tracker = new GoogleVoiceUnread()
  tracker.observe('a', sample(2, 1)); tracker.observe('b', sample(1, 1))
  assert.deepEqual(tracker.observe('a', sample(null, 2)), { count: null, increased: false })
  assert.deepEqual(tracker.observe('a', sample(4, 3)), { count: 4, increased: false })
  tracker.clear('a')
  assert.deepEqual(tracker.observe('a', sample(9, 1)), { count: 9, increased: false })
  assert.deepEqual(tracker.observe('b', sample(2, 2)), { count: 2, increased: true })
  tracker.clear()
  assert.deepEqual(tracker.observe('b', sample(3, 1)), { count: 3, increased: false })
})
