import { ref } from 'vue'
import { formatUi, formatUiError, normalizeUiPreference, resolveUiLanguage, type UiLanguage, type UiLanguagePreference } from '../../../shared/uiLocale'
export const uiLanguage = ref<UiLanguage>('zh-CN')
export const uiPreference = ref<UiLanguagePreference>('system')
export function t(key: string, ...values: unknown[]): string { return formatUi(uiLanguage.value, key, ...values) }
export function languageName(language: {name?: string; zhName?: string; code?: string}): string {
  return (uiLanguage.value === 'zh-CN' ? language.zhName : language.name) || language.name || language.code || ''
}
// Call only for interface error/status fields, never for chat text, names or drafts.
export function uiError(value: unknown): string {
  return formatUiError(uiLanguage.value, value)
}
export function applyUiPreference(value: unknown) {
  uiPreference.value = normalizeUiPreference(value)
  uiLanguage.value = resolveUiLanguage(uiPreference.value, navigator.language || 'en')
  document.documentElement.lang = uiLanguage.value
  try { localStorage.setItem('hellodog:ui-language', uiPreference.value) } catch { /* Preferences still apply for this session. */ }
}
export async function initializeUiLanguage() {
  try { applyUiPreference(localStorage.getItem('hellodog:ui-language')) } catch { applyUiPreference('system') }
  // Keep the login screen usable if the settings bridge is unavailable.
  let timer: number | undefined
  try {
    const value = await Promise.race([window.desktopAPI.getUiLanguage(), new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 1500) })])
    if (value !== undefined) applyUiPreference(value)
  } catch { /* Use the last local selection. */ } finally { if (timer) clearTimeout(timer) }
  window.desktopAPI.onUiLanguageChanged?.((value: unknown) => applyUiPreference(value))
}
export async function saveUiLanguage(value: unknown) {
  const selected = normalizeUiPreference(value)
  await window.desktopAPI.setUiLanguage(selected)
  applyUiPreference(selected)
}
