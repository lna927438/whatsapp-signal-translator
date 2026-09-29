// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';
import './hellodog.focus.preload.ts';
import type { MessageModel } from '../models/messages.preload.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import { SocketStatus } from '../types/SocketStatus.std.ts';
import { conversationJobQueue } from '../jobs/conversationJobQueue.preload.ts';
import { refreshHelloDogPage } from './hellodog.recovery.preload.ts';
import { flushHelloDogDrafts } from '../state/ducks/composer.preload.ts';
import { checkSockets } from '../textsecure/WebAPI.preload.ts';
import { RecordingState } from '../types/AudioRecorder.std.ts';
import type { QuickReplyDetail } from './hellodog.quick-reply.dom.ts';
import { getSelectedConversationId } from '../state/selectors/nav.std.ts';
import { startHelloDogVoiceMessages } from './hellodog.voice.preload.ts';

const enabled = process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1';
type Translation = { original: string; translated: string; requestId: string };
const extensions = (message: MessageModel) => message.attributes as typeof message.attributes & { helloDogTranslation?: Translation; helloDogEditTranslations?: Record<string,Translation> };
export function translatedBodyRanges<T extends {start?:number;length?:number}>(ranges:ReadonlyArray<T>,original:string,translated:string):Array<T> {
  return ranges.flatMap(range=>{
    const start=range.start||0,length=range.length||0,fragment=original.slice(start,start+length);
    if('mentionAci' in range){
      if(fragment!=='\ufffc')throw new Error('Mention position changed');
      const occurrence=original.slice(0,start).split('\ufffc').length-1;
      let offset=-1;for(let n=0;n<=occurrence;n++){offset=translated.indexOf('\ufffc',offset+1);if(offset<0)throw new Error('Mention missing from translation');}
      if(offset<0)throw new Error('Mention missing from translation');
      return [{...range,start:offset,length:1}];
    }
    if(start===0&&length===original.length)return [{...range,start:0,length:translated.length}];
    const offset=fragment?translated.indexOf(fragment):-1;
    // Retain formatting only where its text can be identified. Do not apply old
    // offsets to unrelated translated words or split a surrogate pair.
    return offset>=0&&translated.indexOf(fragment,offset+fragment.length)<0?[{...range,start:offset,length:fragment.length}]:[];
  });
}
const deadline = (message: MessageModel): number | undefined => {
  const start = message.get('expirationStartTimestamp'), seconds = message.get('expireTimer');
  return start && seconds ? start + seconds * 1000 : undefined;
};

/** A lost IPC reply must not retain a display slot or a native send job forever.
 * Late replies settle only their original promise and never rewrite a message. */
function requestHelloDogTranslation(request: Record<string, unknown>): Promise<any> {
  const work = ipcRenderer.invoke('hellodog:translate', request);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('翻译响应超时，原消息已保留，可稍后重试。')), 45000);
    work.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Runs inside Signal's persisted send job, before encryption/upload. The same
 * Signal message ID is reused on retries. The native send queue remains owner of
 * delivery and attachments; HelloDog supplies only translated text. */
