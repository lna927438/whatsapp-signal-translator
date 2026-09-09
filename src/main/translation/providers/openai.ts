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
      'You are a precise translation engine for real-time private chat messages.',
      `Translate from ${source} into ${target}.`,
      'Preserve the exact meaning, intent, names, numbers, dates, URLs, emojis, punctuation and line breaks.',
      'Do not summarize, embellish, soften, intensify, answer questions, explain, comment, or add quotation marks.',
      'Translate slang, insults, internet expressions, colloquialisms and common abbreviations when they have a clear established meaning.',
      'Do not treat a word as a proper noun merely because it is short, capitalized, or appears alone.',
      'For a one-word or very short message, translate it whenever it is semantically translatable.',
      'When translating from Chinese, interpret common Chinese internet abbreviations written with Latin letters (for example SB when clearly used as Chinese slang) by their intended Chinese meaning instead of blindly preserving the letters.',
      'When translating into Chinese, render common English chat slang such as simp, idiot, fool, WTF and similar expressions into the closest concise Chinese meaning when context makes the meaning clear.',
      'Keep genuine proper nouns unchanged unless there is a standard target-language form.',
      'If the text is already in the target language and is not a source-language slang abbreviation, return it unchanged.',
      'Return only the translated text.'
    ].join(' ')

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
          input: request.text,
          store: false,
          max_output_tokens: 4096
        }),
        signal: AbortSignal.timeout(30000)
      })
    } catch (error: any) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('OpenAI API connection timed out after 30 seconds. Check your network or proxy and try again.')
      }
      throw new Error(`Could not connect to OpenAI API: ${String(error?.message || error)}`)
    }

    if (!response.ok) {
      const detail = await readApiError(response)
      if (response.status === 401) {
        throw new Error('OpenAI rejected this API key (401). Check that the key was copied from the OpenAI API Platform and has not been revoked.')
      }
      if (response.status === 429) {
        throw new Error(`OpenAI API quota or rate limit reached (429). API billing is separate from ChatGPT subscriptions.${detail ? ` ${detail}` : ''}`)
      }
      if (response.status === 404) {
        throw new Error(`OpenAI model "${this.config.model}" is not available to this API project (404). Try gpt-5.6-luna or check the API project's model access.`)
      }
      if (response.status === 403) {
        throw new Error(`OpenAI API permission denied (403). Check the API project's permissions and organization settings.${detail ? ` ${detail}` : ''}`)
      }
      throw new Error(`OpenAI API request failed (${response.status}).${detail ? ` ${detail}` : ''}`)
    }

    const data = await response.json() as {
      output_text?: string
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
    }
    const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text
    if (!text) throw new Error('OpenAI API succeeded but returned no translated text.')
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
