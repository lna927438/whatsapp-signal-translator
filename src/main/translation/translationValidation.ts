import type { TranslationRequest } from '../types'
import { protectLiterals } from '../../shared/translationPolicy'
import { detectLanguageEvidence } from './languageDetection'

export class TranslationValidationError extends Error {}
export function validateTranslation(request: TranslationRequest, text: string): string {
  if (!text.trim()) throw new TranslationValidationError('译文为空，消息未发送。原文已保留。')
  const required = new Map<string, number>()
  for (const value of protectLiterals(request.text, request.quality).values) required.set(value, (required.get(value) || 0) + 1)
  for (const [literal, count] of required) {
    if (text.split(literal).length - 1 < count) throw new TranslationValidationError('译文中的链接、号码或术语不完整，消息未发送。请修改译文后重试。')
  }
  const evidence = detectLanguageEvidence(text)
  if (evidence.confidence === 'high' && evidence.language?.split('-')[0] !== request.targetLanguage.split('-')[0]) {
    throw new TranslationValidationError('译文语言与目标不符，消息未发送。请修改译文或检查目标语言。')
  }
  return text
}
