import type { TranslationProvider } from './provider'
import type { TranslationRequest } from '../../types'
import { languageName } from '../languages'

interface OpenAIConfig { apiKey: string; model: string }

export class OpenAIProvider implements TranslationProvider {
  constructor(private readonly config: OpenAIConfig) {}

  async translate(request: TranslationRequest): Promise<string> {
    const target = languageName(request.targetLanguage)
    const source = request.sourceLanguage && request.sourceLanguage !== 'auto'
      ? languageName(request.sourceLanguage)
      : 'the source language automatically detected from the current message'

    const instructions = [
      'You are a precise translation engine for real-time private chat messages.',
      `Translate ONLY the CURRENT MESSAGE from ${source} into ${target}.`,
      'Recent messages may be supplied only as context for resolving slang, pronouns, ellipsis, sarcasm, ambiguous short expressions and tone. Never translate, repeat, summarize or answer the context messages.',
      'Preserve the exact meaning, intent, names, numbers, dates, URLs, emojis, punctuation and line breaks of the current message.',
      'Preserve emotional intensity exactly. Never sanitize, euphemize or soften profanity, insults, sexual language, anger, sarcasm, threats or dismissive language. Use the closest natural target-language expression with comparable strength.',
      'Do not intensify language that is not intense in the source.',
      'Do not summarize, embellish, answer questions, explain, comment, moralize, or add quotation marks.',
      'Translate slang, internet expressions, colloquialisms and common abbreviations when they have a clear chat meaning.',
      'Do not treat a word as a proper noun merely because it is short, capitalized, all-caps, or appears alone.',
      'For a one-word or very short message, translate it whenever it is semantically translatable in the recent chat context.',
      'When translating from Chinese, interpret common Chinese internet abbreviations written with Latin letters, such as SB, NMSL, CNM and TMD, by their intended Chinese slang meaning when context supports that reading.',
      'When translating into Chinese, translate common English chat slang such as simp, WTF, idiot, fool, dumbass, asshole, bullshit, cringe, sus and similar expressions into the closest concise Chinese meaning.',
      'Keep genuine proper nouns unchanged unless there is a standard target-language form.',
      'If the current message is already in the target language and is not source-language slang or an abbreviation requiring interpretation, return it unchanged.',
      'Return only the translated CURRENT MESSAGE.'
    ].join(' ')

    const context = (request.context || []).slice(-4)
    const contextualInput = context.length
      ? [
          'RECENT CONTEXT (reference only; do not output):',
          ...context.map((item, index) => `${index + 1}. ${item.role === 'outgoing' ? 'Me' : 'Them'}: ${item.text}`),
          '',
          'CURRENT MESSAGE TO TRANSLATE:',
          request.text
        ].join('\n')
      : request.text

    let response: Response
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          reasoning: { effort: 'none' },
          instructions,
          input: contextualInput,
          store: false,
          max_output_tokens: 4096
        }),
        signal: AbortSignal.timeout(30000)
      })
    } catch (error: any) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('OpenAI API 连接超过 30 秒。请检查网络或代理后重试。')
      }
      throw new Error(`无法连接 OpenAI API：${String(error?.message || error)}`)
    }

    if (!response.ok) {
      const detail = await readApiError(response)
      if (response.status === 401) throw new Error('OpenAI 拒绝了当前 API Key（401）。请检查 Key 是否正确或已被撤销。')
      if (response.status === 429) throw new Error(`OpenAI API 额度不足或触发限流（429）。${detail ? ` ${detail}` : ''}`)
      if (response.status === 404) throw new Error(`当前 API 项目无法使用模型“${this.config.model}”（404）。`)
      if (response.status === 403) throw new Error(`OpenAI API 权限不足（403）。${detail ? ` ${detail}` : ''}`)
      throw new Error(`OpenAI API 请求失败（${response.status}）。${detail ? ` ${detail}` : ''}`)
    }

    const data = await response.json() as {
      output_text?: string
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
    }
    const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text
    if (!text) throw new Error('OpenAI API 请求成功，但没有返回译文。')
    return text.trim()
  }
}

async function readApiError(response: Response): Promise<string> {
  try {
    const raw = await response.text()
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    const message = parsed.error?.message || raw
    return String(message).replace(/\s+/g, ' ').trim().slice(0, 420)
  } catch {
    return ''
  }
}
