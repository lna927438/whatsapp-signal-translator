export interface TranslationQuality {
  tone?: 'natural' | 'business'
  glossary?: Array<{ source: string; target: string }>
}

export function normalizeQuality(value: unknown): TranslationQuality | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('翻译选项格式无效。')
  const input = value as TranslationQuality
  if (input.tone !== undefined && !['natural', 'business'].includes(input.tone)) throw new Error('不支持此翻译语气。')
  if (input.glossary !== undefined && (!Array.isArray(input.glossary) || input.glossary.length > 100)) throw new Error('术语表最多支持 100 条。')
  const glossary = (input.glossary || []).map(item => {
    if (!item || typeof item.source !== 'string' || typeof item.target !== 'string'
      || !item.source.trim() || !item.target.trim() || item.source.length > 120 || item.target.length > 120) throw new Error('术语原文和译文须为 1 至 120 个字符。')
    return { source: item.source.trim(), target: item.target.trim() }
  }).sort((a, b) => a.source.localeCompare(b.source))
  if (new Set(glossary.map(item => item.source)).size !== glossary.length) throw new Error('术语原文不能重复。')
  return input.tone || input.glossary !== undefined ? { ...(input.tone ? { tone: input.tone } : {}), ...(input.glossary !== undefined ? { glossary } : {}) } : undefined
}

export function qualityKey(value?: TranslationQuality): string {
  const quality = normalizeQuality(value)
  return quality && (quality.tone || quality.glossary?.length) ? JSON.stringify(quality) : ''
}
export function mergeQuality(base?: TranslationQuality, account?: TranslationQuality) {
  return normalizeQuality(base || account ? { ...base, ...account, glossary: account?.glossary ?? base?.glossary } : undefined)
}

/** Mask literal data before calling the provider, then require an exact round trip. */
export function protectLiterals(text: string, quality?: TranslationQuality) {
  const glossary = normalizeQuality(quality)?.glossary || []
  let prefix = 'HDPROTECTED'
  while (text.includes(prefix)) prefix += 'X'
  const tokens: Array<{ token: string; value: string }> = []
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const terms = glossary.slice().sort((a, b) => b.source.length - a.source.length)
  const literals = /https?:\/\/[^\s<>"'，。！？；）]+|www\.[^\s<>"'，。！？；）]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d(?:[\d ,.():/\-]*\d)?/g
  const expression = new RegExp(literals.source + (terms.length ? '|' + terms.map(item => escape(item.source)).join('|') : ''), 'g')
  const input = text.replace(expression, value => {
    const token = `__${prefix}_${tokens.length}__`
    tokens.push({ token, value: terms.find(item => item.source === value)?.target || value })
    return token
  })
  return {
    input,
    values: tokens.map(item => item.value),
    restore(output: string): string {
      let result = output
      let restoredLiteral = false
      for (const { token, value } of tokens) {
        // Some providers Markdown-escape underscores or copy the original
        // literal from context. Accept these lossless forms, never a changed
        // number/link, an unknown token, or a duplicated/missing placeholder.
        // Markdown permits escaping each underscore independently. Models may
        // escape only the outer double underscores, or only the inner one.
        // Canonicalize those exact spellings; never loosen the token name/index
        // or repair a changed number, link, or missing token.
        const escapedToken = new RegExp('(?<!\\\\)' + token.split('_').map(escape).join('\\\\?_'), 'g')
        result = result.replace(escapedToken, () => token)
        const count = result.split(token).length - 1
        if (count > 1) throw new Error('protected_literal_mismatch')
        if (count === 1) result = result.replace(token, () => value)
        else restoredLiteral = true
      }
      if (new RegExp('(?:\\\\?_){2}' + escape(prefix) + '\\\\?_').test(result)) throw new Error('protected_literal_mismatch')
      if (restoredLiteral) {
        // Count longest literals first so "1" cannot stand in for "100" or
        // consume part of a URL. This fallback requires the exact multiplicity.
        const expected = new Map<string, number>()
        for (const { value } of tokens) expected.set(value, (expected.get(value) || 0) + 1)
        let remaining = result
        for (const [value, count] of [...expected].sort((a,b) => b[0].length - a[0].length)) {
          const numeric = /^\+?\d/.test(value)
          const pattern = new RegExp((numeric ? '(?<![\\d.])' : '') + escape(value) + (numeric ? '(?![\\d]|[.,]\\d)' : ''), 'g')
          let seen = 0
          remaining = remaining.replace(pattern, () => { seen++; return '\u0000' })
          if (seen !== count) throw new Error('protected_literal_mismatch')
        }
      }
      return result
    }
  }
}