export async function translateHelloDogMessage(message: MessageModel, conversation: ConversationModel, editTimestamp?: number): Promise<void> {
  if (!enabled) return;
  const prior=extensions(message), edit=editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp):undefined;
  if(editTimestamp&&!edit)throw new Error('Edited message unavailable');
  const saved = editTimestamp?prior.helloDogEditTranslations?.[String(editTimestamp)]:prior.helloDogTranslation;
  const original = (edit?edit.body:message.get('body')) || '';
  if (saved && saved.translated === original) {
    const approval = await requestHelloDogTranslation({ id:message.id,editTimestamp,conversationId:conversation.id,text:saved.original,
      translated:saved.translated,requestId:saved.requestId,authorizationOnly:true,direction:'outgoing',expiresAt:deadline(message) });
    if (approval?.authorized !== true) throw new Error('发送权限尚未确认，原消息已保留。');
    if ((editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body')) !== original
      || message.get('isErased') || message.get('deletedForEveryone') || (deadline(message) ?? Infinity) <= Date.now()) throw new Error('Message changed during send authorization');
    if (approval.requestId !== saved.requestId || typeof approval.text !== 'string' || !approval.text.trim()) throw new Error('发送权限尚未确认，原消息已保留。');
    if (approval.text !== original) {
      // A retry may adopt a free receipt correction only before any recipient
      // received this revision. Never rewrite sent history under the same ID.
      const states=editTimestamp?edit?.sendStateByConversationId:message.get('sendStateByConversationId');
      if(Object.values(states||{}).some(state=>['Sent','Delivered','Read','Viewed'].includes(state.status))) throw new Error('此消息已发送或部分发送，不能替换正文。请核对原消息后单独发送修正。');
      const bodyRanges=translatedBodyRanges((edit?edit.bodyRanges:message.get('bodyRanges'))||[],original,approval.text);
      const extra:Translation={...saved,translated:approval.text};
      const before={body:message.get('body'),bodyRanges:message.get('bodyRanges'),editHistory:message.get('editHistory'),helloDogTranslation:prior.helloDogTranslation,helloDogEditTranslations:prior.helloDogEditTranslations};
      const mainEditTimestamp=message.get('editMessageTimestamp');
      const currentEdit=!editTimestamp||!message.get('editMessageTimestamp')||message.get('editMessageTimestamp')===editTimestamp;
      message.set({...(currentEdit?{body:approval.text,bodyRanges,helloDogTranslation:extra}:{}),...(editTimestamp?{editHistory:message.get('editHistory')?.map(item=>item.timestamp===editTimestamp?{...item,body:approval.text,bodyRanges}:item),helloDogEditTranslations:{...prior.helloDogEditTranslations,[editTimestamp]:extra}}:{})} as any);
      const restoreOwnText=()=>{
        const current=extensions(message),currentHistory=message.get('editHistory');
        if(message.get('isErased')||message.get('deletedForEveryone')
          ||(editTimestamp?currentHistory?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body'))!==approval.text
          ||(editTimestamp?current.helloDogEditTranslations?.[editTimestamp]:current.helloDogTranslation)!==extra)return false;
        // Restore only our text/annotation. A receipt or newer edit may have
        // advanced other attributes while persistence was awaiting disk.
        message.set({...(currentEdit&&message.get('editMessageTimestamp')===mainEditTimestamp&&message.get('body')===approval.text&&current.helloDogTranslation===extra
          ?{body:before.body,bodyRanges:before.bodyRanges,helloDogTranslation:before.helloDogTranslation}:{}),
          ...(editTimestamp?{editHistory:currentHistory?.map(item=>item.timestamp===editTimestamp?{...item,body:edit?.body,bodyRanges:edit?.bodyRanges}:item),helloDogEditTranslations:{...current.helloDogEditTranslations,[editTimestamp]:saved}}:{})} as any);
        return true;
      };
      try { await window.MessageCache.saveMessage(message); }
      catch(error) { restoreOwnText();throw error; }
      const latestStates=editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp)?.sendStateByConversationId:message.get('sendStateByConversationId');
      if(Object.values(latestStates||{}).some(state=>['Sent','Delivered','Read','Viewed'].includes(state.status))){
        if(restoreOwnText())await window.MessageCache.saveMessage(message);
        throw new Error('此消息已发送或部分发送，不能替换正文。请核对原消息后单独发送修正。');
      }
      if ((editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body')) !== approval.text
        || message.get('isErased') || message.get('deletedForEveryone') || (deadline(message) ?? Infinity) <= Date.now()) throw new Error('Message changed during translation persistence');
    }
    return;
  }
  if (!original || !/\p{L}/u.test(original)) return;
  const ranges=(edit?edit.bodyRanges:message.get('bodyRanges'))||[];
  const result = await requestHelloDogTranslation({ id:message.id,editTimestamp,conversationId:conversation.id,text:original,direction:'outgoing',group:conversation.get('type')==='group',sentAt:editTimestamp||message.get('sent_at'),expiresAt:deadline(message) });
  if (result?.enabled === false) return;
  if (result?.enabled !== true) throw new Error('发送权限尚未确认，原消息已保留。');
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Translation returned no text');
  if ((editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body')) !== original || message.get('isErased') || message.get('deletedForEveryone') || (deadline(message) ?? Infinity) <= Date.now()) throw new Error('Message changed during translation');
  const extra: Translation = { original,translated:result.text,requestId:result.requestId };
  const bodyRanges=translatedBodyRanges(ranges,original,result.text), before={body:message.get('body'),bodyRanges:message.get('bodyRanges'),editHistory:message.get('editHistory'),helloDogTranslation:prior.helloDogTranslation,helloDogEditTranslations:prior.helloDogEditTranslations};
  const mainEditTimestamp=message.get('editMessageTimestamp');
  const currentEdit=!editTimestamp||!message.get('editMessageTimestamp')||message.get('editMessageTimestamp')===editTimestamp;
  message.set({...(currentEdit?{body:result.text,bodyRanges,helloDogTranslation:extra}:{}),...(editTimestamp?{editHistory:message.get('editHistory')?.map(item=>item.timestamp===editTimestamp?{...item,body:result.text,bodyRanges}:item),helloDogEditTranslations:{...prior.helloDogEditTranslations,[editTimestamp]:extra}}:{})} as any);
  try { await window.MessageCache.saveMessage(message); }
  catch(error) {
    const current=extensions(message),currentHistory=message.get('editHistory');
    if(!message.get('isErased')&&!message.get('deletedForEveryone')
      &&(editTimestamp?currentHistory?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body'))===result.text
      &&(editTimestamp?current.helloDogEditTranslations?.[editTimestamp]:current.helloDogTranslation)===extra){
      // Undo only this save's text and marker, preserving newer edits and any
      // delivery receipt that arrived while persistence was awaiting disk.
      const editTranslations={...current.helloDogEditTranslations};
      if(editTimestamp){
        const previous=before.helloDogEditTranslations?.[editTimestamp];
        if(previous)editTranslations[editTimestamp]=previous;else delete editTranslations[editTimestamp];
      }
      message.set({...(currentEdit&&message.get('editMessageTimestamp')===mainEditTimestamp&&message.get('body')===result.text&&current.helloDogTranslation===extra
        ?{body:before.body,bodyRanges:before.bodyRanges,helloDogTranslation:before.helloDogTranslation}:{}),
        ...(editTimestamp?{editHistory:currentHistory?.map(item=>item.timestamp===editTimestamp?{...item,body:edit?.body,bodyRanges:edit?.bodyRanges}:item),helloDogEditTranslations:editTranslations}:{})} as any);
    }
    throw error;
  }
  if ((editTimestamp?message.get('editHistory')?.find(item=>item.timestamp===editTimestamp)?.body:message.get('body')) !== result.text
    || message.get('isErased') || message.get('deletedForEveryone') || (deadline(message) ?? Infinity) <= Date.now()) throw new Error('Message changed during translation persistence');
}

export function startHelloDogMessages(): void {
  if (!enabled) return;
  startHelloDogVoiceMessages();
  window.addEventListener('hellodog-notification',event=>ipcRenderer.send('hellodog:notification',{silent:(event as CustomEvent).detail?.silent === true}));
  const pending = new Set<string>();
  const results = new Map<string,{body:string;result:any;revision:number}>();
  const retryAt = new Map<string,number>();
  let revision = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let lastConversation = '';
  let englishUi = !(window.navigator?.language || 'zh-CN').toLowerCase().startsWith('zh');
  async function render(element: HTMLElement, manual = false): Promise<void> {
    const id=element.dataset.hellodogId;
    if(!id||pending.has(id)||(!manual&&(pending.size>=4||(retryAt.get(id)||0)>Date.now()))) return;
    const generation=revision;
    const message=window.MessageCache?.getById(id);
    const existing=element.querySelector<HTMLElement>('[data-hellodog-ui]');
    if(!message||message.get('isErased')||message.get('deletedForEveryone')||message.get('isViewOnce')||(deadline(message)??Infinity)<=Date.now()) {existing?.remove();results.delete(id);return;}
    const body=message.get('body')||'', metadata=extensions(message).helloDogTranslation;
    const saved=metadata?.translated===body&&metadata.original!==body?metadata:undefined;
    // An outgoing message is rendered before its send job translates it. Do not
    // start a separate paid incoming translation for that queued or failed copy.
    // Already translated sends can display their saved original immediately;
    // acknowledged phone-synced history still supports incoming translation.
    if(message.get('type')==='outgoing'&&!saved&&!Object.values(message.get('sendStateByConversationId')||{}).some(state=>['Sent','Delivered','Read','Viewed'].includes(state.status))) {
      existing?.remove();results.delete(id);return;
    }
    const known=results.get(id);
    if(!manual&&known&&known.body===message.get('body')&&known.revision===generation&&((!known.result?.enabled&&!known.result?.manual)||known.result?.text===known.body)) return;
    if(!manual&&existing&&results.get(id)?.body===message.get('body')&&results.get(id)?.revision===generation) return;
    existing?.remove();
    const conversationId=message.get('conversationId');
    const conversation=window.ConversationController?.get(conversationId);
    if(!conversation) return;
    if(lastConversation!==conversationId) {lastConversation=conversationId;ipcRenderer.send('hellodog:conversation',{id:conversationId,name:conversation.getTitle(),group:conversation.get('type')==='group'});}
    if(!body||! /\p{L}/u.test(body)) return;
    pending.add(id);
    const current=()=>generation===revision&&element.isConnected&&element.dataset.hellodogId===id&&message.get('body')===body&&!message.get('isErased')&&!message.get('deletedForEveryone')&&!message.get('isViewOnce')&&(deadline(message)??Infinity)>Date.now();
    const showAction=(label=englishUi?'Translate':'翻译')=>{
      if(!current())return;
      const button=document.createElement('button');button.dataset.hellodogUi='action';button.textContent=label;button.title=englishUi?'Translate into my language':'翻译为我的语言';
      button.style.cssText='display:block;background:transparent;color:inherit;opacity:.8;border:0;padding:5px 0;cursor:pointer;font-size:11px';
      button.onclick=event=>{event.stopPropagation();void render(element,true);};
      (element.querySelector('.module-message__text')||element).appendChild(button);
    };
    try {
      const cached=results.get(id);
      const result=!manual&&cached?.body===body&&cached.revision===generation?cached.result:saved?{...await requestHelloDogTranslation({id,conversationId,text:'',direction:'display',expiresAt:deadline(message)}),text:saved.original}:await requestHelloDogTranslation({id,conversationId,text:body,direction:'incoming',group:conversation.get('type')==='group',sentAt:message.get('sent_at'),manual,expiresAt:deadline(message)});
      if(!current())return;
      if(result?.uiLanguage) englishUi = result.uiLanguage === 'en';
      results.set(id,{body,result,revision:generation}); if(results.size>5000) results.delete(results.keys().next().value!);
      retryAt.delete(id);
      if(result?.manual){showAction();return;}
      if(!result?.enabled||!result.text||result.text===body) return;
      const target=element.querySelector('.module-message__text')||element;
      const node=document.createElement('div'); node.className='hellodog-translation';node.dataset.hellodogUi='translation'; node.textContent=result.text;
      node.style.cssText='font-size:13px;line-height:1.5;white-space:pre-wrap;padding:6px 0;margin:5px 0;border-top:1px solid #8885;color:inherit;opacity:.8';
      if(Number.isFinite(result.fontSize))node.style.fontSize=Math.max(10,Math.min(24,result.fontSize))+'px';
      if(typeof result.color==='string'&&/^#[\da-f]{6}$/i.test(result.color))node.style.color=result.color;
      target.appendChild(node);
    } catch { retryAt.set(id,Date.now()+15000);showAction(englishUi?'Retry translation':'重试翻译'); }
    finally { pending.delete(id);schedule(); }
  }
  function scan() { scheduled=undefined; if(document.visibilityState==='hidden'||window.navigator.onLine===false)return; document.querySelectorAll<HTMLElement>('[data-hellodog-id]').forEach(element=>{const rect=element.getBoundingClientRect();if(rect.bottom>0&&rect.top<innerHeight) void render(element);}); }
  const schedule=()=>{if(!scheduled) scheduled=setTimeout(scan,400);};
  const observer=new MutationObserver(records=>{if(records.some(record=>!((record.target as Element).closest?.('[data-hellodog-ui]')||record.target.parentElement?.closest('[data-hellodog-ui]'))))schedule();});
  const start=()=>{observer.observe(document.body,{childList:true,characterData:true,subtree:true});document.addEventListener('scroll',schedule,true);schedule();};
  if(document.body) start();else document.addEventListener('DOMContentLoaded',start,{once:true});
  // A failed request schedules one immediate scan, which falls inside its
  // cooldown. Keep a lightweight wake-up so a stationary conversation recovers
  // even when no new message, scroll or DOM mutation arrives.
  setInterval(schedule,2000);
  const refreshTranslations=()=>{revision++;results.clear();retryAt.clear();document.querySelectorAll('[data-hellodog-ui]').forEach(node=>node.remove());schedule();};
  ipcRenderer.on('hellodog:refresh',refreshTranslations);
  ipcRenderer.on('hellodog:insert-draft',(_event,request:{id:string;text:string})=>{
    void (async()=>{
      const state=window.reduxStore?.getState();
      const conversationId=state && getSelectedConversationId(state);
      if(!conversationId) throw new Error('no conversation');
      const detail:QuickReplyDetail={conversationId,text:request.text};
      window.dispatchEvent(new CustomEvent('hellodog-insert-draft',{detail}));
      if(!detail.accepted) throw new Error('composer busy');
      await flushHelloDogDrafts();
      ipcRenderer.send('hellodog:draft-inserted',{id:request.id});
    })().catch(()=>ipcRenderer.send('hellodog:draft-inserted',{id:request.id,error:true}));
  });
  ipcRenderer.on('hellodog:prepare-restart',(_event,id:string)=>{
    void (async()=>{
      const state=window.reduxStore?.getState();
      if(window.Events?.getIsInCall() || state?.audioRecorder.recordingState!==undefined&&state.audioRecorder.recordingState!==RecordingState.Idle
        || Object.values(state?.composer.conversations||{}).some(value=>value.attachments.some(attachment=>attachment.pending))) throw new Error('busy');
      if(window.ConversationController) await flushHelloDogDrafts();
      ipcRenderer.send('hellodog:restart-ready',{id});
    })().catch(()=>ipcRenderer.send('hellodog:restart-ready',{id,error:true}));
  });
  ipcRenderer.on('hellodog:reload',(_event,id:string)=>{
    void refreshHelloDogPage({
      flushDrafts:flushHelloDogDrafts,
      refreshTranslations,
      busy:()=>!window.Events || window.Events.getIsInCall() || [...conversationJobQueue.getQueues()].some(queue=>queue.size+queue.pending>0)
        || Boolean(document.querySelector('.ql-editor')?.textContent?.trim())
        || window.ConversationController.getAll().some(conversation=>Boolean(conversation.get('draftAttachments')?.length))
        || Object.values(window.reduxStore.getState().composer.conversations).some(value=>value.attachments.length>0)
        || window.reduxStore.getState().audioRecorder.recordingState!==RecordingState.Idle,
      checkConnection:()=>{checkSockets();},
    }).then(mode=>ipcRenderer.send('hellodog:reload-ready',{id,mode}),()=>ipcRenderer.send('hellodog:reload-ready',{id,error:true}));
  });
  let previousConnection='';
  setInterval(()=>{try{const status=window.getSocketStatus?.().authenticated.status;const state=status===SocketStatus.OPEN?'receiving':status===SocketStatus.CONNECTING?'connecting':'disconnected';if(state!==previousConnection){previousConnection=state;ipcRenderer.send('hellodog:connection',state)}}catch{}},2000);
  let previousHealth='';
  let healthTicks=0;
  setInterval(()=>{try{const view=window.reduxStore?.getState().app.appView;if(!view)return;const pending=[...conversationJobQueue.getQueues()].reduce((sum,queue)=>sum+queue.size+queue.pending,0);const serialized=JSON.stringify({view,pending});if(serialized!==previousHealth||++healthTicks>=5){previousHealth=serialized;healthTicks=0;ipcRenderer.send('hellodog:health',{view,pending})}}catch{}},2000);
}
