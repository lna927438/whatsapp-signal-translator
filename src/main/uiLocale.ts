import { app } from 'electron'
import { formatUi, resolveUiLanguage, type UiLanguage } from '../shared/uiLocale'
let language: UiLanguage = 'zh-CN'
const listeners = new Set<() => void>()
export function setMainUiLanguage(value: unknown) {
  const next = resolveUiLanguage(value, app.getLocale?.() || 'zh-CN')
  if (next === language) return
  language = next
  for (const listener of listeners) listener()
}
export function onUiLanguageChanged(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }
export function t(key: string, ...values: unknown[]) { return formatUi(language, key, ...values) }
