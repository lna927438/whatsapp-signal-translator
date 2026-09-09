import type { TranslationProvider } from './provider'
import type { TranslationRequest } from '../../types'

const normalize = (code: string): string => code.split('-')[0]

export class GoogleProvider implements TranslationProvider {
  constructor(private readonly apiKey: string) {}

  async translate(request: TranslationRequest): Promise<string> {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.apiKey)}`
    const body: Record<string, string> = { q: request.text, target: normalize(request.targetLanguage), format: 'text' }
    if (request.sourceLanguage && request.sourceLanguage !== 'auto') body.source = normalize(request.sourceLanguage)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`Google translation failed: ${response.status} ${await response.text()}`)
    const data = await response.json() as { data?: { translations?: Array<{ translatedText: string }> } }
    const text = data.data?.translations?.[0]?.translatedText
    if (!text) throw new Error('Google translation returned no text')
    return decodeHtml(text)
  }
}

function decodeHtml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
