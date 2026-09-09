import type { TranslationRequest } from '../../types'

export interface TranslationProvider {
  translate(request: TranslationRequest): Promise<string>
}
