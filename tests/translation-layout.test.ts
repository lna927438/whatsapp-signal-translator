import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTranslationLayout } from '../src/shared/translationLayout.ts'

test('single-paragraph translations lose model-added hard breaks without joining words', () => {
  assert.equal(normalizeTranslationLayout('他很年轻，而且已经开始工作。',
    'He was young.\n\nHe had already started working.'), 'He was young. He had already started working.')
  assert.equal(normalizeTranslationLayout('单段原文', 'First\r\n \t \nsecond\u2028third\u2029last'), 'First second third last')
})

test('normalization preserves explicit source line breaks and ordinary spaces verbatim', () => {
  for (const lineBreak of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const output = 'First\n\nsecond'
    assert.equal(normalizeTranslationLayout('第一段' + lineBreak + '第二段', output), output)
  }
  assert.equal(normalizeTranslationLayout('单段原文', 'First  second'), 'First  second')
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
