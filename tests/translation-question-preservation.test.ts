import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSemanticTranslationMismatch as mismatch } from '../src/shared/translationSemantics.ts'

// Synthetic statements only: these cases exercise a lost question/changed
// speaker, not whether the translator can assess arbitrary semantic quality.
const answeredInsteadOfTranslated = [
  {
    name: 'opinion question replaced by an impersonal Chinese answer',
    source: 'What is your point of view?',
    result: '市场目前充满不确定性，需要谨慎。'
  },
  {
    name: 'market-loss question replaced by an impersonal Chinese answer',
    source: 'What losses have you suffered from today’s market losses?',
    result: '今天的市场下跌确实可能造成很大损失。'
  },
  {
    name: 'opinion question answered with a possessive English statement',
    source: 'What is your point of view?',
    result: 'My opinion is that we should wait.'
  },
  {
    name: 'opinion question answered with an introductory Chinese phrase',
    source: 'What is your point of view?',
    result: '在我看来，我们应该谨慎。'
  },
  {
    name: 'English factual question answered using an unlisted first-person verb',
    source: 'What did you lose today?',
    result: 'I lost five dollars today.'
  },
  {
    name: 'Chinese factual question answered using an unlisted first-person verb',
    source: '你今天亏了多少？',
    result: 'I lost five dollars today.'
  },
  {
    name: 'English yes-no question answered after a yes prefix',
    source: 'Did you lose money today?',
    result: 'Yes, I lost money today.'
  },
  {
    name: 'Chinese yes-no question answered after a yes prefix',
    source: '你今天亏钱了吗？',
    result: 'Yes, I lost money today.'
  },
  {
    name: 'Chinese opinion question becomes an English recommendation',
    source: '你觉得这个计划怎么样？',
    result: 'This plan has several advantages.'
  },
  {
    name: 'English opinion question becomes an English recommendation',
    source: 'What do you think about this plan?',
    result: 'This plan has several advantages.'
  },
  {
    name: 'a new follow-up question does not legitimize an added English answer',
    source: 'What is your point of view?',
    result: 'I think we should wait. What do you think?'
  },
  {
    name: 'a new follow-up question does not legitimize an added Chinese answer',
    source: 'What is your point of view?',
    result: '我认为应该等一等。你怎么看？'
  },
  {
    name: 'question without terminal punctuation still cannot become an answer',
    source: 'What is your point of view',
    result: 'My opinion is that we should wait.'
  },
  {
    name: 'question becomes an assistant commitment without an AI disclaimer',
    source: '你能帮我吗？',
    result: 'Sure, I can help.'
  }
]

for (const { name, source, result } of answeredInsteadOfTranslated) {
  test('question preservation rejects: ' + name, () => {
    assert.equal(mismatch(source, result), true)
  })
}

