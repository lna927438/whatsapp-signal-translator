import type { TranslationProvider } from './provider'
import type { TranslationRequest } from '../../types'

const targetMap: Record<string, string> = {
  'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', 'en-US': 'EN-US', 'en-GB': 'EN-GB',
  es: 'ES', fr: 'FR', de: 'DE', it: 'IT', 'pt-BR': 'PT-BR', 'pt-PT': 'PT-PT',
  ja: 'JA', ko: 'KO', ru: 'RU', nl: 'NL', pl: 'PL', tr: 'TR'
}

export class DeepLProvider implements TranslationProvider {
  constructor(private readonly apiKey: string) {}

  async translate(request: TranslationRequest): Promise<string> {
    const targetLang = targetMap[request.targetLanguage]
    if (!targetLang) throw new Error(`DeepL does not support configured target language: ${request.targetLanguage}`)
    const body = new URLSearchParams({ text: request.text, target_lang: targetLang, preserve_formatting: '1' })
    const endpoint = this.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate'
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${this.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) throw new Error(`DeepL translation failed: ${response.status} ${await response.text()}`)
    const data = await response.json() as { translations?: Array<{ text: string }> }
    const text = data.translations?.[0]?.text
    if (!text) throw new Error('DeepL translation returned no text')
    return text
  }
}
