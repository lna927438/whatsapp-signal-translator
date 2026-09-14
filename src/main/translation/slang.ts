import type { TranslationRequest } from '../types'

// Only explicit English, stand-alone abbreviations use a local shortcut.
// Ambiguous words (cap, based, NPC, SB, TM), other languages and contextual
// messages go to the provider instead of acquiring an invented meaning/insult.
const ABBREVIATIONS: Record<string, [string, string]> = {
  idk: ['我不知道', '我不知道'],
  brb: ['马上回来', '馬上回來'],
  imo: ['我觉得', '我覺得'],
  imho: ['依我看', '依我看'],
}
export function deterministicChatTranslation(request: TranslationRequest): string | undefined {
  if (!request.sourceLanguage?.startsWith('en') || request.context?.length) return undefined
  if (!['zh-CN', 'zh-TW'].includes(request.targetLanguage)) return undefined
  // Do not strip question marks or concatenate multi-line messages to force a match.
  const key = request.text.trim().toLowerCase()
  return ABBREVIATIONS[key]?.[request.targetLanguage === 'zh-TW' ? 1 : 0]
}
