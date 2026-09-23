import { test } from 'node:test'
import assert from 'node:assert/strict'
import { protectLiterals } from '../src/shared/translationPolicy.ts'

test('every lossless combination of Markdown underscore escapes preserves the exact protected literal', () => {
  const protectedText = protectLiterals('Call +1 (415) 555-0123')
  const token = protectedText.input.match(/__HDPROTECTED_\d+__/)![0]
  const underscores = [...token].filter(character => character === '_').length
  for (let mask = 0; mask < 1 << underscores; mask++) {
    let index = 0
    const escaped = token.replace(/_/g, () => mask & (1 << index++) ? '\\_' : '_')
    assert.equal(protectedText.restore('请拨打 ' + escaped), '请拨打 +1 (415) 555-0123')
  }
})

test('mixed Markdown escape recovery does not weaken duplicate, token identity, number or URL checks', () => {
  const protectedText = protectLiterals('Call 5551234')
  const escaped = '\\_\\_HDPROTECTED_0\\_\\_'
  assert.throws(() => protectedText.restore(escaped + ' ' + escaped), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore('__HDPROTECTED_0__ ' + escaped), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore('\\_\\_HDPROTECTED_1\\_\\_'), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore('\\_\\_HDPROTECTE_0\\_\\_'), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore(escaped + ' \\_\\_HDPROTECTED_999\\_\\_'), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore(escaped + ' \\_\\_HDPROTECTED_unknown\\_\\_'), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore('\\\\_\\_HDPROTECTED_0\\_\\_'), /protected_literal_mismatch/)
  assert.throws(() => protectedText.restore('5551235'), /protected_literal_mismatch/)
  assert.throws(() => protectLiterals('Open https://example.test/?amount=26').restore('打开 https://example.test/?amount=27'), /protected_literal_mismatch/)
})

test('Markdown token handling preserves surrounding prose and exact values after grammatical reordering', () => {
  const protectedText = protectLiterals('Two prices: 12 dollars and 26 dollars. Open https://example.test/?amount=26')
  const translated = '先打开 \\_\\_HDPROTECTED_2\\_\\_。两个价格分别是 \\_\\_HDPROTECTED_0\\_\\_ 美元和 \\_\\_HDPROTECTED_1\\_\\_ 美元。'
  assert.equal(protectedText.restore(translated), '先打开 https://example.test/?amount=26。两个价格分别是 12 美元和 26 美元。')
})
