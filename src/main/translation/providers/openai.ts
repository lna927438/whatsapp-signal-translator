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
      : 'the source language automatically detected from the text'

    const instructions = [
      'You are a precise translation engine.',
      `Translate from ${source} into ${target}.`,
      'Preserve the exact meaning, intent, names, numbers, dates, URLs, emojis, punctuation and line breaks.',
      'Do not summarize, embellish, soften, intensify, answer questions, explain, comment, or add quotation marks.',
      'Keep proper nouns unchanged unless there is a standard target-language form.',
      'If the text is already in the target language, return it unchanged.',
      'Return only the translated text.'
    ].join(' ')

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        reasoning: { effort: 'none' },
        instructions,
        input: request.text
      })
    })

    if (!response.ok) throw new Error(`OpenAI translation failed: ${response.status} ${await response.text()}`)
    const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
    const text = data.output_text || data.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text
    if (!text) throw new Error('OpenAI translation returned no text')
    return text.trim()
  }
}
