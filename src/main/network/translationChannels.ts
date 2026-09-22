import { cloudBases } from './cloudConnection'
import { channelsFromHealth, translationChannel, type TranslationChannel, type TranslationChannels } from '../../shared/translationChannels'
import { authenticatedFetch, SessionUnavailableError, type TokenSource } from './sessionRefresh'

const cache = new Map<string,{until:number;pending:boolean;work:Promise<TranslationChannels>}>()
export interface TranslationChannelIdentity { owner:string; token:TokenSource; authorized?:()=>boolean }
let currentIdentity:TranslationChannelIdentity|undefined
let revision=0
export function clearTranslationChannels() { cache.clear() }
export function setTranslationChannelIdentity(identity?:TranslationChannelIdentity) {
  if(currentIdentity?.owner!==identity?.owner){revision++;clearTranslationChannels()}
  currentIdentity=identity
}
export function readTranslationChannels(apiBase?:string,force=false,identity=currentIdentity):Promise<TranslationChannels> {
  if(typeof force!=='boolean')throw new Error('通道刷新参数无效。')
  const base=(apiBase || cloudBases()[0]).replace(/\/$/,'')
  const startedRevision=revision
  const assertCurrent=()=>{if(startedRevision!==revision || identity?.authorized?.()===false)throw new SessionUnavailableError('登录状态已变化，请重新检查翻译通道。')}
  assertCurrent()
  const key=JSON.stringify([base,identity?.owner || ''])
  const old=cache.get(key); if(old && (old.pending || (!force && old.until>Date.now())))return old.work
  const entry={until:Date.now()+300000,pending:true,work:Promise.resolve(channelsFromHealth(null))}
  entry.work=(async()=>{
    try {
      let response=identity
        ? await authenticatedFetch(identity.token,base+'/api/translation-channels',{cache:'no-store',redirect:'error'},8000)
        : await fetch(base+'/health',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})
      assertCurrent()
      // Only an older server without this endpoint may use public capability
      // metadata. Authentication failures must never restore old permissions.
      if(identity && [404,405].includes(response.status)){
        await response.body?.cancel().catch(()=>undefined)
        response=await fetch(base+'/health',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})
        assertCurrent()
      }
      const value=channelsFromHealth(response.ok ? await response.json():null)
      if(!response.ok)await response.body?.cancel().catch(()=>undefined)
      assertCurrent()
      if(!value.checked)entry.until=Date.now()+30000
      return value
    } catch(error) {
      assertCurrent()
      if(error instanceof SessionUnavailableError){
        // A successful login refresh for the same owner must be able to retry
        // immediately rather than inheriting a rejected capability promise.
        if(cache.get(key)===entry)cache.delete(key)
        throw error
      }
      entry.until=Date.now()+30000
      const result=channelsFromHealth(null)
      for(const provider of ['deepseek','openai'] as const) result[provider].reason='暂时无法检查通道，请恢复连接后重试。'
      return result
    } finally { entry.pending=false }
  })()
  cache.set(key,entry); return entry.work
}
export async function assertTranslationChannel(value:unknown) {
  const provider=translationChannel(value),channels=await readTranslationChannels()
  if(!channels[provider].available)throw new Error(channels[provider].reason)
  return provider
}
/** Bind at task creation; durable requests must never be rebound on retry. */
export async function requestChannelPreference(selected:TranslationChannel='deepseek'):Promise<TranslationChannel|undefined> {
  if(selected==='openai')return selected
  const channels=await readTranslationChannels()
  if(!channels.checked)throw new Error('暂时无法确认翻译通道，请恢复连接后重试。原消息不会自动切换通道。')
  if(!channels.selectionSupported&&!channels.deepseek.available)throw new Error('当前服务尚不支持选择 DeepSeek 通道，请稍后重试。')
  return channels.selectionSupported ? selected : undefined
}
