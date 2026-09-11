export function accountNames(label: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('一次可创建 1 至 20 个窗口。')
  const name = String(label || '').trim().slice(0, 50)
  if (!name) throw new Error('请输入窗口名称。')
  return Array.from({ length: count }, (_, i) => count === 1 ? name : `${name} ${i + 1}`)
}
export function accountTemplate(value: any) {
  return Object.fromEntries(['localLanguage','targetLanguage','receiveAutoTranslate','sendAutoTranslate','blockChineseSend','groupTranslate','fontSize','translationColor','group'].filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
