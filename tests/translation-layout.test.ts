import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTranslationLayout, protectTranslationLayout } from '../src/shared/translationLayout.ts'

test('single-paragraph translations lose model-added hard breaks without joining words', () => {
  assert.equal(normalizeTranslationLayout('他很年轻，而且已经开始工作。',
    'He was young.\n\nHe had already started working.'), 'He was young. He had already started working.')
  assert.equal(normalizeTranslationLayout('单段原文', 'First\r\n \t \nsecond\u2028third\u2029last'), 'First second third last')
})

test('legacy multiline text stays intact and invented horizontal spacing is compacted', () => {
  for (const lineBreak of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const output = 'First\n\nsecond'
    assert.equal(normalizeTranslationLayout('第一段' + lineBreak + '第二段', output), output)
  }
  assert.equal(normalizeTranslationLayout('单段原文', 'First  second\t\u00a0third'), 'First second third')
  assert.equal(normalizeTranslationLayout('第一项  第二项', 'First  second'), 'First  second')
})

test('new outgoing translations restore exact authored line breaks and spacing, never model-added paragraphs', () => {
  for (const separator of ['\n', '\n\n', '\r\n', '\r', '\u2028', '\u2029', '\n  ', '  ', '\t']) {
    const protectedText = protectTranslationLayout('第一项' + separator + '第二项')
    const token = protectedText.input.match(/__HDLAYOUT_\d+__/)![0]
    const raw = 'First item  \n\n ' + token + '  Second item'
    const single = normalizeTranslationLayout(protectedText.input, raw)
    assert.equal(protectedText.restore(single), 'First item' + separator + 'Second item')
  }
})

test('missing duplicated reordered or unknown layout markers fail closed', () => {
  const layout = protectTranslationLayout('甲\n乙\n丙')
  for (const invalid of ['A B C', 'A __HDLAYOUT_0__ B __HDLAYOUT_0__ C', 'A __HDLAYOUT_1__ B __HDLAYOUT_0__ C',
    'A __HDLAYOUT_0__ B __HDLAYOUT_1__ C __HDLAYOUT_99__']) {
    assert.throws(() => layout.restore(invalid), /protected_literal_mismatch/)
  }
  assert.equal(layout.restore('A \\_\\_HDLAYOUT\\_0\\_\\_ B __HDLAYOUT_1__ C'), 'A\nB\nC')
})

test('compact layout preserves literal numbers and glossary whitespace exactly', () => {
  const literal = '+44  1234  5678', glossary = 'First  Name'
  assert.equal(normalizeTranslationLayout('联系联系人和电话', 'Contact   ' + glossary + '  at ' + literal + '.\n\nThanks.', [literal, glossary]),
    'Contact ' + glossary + ' at ' + literal + '. Thanks.')
})

test('line-break repair preserves URLs, numbers, emoji and punctuation', () => {
  assert.equal(normalizeTranslationLayout('请打开 https://example.test/a?b=1，票价 26.50 美元 😂',
    'Open https://example.test/a?b=1.\nThe price is $26.50. 😂'),
  'Open https://example.test/a?b=1. The price is $26.50. 😂')
})

test('user-authored multiline glossary literals retain exact layout while model-added paragraphs collapse', () => {
  const literal = 'First [name]\nSecond (name)'
  assert.equal(normalizeTranslationLayout('请告知联系人，稍后见。', 'Contact ' + literal + '.\n\nSee you later.', [literal]),
    'Contact ' + literal + '. See you later.')
})
