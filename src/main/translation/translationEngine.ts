import type { AppSettings, TranslationRequest } from '../types'
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
    const settings = await this.settings.get()
    return this.translateWithSettings(request, settings, true)
  }

  async testWithSettings(settings: AppSettings, request: TranslationRequest): Promise<string> {
    return this.translateWithSettings(request, settings, false)
  }

  private async translateWithSettings(request: TranslationRequest, settings: AppSettings, useCache: boolean): Promise<string> {
    const text = request.text.trim()
    if (!text) return request.text

    const source = request.sourceLanguage || 'auto'
    if (useCache) {
      const cached = await this.cache.get(settings.provider, source, request.targetLanguage, text)
      if (cached !== undefined) return cached
    }

    const provider = this.createProvider(settings)
    const translated = await provider.translate({ ...request, text })

    if (useCache) {
      await this.cache.set(settings.provider, source, request.targetLanguage, text, translated)
    }
    return translated
  }

  private createProvider(settings: AppSettings): TranslationProvider {
    if (settings.provider === 'openai') {
      const apiKey = settings.openaiApiKey?.trim()
      if (!apiKey) throw new Error('OpenAI API key is missing. Add an API Platform key in Translation Settings and test the connection.')
      return new OpenAIProvider({ apiKey, model: settings.openaiModel?.trim() || 'gpt-5.6-luna' })
    }

    if (settings.provider === 'deepl') {
      const apiKey = settings.deeplApiKey?.trim()
      if (!apiKey) throw new Error('DeepL API key is missing. Add a DeepL API key in Translation Settings.')
      return new DeepLProvider(apiKey)
    }

    const apiKey = settings.googleApiKey?.trim()
    if (!apiKey) throw new Error('Google Cloud Translation API key is missing. Add a Google Cloud API key in Translation Settings.')
    return new GoogleProvider(apiKey)
  }
}
