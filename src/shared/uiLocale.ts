import { uiEnglish } from './uiEnglish'
import { uiEnglishExtra } from './uiEnglishExtra'
export type UiLanguage = 'en' | 'zh-CN'
export type UiLanguagePreference = UiLanguage | 'system'
export function normalizeUiPreference(value: unknown): UiLanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'system'
}
export function resolveUiLanguage(value: unknown, system: string): UiLanguage {
  const preference = normalizeUiPreference(value)
  return preference === 'system' ? (/^zh\b/i.test(system) ? 'zh-CN' : 'en') : preference
}
export function formatUi(language: UiLanguage, key: string, ...values: unknown[]): string {
  const pattern = language === 'en' ? (uiEnglishExtra[key] ?? uiEnglish[key] ?? key) : key
  // Substitution is one pass: values cannot become additional placeholders or markup.
  return pattern.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : token)
}
export function formatUiError(language: UiLanguage, value: unknown): string {
  const message = String(value || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  return formatUi(language, message)
}
