import type { TranslationRequest } from '../types'
import { SettingsStore } from '../storage/settingsStore'
import { TranslationCache } from './cache'
import { OpenAIProvider } from './providers/openai'
import { DeepLProvider } from './providers/deepl'
import { GoogleProvider } from './providers/google'
import type { TranslationProvider } from './providers/provider'

export class TranslationEngine {
  private readonly settings = new SettingsStore()
  private readonly cache = new TranslationCache()

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim()
    if (!text) return request.text

    const settings = await this.settings.get()
    const source = request.sourceLanguage || 'auto'
    const cached = await this.cache.get(settings.provider, source, request.targetLanguage, text)
    if (cached !== undefined) return cached

    const provider = this.createProvider(settings)
    const translated = await provider.translate({ ...request, text })
    await this.cache.set(settings.provider, source, request.targetLanguage, text, translated)
    return translated
  }

  private createProvider(settings: Awaited<ReturnType<SettingsStore['get']>>): TranslationProvider {
    if (settings.provider === 'openai') {
      if (!settings.openaiApiKey) throw new Error('OpenAI API key is not configured')
      return new OpenAIProvider({ apiKey: settings.openaiApiKey, model: settings.openaiModel || 'gpt-5.6-luna' })
    }
    if (settings.provider === 'deepl') {
      if (!settings.deeplApiKey) throw new Error('DeepL API key is not configured')
      return new DeepLProvider(settings.deeplApiKey)
    }
    if (!settings.googleApiKey) throw new Error('Google Translate API key is not configured')
    return new GoogleProvider(settings.googleApiKey)
  }
}
