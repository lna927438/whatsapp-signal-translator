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

export function detectContactLanguage(text: string): string | undefined {
  const value = String(text || '').trim()
  if (value.length < 2) return undefined
  if (/[\u3040-\u30ff]/.test(value)) return 'ja'
  if (/[\uac00-\ud7af]/.test(value)) return 'ko'
  if (/[\u0e00-\u0e7f]/.test(value)) return 'th'
  if (/[\u0600-\u06ff]/.test(value)) return 'ar'
  if (/[\u0400-\u04ff]/.test(value)) return 'ru'
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(value)) return 'zh-CN'

  let best: { language: string; hits: number } | undefined
  for (const [language, words] of Object.entries(COMMON)) {
    const hits = wordHits(value, words)
    if (!best || hits > best.hits) best = { language, hits }
  }

  // Avoid learning a contact language from ambiguous one-word messages.
  const wordCount = value.split(/\s+/).filter(Boolean).length
  if (!best || best.hits < (wordCount <= 3 ? 2 : 1)) return undefined
  return best.language
}