const faithful = [
  {
    name: 'ordinary English question to Chinese',
    source: 'What is your point of view?',
    result: '你的观点是什么？'
  },
  {
    name: 'Chinese question to English',
    source: '你今天亏了多少？',
    result: 'How much did you lose today?'
  },
  {
    name: 'Chinese question words without terminal punctuation',
    source: 'What is your point of view?',
    result: '你的观点是什么'
  },
  {
    name: 'Chinese interrogative particle without terminal punctuation',
    source: 'Did you lose money today?',
    result: '你今天亏钱了吗'
  },
  {
    name: 'English question syntax without terminal punctuation',
    source: '你今天亏了多少？',
    result: 'How much did you lose today'
  },
  {
    name: 'polite English request naturally rendered as a Chinese request',
    source: 'Could you please send the report?',
    result: '请把报告发给我。'
  },
  {
    name: 'polite can-you request does not need an artificial question mark',
    source: 'Can you pass me the salt?',
    result: '请把盐递给我。'
  },
  {
    name: 'reordered question begins in first person',
    source: 'What do you think I should do?',
    result: '我该怎么办，你觉得呢？'
  },
  {
    name: 'reordered quoted AI identity remains a question',
    source: 'Do you agree that I am not an AI?',
    result: '我不是人工智能，这一点你同意吗？'
  },
  {
    name: 'source already contains an AI identity and an interrogative',
    source: 'As an AI, I have no personal opinions. What do you think?',
    result: '作为人工智能，我没有个人观点。你怎么看？'
  },
  {
    name: 'source already contains a refusal and an interrogative',
    source: 'I cannot answer that question. Can you ask someone else?',
    result: '我无法回答那个问题。你能问别人吗？'
  },
  {
    name: 'quoted AI identity is the subject of the question',
    source: 'What did you mean by “I am an AI”?',
    result: '你说“我是人工智能”是什么意思？'
  },
  {
    name: 'quoted refusal is the subject of the question',
    source: 'Why did you say “I cannot help”?',
    result: '你为什么说“我无法帮助你”？'
  },
  {
    name: 'multiple source sentences may be reordered without losing the question',
    source: 'Are you ready? I think we can start.',
    result: '我认为可以开始了。你准备好了吗？'
  },
  {
    name: 'both clauses of a compound question remain intact',
    source: 'What is your point of view, and what losses did you suffer today?',
    result: '你的观点是什么，今天又遭受了哪些损失？'
  },
  {
    name: 'quoted question in a narrative is not the translator being questioned',
    source: 'She asked, “What is your point of view?” I replied, “We should wait.”',
    result: '她问：“你的观点是什么？”我回答：“我们应该等待。”'
  },
  {
    name: 'French question is not evaluated using absence of English source words',
    source: 'Que pensez-vous de ce projet ?',
    result: '你对这个计划有什么看法？'
  },
  {
    name: 'Spanish original AI statement and question remain valid',
    source: 'Como IA, no tengo opiniones personales. ¿Qué piensas?',
    result: '作为人工智能，我没有个人观点。你怎么看？'
  },
  {
    name: 'Japanese source is outside the English-Chinese lexical guard',
    source: '私はAIなので、個人的な意見はありません。どう思いますか？',
    result: '作为人工智能，我没有个人观点。你怎么看？'
  },
  {
    name: 'English source with a faithful French target without punctuation',
    source: 'What is your point of view',
    result: 'Quel est ton point de vue'
  },
  {
    name: 'Chinese source with a faithful Spanish target',
    source: '你觉得这个计划怎么样？',
    result: '¿Qué opinas de este plan?'
  },
  {
    name: 'English source with a faithful Japanese target',
    source: 'What losses have you suffered from today’s market losses?',
    result: '今日の市場下落でどのような損失を被りましたか？'
  },
  {
    name: 'literal question about translating a quoted question',
    source: 'How would you translate “Are you ready?” into Chinese?',
    result: '你会如何把“Are you ready?”翻译成中文？'
  },
  {
    name: 'Chinese choice question uses haishi rather than a wh-word',
    source: 'Do you want coffee or tea?',
    result: '你喝咖啡还是茶？'
  },
  {
    name: 'Chinese completion question uses meiyou rather than ma',
    source: 'Are you ready?',
    result: '你准备好没有？'
  },
  {
    name: 'Chinese colloquial question uses ganma',
    source: 'Why are you here?',
    result: '你在这里干嘛？'
  },
  {
    name: 'Chinese colloquial question uses sha',
    source: 'What did you say?',
    result: '你说啥？'
  },
  {
    name: 'Chinese colloquial completion question uses mei',
    source: 'Have you eaten?',
    result: '你吃了没？'
  },
  {
    name: 'English declarative word order can retain a spoken question',
    source: 'Have you downloaded your photos?',
    result: 'You have your photos downloaded?'
  },
  {
    name: 'Spanish no is not evidence that the target is English',
    source: 'Are you not coming today?',
    result: 'No vienes hoy?'
  },
  {
    name: 'Polish initial my followed by a diacritic is not English my',
    source: 'Do you think this is a good plan?',
    result: 'Myślisz, że to dobry plan?'
  },
  {
    name: 'single-quoted sentence may precede the question after faithful reordering',
    source: "Do you remember my words, 'Wait here.'?",
    result: '“在这里等着。”你还记得我的话吗？'
  },
  {
    name: 'a semicolon separates a source question from an existing first-person statement',
    source: 'What do you think; I think we should wait?',
    result: '我认为应该等等。你觉得呢？'
  },
  {
    name: 'what introduces a relative statement rather than a question',
    source: 'What you need is rest.',
    result: '你需要休息。'
  },
  {
    name: 'when introduces a condition rather than a question',
    source: 'When you arrive, call me.',
    result: '你到了就给我打电话。'
  },
  {
    name: 'where introduces a relative statement rather than a question',
    source: 'Where you live is beautiful.',
    result: '你住的地方很漂亮。'
  },
  {
    name: 'what-a exclamation is not an information question',
    source: "What a lovely day you're having!",
    result: '你今天过得真开心！'
  },
  {
    name: 'Chinese comma-separated source already includes a first-person statement',
    source: '你怎么看，我觉得应该等等。',
    result: 'I think we should wait. What do you think?'
  }
]

for (const { name, source, result } of faithful) {
  test('question preservation allows: ' + name, () => {
    assert.equal(mismatch(source, result), false)
  })
}
