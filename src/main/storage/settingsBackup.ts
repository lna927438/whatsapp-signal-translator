import { normalizeQuality } from '../../shared/translationPolicy'
const booleanFields = ['receiveAutoTranslate','sendAutoTranslate','blockChineseSend','groupTranslate','translationsVisible','previewSend','backTranslation','notificationSound','hideNotificationNames','autoStart','startMinimized','closeToTray']
const stringFields = ['localLanguage','targetLanguage','translationColor']
const enums: Record<string, string[]> = { translationProvider:['deepseek','openai'], workspaceTheme:['charcoal','soft'], accountNavigationPosition:['top','side'], uiLanguage:['system','en','zh-CN'], historyMode: ['new','manual','visible'], notifications: ['off','background','always'], cloudRoute: ['auto','primary','backup'], updateChannel: ['stable','beta'] }
export function portableSettings(input: any): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置备份格式无效。')
  const out: Record<string, any> = {}
  for (const key of booleanFields) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw new Error('设置值无效。'); out[key] = input[key] }
  for (const key of stringFields) if (input[key] !== undefined) { if (typeof input[key] !== 'string' || input[key].length > 40) throw new Error('设置值无效。'); out[key] = input[key] }
  for (const [key, values] of Object.entries(enums)) if (input[key] !== undefined) { if (!values.includes(input[key])) throw new Error('设置选项无效。'); out[key] = input[key] }
  if (input.fontSize !== undefined) { if (!Number.isInteger(input.fontSize) || input.fontSize < 10 || input.fontSize > 24) throw new Error('字号无效。'); out.fontSize = input.fontSize }
  if (input.translationQuality) out.translationQuality = normalizeQuality(input.translationQuality)
  if (input.quickReplies !== undefined) {
    if (!Array.isArray(input.quickReplies) || input.quickReplies.length > 30 || input.quickReplies.some((x: unknown) => typeof x !== 'string' || x.length > 2000)) throw new Error('快捷回复格式无效。')
    out.quickReplies = [...input.quickReplies]
  }
  return out
}
export function makeSettingsBackup(settings: unknown) {
  return { kind: 'HelloDog-settings', schemaVersion: 1, createdAt: new Date().toISOString(), settings: portableSettings(settings) }
}
export function parseSettingsBackup(text: string) {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('备份文件过大。')
  let value: any
  try { value = JSON.parse(text) } catch { throw new Error('备份文件已损坏。') }
  if (value?.kind !== 'HelloDog-settings' || value.schemaVersion !== 1) throw new Error('不支持此备份版本。')
  return makeSettingsBackup(value.settings)
}
