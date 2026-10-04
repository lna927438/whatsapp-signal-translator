const hardBreak = /[\r\n\u2028\u2029]/u
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Source-authored separators travel as immutable placeholders. Unlike asking
 * a model to count lines, this makes missing/reordered separators detectable
 * before settlement. The original source/request fingerprint is unchanged. */
export function protectTranslationLayout(source: string) {
  let prefix = 'HDLAYOUT'
  while (source.includes(prefix)) prefix += 'X'
  const values: Array<{ token: string; value: string }> = []
  const input = source.replace(/[\t \u00a0]*(?:\r\n|[\r\n\u2028\u2029])(?:[\t \u00a0]*(?:\r\n|[\r\n\u2028\u2029]))*[\t \u00a0]*|[\t\u00a0]+| {2,}/gu, value => {
    const token = `__${prefix}_${values.length}__`
    values.push({ token, value })
    return token
  })
  return {
    input,
    restore(output: string): string {
      let result = output, position = -1
      for (const { token } of values) {
        const escapedToken = new RegExp('(?<!\\\\)' + token.split('_').map(escape).join('\\\\?_'), 'g')
        result = result.replace(escapedToken, () => token)
        const at = result.indexOf(token)
        if (at <= position || at < 0 || result.indexOf(token, at + token.length) !== -1) throw new Error('protected_literal_mismatch')
        position = at
      }
      for (const { token, value } of values) result = result.replace(new RegExp('[\\t \\u00a0]*' + escape(token) + '[\\t \\u00a0]*', 'u'), () => value)
      if (new RegExp('(?:\\\\?_){2}' + escape(prefix) + '\\\\?_').test(result)) throw new Error('protected_literal_mismatch')
      return result
    }
  }
}

/** A translator must not turn a single-paragraph message into several
 * paragraphs. Keep deliberate source line breaks intact; visual wrapping is
 * still handled normally by the chat bubble. Do not alter the original text
 * or any persisted billing identity. */
export function normalizeTranslationLayout(source: string, result: string, protectedValues: readonly string[] = []): string {
  if (hardBreak.test(source)) return result
  // Compact model-added whitespace, but keep intentional source spacing and
  // literal values (telephone numbers, URLs, glossary entries) untouched.
  const deliberateSpacing = /[\t\u00a0]| {2,}/u.test(source)
  const collapse = (part: string) => {
    const singleLine = part.replace(/[\t \u00a0]*[\r\n\u2028\u2029]+[\t \u00a0\r\n\u2028\u2029]*/gu, ' ')
    return deliberateSpacing ? singleLine : singleLine.replace(/[\t \u00a0]+/gu, ' ')
  }
  // A user's explicit glossary value is literal data, including its layout.
  // Keep it exact so a paid result also passes the client's final send check.
  const literals = [...new Set(protectedValues.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!literals.length) return collapse(result).trim()
  const pattern = new RegExp('(' + literals.map(escape).join('|') + ')', 'gu')
  return result.split(pattern).map((part, index) => index % 2 ? part : collapse(part)).join('').trim()
}
