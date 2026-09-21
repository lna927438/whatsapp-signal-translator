import { detectLanguageEvidence } from './languageDetection'

// A conservative guard for the specific failure where a translator answers as
// an assistant instead of translating. This is not a general meaning score.
// Match each added claim against the SOURCE (never conversation context): real
// statements and quotations about AI/refusals must remain translatable.
const normalize = (value: string) => value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069]/g, '').toLowerCase()

const assistantClaims = [
  /\b(?:as (?:an? )?(?:ai|artificial intelligence|(?:large )?language model)|i(?: am|'m) (?:just |only )?(?:an? |not an? )?(?:ai|artificial intelligence|(?:large )?language model))\b|(?:作为|身为)(?:一个|一名|一种)?(?:ai|人工智能|(?:大型)?语言模型)|我(?:是|不是|并非)(?:一个|一种)?(?:ai|人工智能|(?:大型)?语言模型)/iu,
  /\bi (?:(?:do not|don't|cannot|can't) (?:have|hold|form|experience)|have no) (?:an? |any |my own )?(?:personal |subjective )?(?:opinions?|views?|points? of view|feelings?|emotions?|experiences?)\b|我(?:并|本身|自己)?(?:不能|不|没有|无法)(?:具有|具备|拥有|持有|形成|体验)?(?:任何|自己的|个人的?|主观的?)?(?:观点|看法|意见|感受|情感|情绪|经历)/iu,
  /\bi (?:do not|don't|cannot|can't|am unable to) (?:personally )?(?:trade|invest|participate in (?:the )?(?:market|trading))\b|我(?:并|本身|自己)?(?:不|无法|不能|不会)(?:会|能)?(?:参与|进行|从事)(?:实际的?|任何)?(?:市场|交易|投资)/iu,
  /\bi(?: (?:cannot|can't|won't|will not|must decline to|(?:won't|will not) be able to|(?:do not|don't) know how to)|(?: am|'m) (?:unable|not able|not allowed|not permitted) to) (?:answer|help|assist|comply|fulfil|fulfill|provide (?:you (?:with )?)?(?:(?:financial|investment|medical|legal|personal) )?advice)\b|我(?:很抱歉[，,]?|很遗憾[，,]?|目前|暂时|并)?(?:无法|不能|没法|不会)(?:直接)?(?:回答|协助|帮助你|满足(?:这个|该|你的)?请求|提供(?:金融|财务|投资|医疗|法律|个人)?建议)/iu,
  /\bi (?:have not|haven't) (?:yet )?(?:learned|learnt) (?:how )?to answer\b|我(?:还|尚)?(?:没有|没)(?:学会|学到)(?:如何)?回答/iu
]

function directQuestion(value: string): boolean {
  return /^(?:["“「『]\s*)?(?:(?:what|why|how|when|where|which|who)\b[^\n.!]{0,220}\b(?:you|your)\b|(?:can|could|would|will|do|did|are|have|has)\s+you\b)/iu.test(value.trim())
    || /^(?:请问[，,]?\s*)?你[^\n。!]{0,160}(?:什么|怎么|如何|多少|哪|吗|么|是否)/u.test(value.trim())
}

function firstPersonAnswer(value: string): boolean {
  const text = value.trim().replace(/^(?:sorry|i'm sorry|对不起|抱歉|很抱歉)[,，:：.!。\s]*/iu, '')
  if (!/^(?:i\s+(?:am|have|do|don['’]t|can|cannot|can['’]t|would|will|think|believe)|i['’](?:m|ve|d|ll)\b|我(?:是|有|没有|不|无法|不能|认为|觉得|会|的(?:观点|看法|意见|损失)(?:是|为)))/iu.test(text)) return false
  // Legitimate reordered questions ("What do you think I should do?" ->
  // "我该怎么办，你觉得呢？") are not evidence of an assistant answer.
  return !/[?？]|(?:什么|怎么|如何|多少|是否|吗|呢)[，。！\s]*$/u.test(text)
}

/** Clear, single questions cannot become an answer. Keep this deliberately
 * limited to English/Chinese, and exclude quotations/multi-sentence sources
 * whose faithful translation may reorder a statement before its question. */
function lostQuestion(source: string, result: string): boolean {
  const original = source.trim()
  if (/["“”「」『』;；]|[.!。！?？]\s*\p{L}|(?:^|[\s,:])'[^']+'|[,，]\s*(?:i\b|我)/iu.test(original)) return false
  const englishQuestion = /^(?:what|why|how|when|where|which|who)\s+(?!a\b|an\b|you\b|your\b)(?:[^.!?\n,;]{0,100}\s)?(?:is|are|was|were|do|does|did|have|has|will|would|can|could)\s+(?:you|your)\b/iu.test(original)
    || /^(?:do|does|did|is|are|was|were|has|have|will)\s+you\b/iu.test(original)
  const chineseQuestion = /^(?:请问[，,]?\s*)?你/u.test(original)
    && /什么|为何|为什么|怎么|如何|多少|哪|是否|[吗呢么][?？。！\s]*$/u.test(original)
  if (!englishQuestion && !chineseQuestion) return false
  const translated = result.trim()
  const letters = translated.match(/\p{L}/gu) || []
  const han = translated.match(/\p{Script=Han}/gu) || []
  const evidence = detectLanguageEvidence(translated)
  const english = evidence.language?.startsWith('en')
    || !evidence.language && !/[^\x00-\x7f]/u.test(letters.join(''))
      && /^(?:i\s|my\s|(?:yes|no|sure)[,\s]+(?:i|we)\s|this\s|that\s|we\s|in my\s|sure[,.!\s]*$)/iu.test(translated)
  if (!(han.length >= 2 && han.length / letters.length > .85) && !english) return false
  const ending = /[.!。！?？]/u.exec(translated)
  const firstSentence = (ending ? translated.slice(0, ending.index) : translated).trim()
  if (ending && /[?？]/u.test(ending[0])) return false
  // Polite questions may be faithfully rendered as requests. A statement that
  // answers then appends its own question must not pass via that later question.
  if (/^(?:请|麻烦|劳驾|please\b)/iu.test(firstSentence)) return false
  return !/什么|为何|为什么|怎么|如何|多少|哪|是否|还是|干嘛|有没有|是不是|能不能|可不可以|好不好|行不行|对不对|[吗呢么]$|没有$/u.test(firstSentence)
    && !/^(?:what|why|how|when|where|which|who|do|does|did|is|are|was|were|has|have|can|could|will|would|should)\b/iu.test(firstSentence)
}

function isTaskEnvelope(value: string): boolean {
  try {
    // A complete JSON code fence is only an output wrapper. Unwrap exactly one
    // whole fence, never extract arbitrary JSON out of a user's prose or code.
    const text = value.trim()
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)
    const record = JSON.parse(fenced ? fenced[1] : text)
    return record !== null && !Array.isArray(record) && typeof record.current_message === 'string'
      && typeof record.source_language === 'string' && typeof record.target_language === 'string' && Array.isArray(record.context)
  } catch { return false }
}

export function isSemanticTranslationMismatch(source: string, translation: string): boolean {
  // The provider may echo or translate the outer task object. Only the inner
  // message is user content; a source that itself is this JSON remains valid.
  if (isTaskEnvelope(translation) && !isTaskEnvelope(source)) return true
  const original = normalize(source), result = normalize(translation)
  if (!original.trim() || !result.trim()) return false
  // Claim equivalence below currently supports English/Chinese only. Absence of
  // an English phrase is NOT evidence that a French/Spanish/Japanese/etc source
  // did not contain it. Unknown and mixed sources therefore fail open here and
  // still receive ordinary script/language/placeholder validation elsewhere.
  const evidence = detectLanguageEvidence(original)
  const language = evidence.language?.split('-')[0]
  if (language && language !== 'en' && language !== 'zh') return false
  if (evidence.confidence !== 'high' && !directQuestion(original)
    && !/^(?:["“「『]\s*)?(?:i(?:\b|'m\b|'ve\b)|you\b|we\b|he\b|she\b|they\b|as (?:an? )?(?:ai|artificial|language|large)\b|tell me\b|please\b|hello\b|hi\b|sorry\b)/iu.test(original.trim())) return false
  if (/\p{Script=Cyrillic}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Arabic}/u.test(original)) return false
  for (const claim of assistantClaims) {
    if (claim.test(result) && !claim.test(original)) return true
  }
  return lostQuestion(original, result) || directQuestion(original) && firstPersonAnswer(result)
}
