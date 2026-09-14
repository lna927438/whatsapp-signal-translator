const COMMON: Record<string, string[]> = {
  'en-US': ['the','you','your','are','is','what','why','how','hello','hi','thanks','thank','yes','no','can','will','have','good'],
  'es': ['hola','gracias','que','qué','como','cómo','usted','ustedes','tengo','tienes','estoy','bueno','buenos','porque','por qué','sí'],
  'fr': ['bonjour','merci','vous','tu','comment','pourquoi','avec','être','suis','êtes','oui','non','bien','très','quoi'],
  'de': ['hallo','danke','wie','warum','was','du','sie','ich','bin','ist','sind','gut','ja','nein','bitte'],
  'it': ['ciao','grazie','come','perché','cosa','sono','sei','buono','bene','sì','no','prego'],
  'pt-BR': ['olá','obrigado','obrigada','como','porque','por que','você','vocês','estou','está','bom','bem','sim','não']
}

function wordHits(text: string, words: string[]): number {
  const padded = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  return words.reduce((count, word) => count + (padded.includes(` ${word} `) ? 1 : 0), 0)
}

export interface LanguageEvidence { language?: string; confidence: 'high' | 'low'; reason: 'script' | 'words' | 'mixed' | 'ambiguous' }
export function detectLanguageEvidence(text: string): LanguageEvidence {
  const value = String(text || '').replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/g, ' ').trim()
  const letters = value.match(/\p{L}/gu) || []
  if (letters.length < 2) return { confidence: 'low', reason: 'ambiguous' }
  const scripts: Array<[string, RegExp]> = [['ja', /[\u3040-\u30ff]/g], ['ko', /[\uac00-\ud7af]/g], ['th', /[\u0e00-\u0e7f]/g], ['zh-CN', /[\u3400-\u4dbf\u4e00-\u9fff]/g]]
  for (const [language, pattern] of scripts) {
    const count = value.match(pattern)?.length || 0
    if (count < 2) continue
    const latin = value.match(/[a-z]/gi)?.length || 0
    if (latin > 0 && count < letters.length * .8) return { confidence: 'low', reason: 'mixed' }
    if (language === 'zh-CN' && new Set(value.match(/[的了我你是吗在这不有和请]/g) || []).size < 2) return { confidence:'low', reason:'ambiguous' }
    if (language === 'ja' || count / letters.length > .85) return { language, confidence: 'high', reason: 'script' }
  }
  const candidates = Object.entries(COMMON).map(([language, words]) => ({ language, hits: wordHits(value, words) })).sort((a,b) => b.hits-a.hits)
  const [best, second] = candidates
  // Several distinct words and a clear lead are required; names, abbreviations
  // and shared Romance-language words are delegated to provider auto-detection.
  if (!best || best.hits < 3 || best.hits - second.hits < 2 || second.hits >= 2 || /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\s]/u.test(value)) return { confidence:'low', reason: second?.hits >= 2 ? 'mixed' : 'ambiguous' }
  return { language: best.language, confidence:'high', reason:'words' }
}

export function detectContactLanguage(text: string): string | undefined {
  const evidence = detectLanguageEvidence(text)
  if (evidence.confidence === 'high') return evidence.language
  return undefined
}
