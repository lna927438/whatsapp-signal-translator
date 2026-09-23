const hardBreak = /[\r\n\u2028\u2029]/u

/** A translator must not turn a single-paragraph message into several
 * paragraphs. Keep deliberate source line breaks intact; visual wrapping is
 * still handled normally by the chat bubble. Do not alter the original text
 * or any persisted billing identity. */
export function normalizeTranslationLayout(source: string, result: string, protectedValues: readonly string[] = []): string {
  if (hardBreak.test(source) || !hardBreak.test(result)) return result
  const collapse = (part: string) => part.replace(/[\t \u00a0]*[\r\n\u2028\u2029]+[\t \u00a0\r\n\u2028\u2029]*/gu, ' ')
  // A user's explicit glossary value is literal data, including its layout.
  // Keep it exact so a paid result also passes the client's final send check.
  const multiline = [...new Set(protectedValues.filter(value => hardBreak.test(value)))].sort((a, b) => b.length - a.length)
  if (!multiline.length) return collapse(result).trim()
  const pattern = new RegExp('(' + multiline.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gu')
  return result.split(pattern).map((part, index) => index % 2 ? part : collapse(part)).join('').trim()
}
