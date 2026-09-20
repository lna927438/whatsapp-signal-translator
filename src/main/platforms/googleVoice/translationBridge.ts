import { createHash } from 'crypto'
import type { RuntimeSettings, TranslationRequest } from '../../types'
import type { TranslationEngine } from '../../translation/translationEngine'
import type { OutgoingCredit } from '../../translation/outgoingCredit'
import { hasBlockedChinese, alreadyInTargetLanguage } from '../../translation/outgoingPolicy'
import { validateTranslation } from '../../translation/translationValidation'
import { qualityKey } from '../../../shared/translationPolicy'
import type { GoogleVoiceDispatchLedger } from './dispatchLedger'
import { GoogleVoiceDraftRecoveryError, recoverGoogleVoiceDraft } from './draftRecovery'
import { googleVoiceMessageMedia, googleVoiceMediaKey, googleVoiceRecipientContext } from './messageMedia'

type Translator=Pick<TranslationEngine,'history'|'existingOutgoing'|'preserveOutgoingRequest'|'prepareOutgoingRequest'|'preserveIncomingRequest'|'translate'|'cached'|'translateIncoming'>
export function createGoogleVoiceTranslator(translator:Translator,credit:Pick<OutgoingCredit,'check'>,runtime:()=>Promise<RuntimeSettings>,dispatch:GoogleVoiceDispatchLedger) {
  return async(owner:string,accountId:string,operation:string,payload:unknown,authorized:()=>boolean):Promise<unknown>=>{
    const requireIdentity=()=>{if(!authorized())throw new Error('登录状态已变化。')}
    requireIdentity();const preferences=await runtime();requireIdentity()
    if(operation==='status')return {connected:true,localLanguage:preferences.localLanguage,targetLanguage:preferences.targetLanguage,
      receiveAutoTranslate:preferences.receiveAutoTranslate,sendAutoTranslate:preferences.sendAutoTranslate,blockChineseSend:true,historyMode:preferences.historyMode,translationsVisible:preferences.translationsVisible!==false}
    const raw=payload as {id?:unknown;conversationId?:unknown;text?:unknown;direction?:unknown;manual?:unknown;translated?:unknown;requestId?:unknown;recoveryRequestId?:unknown;outcome?:unknown;confirmed?:unknown;attempt?:unknown;media?:unknown;context?:unknown}
    if(!raw || typeof raw.conversationId!=='string' || !/^[\w-]{1,160}$/.test(raw.conversationId))throw new Error('对话无效。')
    const media=googleVoiceMessageMedia(raw.media)
    const context=googleVoiceRecipientContext(raw.context),mediaKey=media?googleVoiceMediaKey(media):undefined
    if((media || context) && raw.direction==='incoming')throw new Error('接收翻译不能包含待发送草稿。')
    // A caption attached to a different image is a different logical draft.
    // Preserve the old namespace exactly for existing text-only receipts.
    const conversationId='google-voice:'+raw.conversationId+(media?':media:'+googleVoiceMediaKey(media):'')
    const validSource=(value:unknown):value is string=>typeof value==='string' && (!!value.trim() || !!media) && !value.includes('\0') && Array.from(value).length<=10000
    const recover=async(known?:{id:string;requestId:string})=>{
      if(!validSource(raw.text))throw new Error('草稿无效。')
      if(media && !raw.text.trim())return undefined
      const history=await translator.history();requireIdentity()
      const attempts=await dispatch.snapshot(owner,accountId,conversationId,authorized);requireIdentity()
      return recoverGoogleVoiceDraft({owner,accountId,conversationId,text:raw.text},history,attempts,known)
    }
    // Called only by the main-owned draft allocator; no browser storage or
    // renderer-supplied identity is used to recover the immutable receipt.
    if(operation==='recover-draft'){
      const restored=await recover()
      return restored?{state:'recovered',id:restored.id,requestId:restored.requestId}:{state:'new'}
    }
    if(operation==='dispatch-status'){
      if(!validSource(raw.text))throw new Error('草稿无效。')
      return dispatch.status(owner,accountId,conversationId,raw.text,authorized,mediaKey)
    }
    if(operation==='dispatch-resolve'){
      if(typeof raw.requestId!=='string' || !/^send-[\w-]{1,150}$/.test(raw.requestId) || !['sent','not-sent'].includes(String(raw.outcome)) || raw.confirmed!==true || !Number.isSafeInteger(raw.attempt) || Number(raw.attempt)<1)throw new Error('请先在官方聊天中核对发送结果。')
      return dispatch.resolve(owner,accountId,conversationId,raw.requestId,Number(raw.attempt),raw.outcome as 'sent'|'not-sent',authorized,mediaKey)
    }
    if(!raw || typeof raw.id!=='string' || !/^[\w-]{1,120}$/.test(raw.id) || typeof raw.conversationId!=='string' || !/^[\w-]{1,160}$/.test(raw.conversationId)
      || !validSource(raw.text) || !['translate','authorize'].includes(operation))throw new Error('翻译请求无效。')
    const fingerprint=createHash('sha256').update(JSON.stringify([owner,accountId,raw.id,conversationId,'outgoing',raw.text,preferences.localLanguage,preferences.targetLanguage,preferences.translationQuality])).digest('hex')
    const plainRequest:TranslationRequest={text:raw.text,accountId,conversationId,messageId:raw.id,requestId:'send-gv-plain-'+fingerprint,
      sourceLanguage:preferences.localLanguage,targetLanguage:preferences.targetLanguage,quality:preferences.translationQuality}
    const plainAllowed=!!media && !raw.text.trim() || !preferences.sendAutoTranslate || alreadyInTargetLanguage(plainRequest)
    if(operation==='authorize'){
      if(typeof raw.requestId!=='string' || !/^send-[\w-]{1,150}$/.test(raw.requestId) || typeof raw.translated!=='string' || raw.translated.length>20000)throw new Error('发送记录无效。')
      if(raw.requestId.startsWith('send-gv-plain-')){
        if(!plainAllowed || raw.requestId!==plainRequest.requestId || raw.translated!==raw.text || hasBlockedChinese(raw.text,preferences.targetLanguage))throw new Error('原文或发送设置已变化，已阻止发送。')
        requireIdentity()
        return dispatch.reserve(owner,accountId,conversationId,raw.requestId,raw.text,raw.text,authorized,undefined,!!context,mediaKey)
      }
      // TranslationEngine persists source text after trim(). Verify that exact
      // canonical receipt while retaining the untouched editor text below for
      // dispatch hashes and the preload's final draft comparison.
      const original=await translator.existingOutgoing(raw.requestId,accountId,conversationId,raw.text.trim(),raw.translated)
      if(original.messageId!==raw.id)throw new Error('译文回执不属于本条短信。')
      if(!preferences.sendAutoTranslate || original.targetLanguage!==preferences.targetLanguage || qualityKey(original.quality)!==qualityKey(preferences.translationQuality))throw new Error('翻译设置已变化，请重新核对译文。')
      requireIdentity();if(hasBlockedChinese(raw.translated,original.targetLanguage))throw new Error('译文仍含中文，已阻止发送。')
      validateTranslation(original,raw.translated);await credit.check(owner,original,true,true);requireIdentity()
      return dispatch.reserve(owner,accountId,conversationId,raw.requestId,raw.text,raw.translated,authorized,
        raw.recoveryRequestId===undefined?undefined:createHash('sha256').update(raw.text.trim()).digest('hex'),!!context,mediaKey)
    }
    if(!['incoming','outgoing'].includes(String(raw.direction)))throw new Error('翻译方向无效。')
    const outgoing=raw.direction==='outgoing'
    if(outgoing && (await dispatch.status(owner,accountId,conversationId,raw.text,authorized,mediaKey)).state==='uncertain')throw new Error('此短信的发送结果待确认，请先核对，不能重新翻译扣费。')
    requireIdentity()
    let restored:TranslationRequest|undefined
    if(outgoing && raw.recoveryRequestId!==undefined){
      if(typeof raw.recoveryRequestId!=='string' || !/^send-(?:gv|retry)-[a-f0-9]{64}$/.test(raw.recoveryRequestId))throw new GoogleVoiceDraftRecoveryError('incomplete')
      restored=(await recover({id:raw.id,requestId:raw.recoveryRequestId}))!.request
      if(!preferences.sendAutoTranslate || restored.targetLanguage!==preferences.targetLanguage || qualityKey(restored.quality)!==qualityKey(preferences.translationQuality))throw new GoogleVoiceDraftRecoveryError('settings')
    }
    if(outgoing && plainAllowed && !restored){
      if(hasBlockedChinese(raw.text,preferences.targetLanguage))throw new Error('请开启发送翻译，中文原文已阻止发送。')
      return {enabled:true,text:raw.text,requestId:plainRequest.requestId,untranslated:true,...(media?{media}:{})}
    }
    const requestId=(outgoing?'send-gv-':'gv-')+createHash('sha256').update(JSON.stringify([owner,accountId,raw.id,conversationId,raw.direction,raw.text,preferences.localLanguage,preferences.targetLanguage,preferences.translationQuality])).digest('hex')
    let request:TranslationRequest={text:raw.text,accountId,conversationId,messageId:raw.id,requestId,
      sourceLanguage:outgoing?preferences.localLanguage:'auto',targetLanguage:outgoing?preferences.targetLanguage:preferences.localLanguage,quality:preferences.translationQuality}
    request=restored || (outgoing?await translator.preserveOutgoingRequest(request):await translator.preserveIncomingRequest(request))
    requireIdentity()
    if(outgoing){
      request=await translator.prepareOutgoingRequest(request);requireIdentity()
      await credit.check(owner,request,true);requireIdentity()
      const text=await translator.translate(request);requireIdentity()
      if(hasBlockedChinese(text,request.targetLanguage))throw new Error('译文仍含中文，已阻止发送。')
      validateTranslation(request,text);await credit.check(owner,request,true,true);requireIdentity()
      return {enabled:true,text,requestId:request.requestId,...(media?{media}:{})}
    }
    if(preferences.translationsVisible===false && raw.manual!==true)return {enabled:false}
    let text=await translator.cached(request);requireIdentity()
    // Until a live DOM adapter supplies verified message timestamps, historical
    // auto translation is allowed only under the explicit visible-history mode.
    if(text===undefined && (raw.manual===true || preferences.receiveAutoTranslate && preferences.historyMode==='visible')) text=await translator.translateIncoming(request,raw.manual===true)
    requireIdentity();return {enabled:text!==undefined,text,manual:text===undefined,requestId:request.requestId}
  }
}
