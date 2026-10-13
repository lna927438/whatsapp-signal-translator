import type { TranslationRequest } from '../types'
import { qualityKey } from '../../shared/translationPolicy'
import { detectLanguageEvidence } from './languageDetection'

// A conservative shortcut for ordinary English chat. Latin letters alone do
// not prove English: ambiguous names and other languages still reach the API.
const ENGLISH = new Set('the you your are is what why how hello hi thanks thank yes can will have good this that with for from was were would should could about think know really please sorry'.split(' '))
const OTHER = /\b(hola|gracias|usted|estoy|tengo|bonjour|merci|vous|suis|avec|danke|warum|ich|bin|ciao|grazie|sono|obrigado|voce|estou)\b/i
export function alreadyInTargetLanguage(request: TranslationRequest): boolean {
  if (qualityKey(request.quality)) return false
  if (!/^en(?:-|$)/i.test(request.targetLanguage)) {
    const evidence = detectLanguageEvidence(request.text)
    return evidence.confidence === 'high' && evidence.language?.split('-')[0] === request.targetLanguage.split('-')[0]
  }
  const text = request.text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/g, ' ').trim()
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\s]/u.test(text) || /[^\x00-\x7f]/.test(text.replace(/[^\p{L}]/gu, '')) || OTHER.test(text)) return false
  const words = text.toLowerCase().match(/[a-z]+/g) || []
  if (words.length <= 3) return /^(hello|hi|hey|thanks|thank you|good morning|good night|good evening|yes|no|okay|ok)[.!?\s]*$/i.test(text)
  return new Set(words.filter(word => ENGLISH.has(word))).size >= 3
}

export function hasBlockedChinese(text: string, targetLanguage: string): boolean {
  // Chinese and Japanese are valid requested targets, even with this guard on.
  return !/^(zh|ja)(?:-|$)/i.test(targetLanguage) && /\p{Script=Han}/u.test(text)
}

/** The user's send switch is stricter than language validation: no Han may
 * leave while enabled, including names, captions and Chinese/Japanese targets.
 * Keep this self-contained because the web send guards serialize it. */
export function blocksChineseSend(text: string, enabled = true): boolean {
  return enabled !== false && /\p{Script=Han}/u.test(text)
}

export function chineseOriginalPassThrough(text: string, blockChineseSend: boolean): boolean {
  return blockChineseSend === false && /\p{Script=Han}/u.test(text)
}

export function shouldTranslateOutgoing(text: string, preferences: { sendAutoTranslate: boolean; blockChineseSend: boolean }): boolean {
  return preferences.sendAutoTranslate && !chineseOriginalPassThrough(text, preferences.blockChineseSend)
}

export function assertOutgoingSendPolicy(original: string, output: string, expectedBlock: boolean, currentBlock: boolean): void {
  if ((expectedBlock !== false) !== (currentBlock !== false)) throw new Error('中文发送设置已变化，原稿已保留，请重新发送。')
  if (blocksChineseSend(output, currentBlock)) throw new Error('结果仍包含中文，已阻止发送并保留草稿。')
  if (chineseOriginalPassThrough(original, currentBlock) && output !== original) throw new Error('已关闭禁止发送中文，请重新发送原文。')
}
