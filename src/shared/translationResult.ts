// Compare display text independently of curly quotes, invisible direction marks,
// punctuation and emoji presentation. A cosmetic change is not a translation.
export function equivalentDisplayText(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    === b.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Conservative evidence: ordinary English sentences cannot be Chinese, etc.
 * Names, links, numbers, emoji and ambiguous short labels remain permissible. */
export function wrongTargetScript(text: string, target: string): boolean {
  const language = target.toLowerCase().split('-')[0]
  const scripts: Record<string, RegExp> = {
    zh: /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    ko: /\p{Script=Hangul}/u, ru: /\p{Script=Cyrillic}/u, uk: /\p{Script=Cyrillic}/u,
    ar: /\p{Script=Arabic}/u, he: /\p{Script=Hebrew}/u, th: /\p{Script=Thai}/u, el: /\p{Script=Greek}/u
  }
  const expected = scripts[language]
  if (!expected) return false
  const value = text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|__HDPROTECTED\w*__/g, ' ')
  if (expected.test(value)) return false
  const words = value.match(/[A-Za-z]+/g) || []
  if (words.length < 2 || words.every(word => /^[A-Z]/.test(word))) return false
  return /\b(you|your|me|my|i|we|our|they|their|the|this|that|is|are|was|were|will|would|should|could|have|has|do|does|did|with|for|from|really)\b/i.test(value)
}

export function reusableDisplayOriginal(original: string | undefined, message: string, localLanguage: string): original is string {
  return original !== undefined && !equivalentDisplayText(original, message) && !wrongTargetScript(original, localLanguage)
}
