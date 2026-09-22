type Row=Record<string,unknown>
export type ChannelName='openai'|'deepseek'
const object=(value:unknown):value is Row=>Boolean(value&&typeof value==='object'&&!Array.isArray(value))

/** Model identity and availability come from the same current server snapshot. */
export function adminTranslationChannel(data:Row,name:ChannelName,readFailed=false){
  const models=object(data.translationModels)?data.translationModels:{},entry=models[name]
  const model=object(entry)&&typeof entry.model==='string'&&entry.displayName===entry.model
    &&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(entry.model)&&!/^sk-/i.test(entry.model)?entry.model:''
  const providers=data.translationProviders
  const known=Array.isArray(providers)&&providers.every(value=>value==='openai'||value==='deepseek')&&new Set(providers).size===providers.length
  const available=known&&Boolean(model)&&providers.includes(name)
  return {model,available:available&&!readFailed,status:readFailed?'状态待重新确认':!known?'状态尚未取得':available?'已开放选择':'未开放选择',
    isDefault:available&&!readFailed&&data.defaultTranslationProvider===name}
}
