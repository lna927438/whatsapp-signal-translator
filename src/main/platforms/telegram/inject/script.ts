import { telegramConversation, telegramMessageId } from '../../../../shared/telegramIdentity'
import { readWhatsAppComposerText } from '../../whatsapp/inject/composerText'
import { hasBlockedChinese } from '../../../translation/outgoingPolicy'
import { voiceAudioWav } from '../../../../shared/voiceAudio'

/** Keep official rendering and transport. Our UI is an isolated addition to existing bubbles. */
export const telegramInjectionScript = String.raw`
(() => {
 if (window.__HD_TELEGRAM_INSTALLED__) return;
 window.__HD_TELEGRAM_INSTALLED__ = true;
 const parseConversation = ${telegramConversation.toString()}, messageId = ${telegramMessageId.toString()};
 const readWhatsAppComposerText = ${readWhatsAppComposerText.toString()};
 const blockedChinese = ${hasBlockedChinese.toString()}, decodeVoice = ${voiceAudioWav.toString()};
 const api = window.realtimeTranslator;
 let disposed=false, timer, timerDue=0, epoch=0, lastRoute='', lastUnread=-1, lastConnection='', settings={}, settingsAt=0, settingsPromise;
 let sending=false, active, nativeClick, locked=false, preview, previewResolve, status, composing=new WeakSet();
 let incomingCount=0, incomingPausedUntil=0, incomingFailures=0;
 let pendingPanel,pendingRead,pendingAt=0,pendingRevision=0,resolving;
 const rowRecords=new WeakMap(), audioOwners=new WeakMap(), listOwners=new WeakMap(), historyBaselines=new WeakMap(), mounted=new Set(), approvedHistory=new Set();
 const MAX_AUTO_CONCURRENCY=2, MAX_ROWS=120;
 const visible=node=>{if(!node?.isConnected||node.closest('[hidden],[aria-hidden="true"],.Transition_slide-inactive')||getComputedStyle(node).display==='none')return false;const slide=node.closest('.messages-layout > .Transition > .Transition_slide');return !slide||slide.matches('.Transition_slide-active,.Transition_slide-to')};
 const onScreen=node=>{const rect=node.getBoundingClientRect();return rect.width===0&&rect.height===0||rect.bottom>=0&&rect.top<=innerHeight&&rect.right>=0&&rect.left<=innerWidth};
 const current=()=>parseConversation(location.hash);
 const messageList=()=>{
  const conversation=current();if(!conversation)return null;const route=conversation.id+':'+(conversation.route.split('_').find(part=>part==='pinned'||part==='scheduled')||'thread');
  const lists=Array.from(document.querySelectorAll('#MiddleColumn .MessageList,.messages-layout .MessageList')).filter(visible);
  const owned=lists.filter(list=>!listOwners.has(list)||listOwners.get(list)===route);
  if(owned.length!==1)return null;
  const list=owned[0];if(!listOwners.has(list))listOwners.set(list,route);return list;
 };
 const editor=()=>Array.from(document.querySelectorAll('#editable-message-text-modal,#editable-message-text')).filter(node=>visible(node)&&node.matches('[contenteditable="true"],[contenteditable="plaintext-only"]')).sort((a,b)=>Number(b.id.endsWith('-modal'))-Number(a.id.endsWith('-modal')))[0];
 const text=node=>readWhatsAppComposerText(node);
 const routeKey=()=>current()?.route||'';
 const targetKey=()=>current()?'peer:'+current().id+':'+(editor()?.id||''):'';
 const rowSelector='.Message[data-message-id]';
 const rows=()=>Array.from(messageList()?.querySelectorAll(rowSelector)||[]).filter(row=>visible(row));
 const rowId=row=>messageId(row.getAttribute('data-message-id'));
 // Official Web A only renders this marker when isViewportNewest is true.
 // Its geometry additionally proves we are at the visible live tail, rather
 // than reading older messages from a partially populated virtualized list.
 const latestTail=list=>{
  if(!list||list.classList.contains('is-animating'))return false;
  const markers=Array.from(list.querySelectorAll('.messages-container > .list-bottom-marker')).filter(visible);
  if(markers.length!==1)return false;
  const view=list.getBoundingClientRect(),marker=markers[0].getBoundingClientRect();
  return view.height>0&&view.width>0&&marker.top>=view.top-2&&marker.bottom<=view.bottom+2&&marker.left>=view.left-2&&marker.right<=view.right+2;
 };
 const bubble=row=>row.querySelector('.message-content')||row.querySelector('.message-content-wrapper');
 const messageText=row=>{
  const node=row.querySelector('.text-content'); if(!node)return '';
  const clone=node.cloneNode(true); for(const part of clone.querySelectorAll('[data-rt-ui],.MessageMeta,.message-title,.message-reply,.embedded-message,.message-summary,.message-translated,.Reactions'))part.remove();
  return text(clone);
 };
 const own=row=>row.classList.contains('own');
 const accepted=row=>Boolean(row.querySelector('.MessageOutgoingStatus .icon-check,.MessageOutgoingStatus .icon-message-read'))&&!row.querySelector('.MessageOutgoingStatus--failed,.icon-message-failed,.icon-message-pending');
 const timeout=(promise,ms,message)=>new Promise((resolve,reject)=>{const id=setTimeout(()=>reject(new Error(message)),ms);Promise.resolve(promise).then(value=>{clearTimeout(id);resolve(value)},error=>{clearTimeout(id);reject(error)})});
 const showStatus=(value,error=false)=>{
  if(disposed)return;
  const host=editor()?.closest('.Composer,.Modal,.modal-dialog')||document.querySelector('#MiddleColumn');
  if(!host)return;
  if(!status?.isConnected){status=document.createElement('div');status.dataset.rtUi='status';status.setAttribute('role','status');status.className='hd-tg-status';host.append(status)}
  status.textContent=value;status.style.color=error?'#f5a69d':'inherit';
 };
 const report=(state,message='')=>api?.reportStatus?.({state,message});
 async function runtime(force=false){
  const conversation=current()?.id;if(!conversation)return settings;
  if(settingsPromise)return settingsPromise;
  if(!force&&Date.now()-settingsAt<5000)return settings;
  const version=epoch;
  const work=timeout(api.getRuntimeSettings(conversation),8000,'翻译设置读取超时').then(value=>{if(version===epoch){settings=value||{};settingsAt=Date.now()}return settings}).finally(()=>{if(settingsPromise===work)settingsPromise=null});
  settingsPromise=work;return work;
 }
 function button(label,action){const item=document.createElement('button');item.type='button';item.textContent=label;item.className='hd-tg-button';item.onclick=action;return item}
 function clearPending(){pendingPanel?.element.remove();pendingPanel=null}
 function showPendingTask(task){
  const conversation=current();if(!conversation||task?.conversationId!==conversation.id||!['uncertain','submitting'].includes(task.state)||!messageList())return;
  if(pendingPanel?.id===task.id&&pendingPanel.state===task.state&&pendingPanel.element.isConnected)return;
  clearPending();const host=document.body;if(!host)return;
  const element=document.createElement('section');element.dataset.rtUi='send-reconcile';element.className='hd-tg-preview hd-tg-reconcile';element.setAttribute('role','region');element.setAttribute('aria-label','核对发送结果');
  const panel={element,id:task.id,state:task.state,version:epoch,route:routeKey(),conversationId:conversation.id};pendingPanel=panel;
  const notice=document.createElement('p');notice.textContent='请先查看当前 Telegram 官网聊天记录，核对下面这条消息是否已经发送。选择后只更新发送记录，不会自动重新发送。';
  const original=document.createElement('div');original.textContent='原文：'+(task.request?.text||'');original.style.whiteSpace='pre-wrap';
  const translated=document.createElement('div');translated.textContent='译文：'+(task.translated||'');translated.style.whiteSpace='pre-wrap';
  const result=document.createElement('p');if(task.state==='submitting')result.textContent='仍在处理发送，请等待结果；此时不能手动解除。';
  const valid=()=>!disposed&&pendingPanel===panel&&element.isConnected&&epoch===panel.version&&routeKey()===panel.route&&current()?.id===panel.conversationId;
  const resolve=async(sent)=>{
   if(!valid()||sending||locked||resolving||task.state!=='uncertain')return;
   resolving=panel;pendingRevision++;yes.disabled=true;no.disabled=true;result.textContent='正在更新已核对的发送记录…';
   try{
    const tasks=await timeout(api.pendingSends(),8000,'读取发送记录超时，请稍后再核对');
    if(!valid())return;
    const latest=tasks.find(value=>value.id===panel.id&&value.conversationId===panel.conversationId);
    if(latest?.state!=='uncertain')throw new Error(latest?.state==='submitting'?'发送仍在处理中，请稍后核对。':'发送状态已经变化，请等待记录刷新。');
    const updated=await timeout(sent?api.confirmSent(panel.id):api.confirmNotSent(panel.id),10000,'记录更新结果待确认，请稍后刷新；不会自动重发');
    if(!valid())return;
    if(updated?.id!==panel.id||updated.conversationId!==panel.conversationId||!['sent','ready','draft'].includes(updated.state))throw new Error('发送记录尚未核对成功，请稍后刷新。');
    if(sent){clearPending();showStatus('已按你的核对标记为已发送。');report('ready')}
    else{
     const composer=editor(),original=updated.request?.text||'',draft=text(composer);
     const restored=composer&&targetKey()===updated.targetKey&&!composing.has(composer)&&(!draft||draft===updated.translated)&&window.__RT_EDIT_ATOMIC__({text:original,expected:draft,targetKey:updated.targetKey,conversationId:updated.conversationId});
     if(restored)void api.saveDraft({conversationId:updated.conversationId,targetKey:updated.targetKey},original).catch(()=>{});
     panel.state=updated.state;result.textContent=restored?'已标记为尚未发送，原稿已恢复。再次发送需你手动点击，已有译文会继续复用。':'已标记为尚未发送，现有草稿保持不变。原稿在上方，原任务与译文已保留；请在原输入框恢复后手动发送。';yes.remove();no.remove();report('ready');
    }
   }catch(error){if(valid()){result.textContent=error?.message||'发送记录更新失败，请稍后重试。';yes.disabled=false;no.disabled=false}}
   finally{if(resolving===panel)resolving=null;pendingAt=0;schedule()}
  };
  const yes=button('我已核对，已经发送',()=>void resolve(true)),no=button('我已核对，尚未发送',()=>void resolve(false));yes.disabled=no.disabled=task.state!=='uncertain';const content=document.createElement('div');content.className='hd-tg-reconcile-content';const title=document.createElement('strong');title.textContent='核对发送结果';content.append(title,notice,original,translated,result);const actions=document.createElement('div');actions.className='hd-tg-reconcile-actions';actions.append(yes,no);element.append(content,actions);element.addEventListener('click',event=>event.stopPropagation());host.append(element);
 }
 async function recoverPending(){
  const conversation=current();if(!conversation||sending||resolving||pendingRead||typeof api.pendingSends!=='function'||Date.now()-pendingAt<5000)return;
  const version=epoch,route=routeKey(),revision=pendingRevision;pendingAt=Date.now();const work=timeout(api.pendingSends(),8000,'发送记录暂未取得');pendingRead=work;
  try{const tasks=await work;if(disposed||document.hidden||sending||resolving||revision!==pendingRevision||version!==epoch||route!==routeKey()||current()?.id!==conversation.id)return;const task=tasks.find(value=>value.conversationId===conversation.id&&['uncertain','submitting'].includes(value.state));if(task){showPendingTask(task);if(task.state==='submitting')schedule(5000)}else if(pendingPanel&&['uncertain','submitting'].includes(pendingPanel.state))clearPending()}
  catch{}finally{if(pendingRead===work)pendingRead=null}
 }
 const css=document.createElement('style');css.dataset.rtUi='style';css.textContent=
 '[data-rt-ui]{box-sizing:border-box}.hd-tg-status{padding:5px 12px;font-size:12px;line-height:1.5;white-space:normal}.hd-tg-translation,.hd-tg-voice{display:block;clear:both;margin-top:6px;padding-top:6px;border-top:1px dashed #8887;max-width:100%;font-size:13px;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}.hd-tg-button{color:inherit;background:transparent;border:1px solid #8887;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;margin:3px}.hd-tg-button:disabled{opacity:.6;cursor:default}.hd-tg-preview{position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);width:min(520px,90vw);max-height:70vh;overflow:auto;background:#222b32;color:#f7f7f7;border:1px solid #829e91;border-radius:12px;padding:16px;box-shadow:0 6px 30px #0008}.hd-tg-preview textarea{width:100%;min-height:90px;background:#14222b;color:inherit;border:1px solid #829e91;border-radius:6px;padding:8px;font:inherit;white-space:pre-wrap}.hd-tg-preview.hd-tg-reconcile{z-index:2147483646;left:auto;right:12px;bottom:12px;transform:none;width:min(560px,calc(100vw - 24px));max-height:min(340px,45vh);padding:0;display:flex;flex-direction:column;overflow:hidden;font:13px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;white-space:normal}.hd-tg-reconcile-content{min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:12px;scrollbar-gutter:stable;overflow-wrap:anywhere}.hd-tg-reconcile-content p{margin:8px 0}.hd-tg-reconcile-actions{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;border-top:1px solid #829e9166}.hd-tg-reconcile-actions .hd-tg-button{flex:1 1 150px;min-width:0;margin:0;white-space:normal;overflow-wrap:anywhere}';document.head.append(css);
 function attachmentSnapshot(composer){
  if(!composer?.id.endsWith('-modal'))return '';
  const modal=composer.closest('.Modal,.modal-dialog,[role="dialog"]');if(!modal)return null;
  const sources=Array.from(modal.querySelectorAll('img[src],video[src],canvas')).filter(node=>!node.closest('[data-rt-ui]')).map(node=>node.tagName+':'+(node.getAttribute('src')||node.getAttribute('width')+':'+node.getAttribute('height')));
  return sources.length?JSON.stringify(sources):null;
 }
 function sendButton(composer){
  if(!composer)return null;
  if(composer.id.endsWith('-modal')){
   const modal=composer.closest('.Modal,.modal-dialog,[role="dialog"]');
   const candidates=Array.from(modal?.querySelectorAll('button')||[]).filter(node=>visible(node)&&!node.disabled&&!node.closest('[data-rt-ui]')&&node.querySelector('.icon-new-send,.icon-send'));
   return candidates.length===1?candidates[0]:null;
  }
  const host=composer.closest('.Composer')||document.querySelector('#MiddleColumn');
  const candidates=Array.from(host?.querySelectorAll('button.main-button.send')||[]).filter(node=>visible(node)&&!node.disabled);
  return candidates.length===1?candidates[0]:null;
 }
 function closePreview(result){if(preview){preview.remove();preview=null}const resolve=previewResolve;previewResolve=null;resolve?.(result)}
 function askPreview(task){
  closePreview(null);return new Promise(resolve=>{
   previewResolve=resolve;const panel=document.createElement('div');panel.className='hd-tg-preview';panel.dataset.rtUi='preview';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','发送译文预览');
   const title=document.createElement('strong');title.textContent='发送译文预览';
   const original=document.createElement('div');original.textContent=task.request.text;original.style.cssText='white-space:pre-wrap;margin:10px 0;opacity:.8';
   const input=document.createElement('textarea');input.value=task.translated||'';input.setAttribute('aria-label','可编辑译文');
   panel.append(title,original,input,button('发送译文',()=>{if(input.value.trim())closePreview(input.value)}),button('暂不发送',()=>closePreview(null)));
   panel.addEventListener('click',e=>e.stopPropagation());panel.addEventListener('keydown',e=>e.stopPropagation());document.body.append(panel);preview=panel;input.focus();
  });
 }
 const editableSnapshot=()=>{const composer=editor(),conversation=current(),list=messageList(),ids=rows().map(rowId).filter(Boolean),watermark=ids.length?ids.reduce((a,b)=>BigInt(a)>BigInt(b)?a:b):null;return composer&&list&&conversation?.writable?{composer,list,watermark,conversationId:conversation.id,targetKey:targetKey(),route:routeKey(),original:text(composer),media:attachmentSnapshot(composer),version:epoch,baseline:rows().filter(own).map(rowId).filter(Boolean)}:null};
 function sameSnapshot(snapshot){return snapshot&&snapshot.version===epoch&&snapshot.list===messageList()&&snapshot.composer===editor()&&snapshot.composer.isConnected&&snapshot.route===routeKey()&&snapshot.targetKey===targetKey()&&snapshot.conversationId===current()?.id&&snapshot.media===attachmentSnapshot(snapshot.composer)}
 async function requestSend(){
  if(sending||resolving){showStatus('正在处理上一条消息，请稍候。');return}
  const snapshot=editableSnapshot();if(!snapshot){showStatus('无法确认当前会话，已保留原稿，请重新打开会话。',true);return}
  if(composing.has(snapshot.composer)){showStatus('请先完成输入法选字。');return}
  if(!snapshot.original){if(snapshot.composer.id.endsWith('-modal')){showStatus('图片没有说明文字，可使用官方发送按钮发送。')}return}
  if(snapshot.media===null){showStatus('附件仍在准备，原稿已保留，请稍后重试。',true);return}
  if(!sendButton(snapshot.composer)){showStatus('当前发送方式暂不支持翻译保护，请使用普通会话发送。',true);return}
  sending=true;active={...snapshot,id:'',translated:'',dispatched:false};let task;
  try{
   // Retain the same intent after a slow prepare, failure, preview cancel or page retry.
   const unfinished=await timeout(api.pendingSends(),8000,'发送状态读取超时，原稿已保留');
   const pending=unfinished.find(value=>value.conversationId===snapshot.conversationId&&['submitting','uncertain'].includes(value.state));
   if(pending){showStatus('上一条消息结果待确认，请先核对聊天记录，系统不会自动重发。',true);showPendingTask(pending);return}
   task=await timeout(api.prepareSend({text:snapshot.original,conversationId:snapshot.conversationId,targetKey:snapshot.targetKey}),10000,'发送任务保存超时，原稿已保留');
   active.id=task.id;
   if(!sameSnapshot(snapshot)||text(snapshot.composer)!==snapshot.original)throw new Error('会话或草稿已变化，未发送。');
   if(['submitting','uncertain'].includes(task.state))throw new Error('该条消息结果待确认，不会重复发送。');
   task=await timeout(api.translateSend(task.id),75000,'翻译超时，原稿已保留，稍后重试会复用同一任务。');
   if(!sameSnapshot(snapshot)||text(snapshot.composer)!==snapshot.original)throw new Error('会话或草稿已变化，译文已保存，未发送。');
   if(!task.translated?.trim())throw new Error('没有取得完整译文，原稿已保留。');
   const prefs=await runtime();
   if(prefs.previewSend!==false){const edited=await askPreview(task);if(edited===null)return;task=await api.editSendPreview(task.id,edited)}
   if(!sameSnapshot(snapshot)||text(snapshot.composer)!==snapshot.original)throw new Error('会话或草稿已变化，译文已保存，未发送。');
   active.translated=task.translated;
   const result=await timeout(api.submitSend(task.id),30000,'正在核对发送结果，请勿重复发送。');
   if(result?.state==='sent'){showStatus('已发送');report('ready');active=null}else{showStatus('发送结果待确认，系统不会自动重发。',true);showPendingTask(result)}
  }catch(error){showStatus(error?.message||'翻译暂时不可用，原稿已保留。',true);report('error',error?.message||'翻译失败')}
  finally{sending=false;locked=false;if(!active?.dispatched)active=null;pendingAt=0;schedule()}
 }
 window.__RT_SEND_SELECT__=task=>{
  if(!active||active.dispatched||active.id!==task.id||!sameSnapshot(active)||composing.has(active.composer)||text(active.composer)!==active.original||task.original!==active.original||task.targetKey!==active.targetKey||task.conversationId!==active.conversationId)return false;
  if(!task.translated?.trim()||!sendButton(active.composer))return false;
  if(blockedChinese(task.translated,task.targetLanguage||'en'))return false;
  locked=true;active.translated=task.translated;return {text:text(active.composer)};
 };
 window.__RT_EDIT_ATOMIC__=value=>{
  const composer=editor();if(!composer||composing.has(composer)||value.targetKey!==targetKey()||value.conversationId!==current()?.id||text(composer)!==value.expected)return false;
  composer.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(composer);selection.removeAllRanges();selection.addRange(range);
  const savedLock=locked;locked=false;let ok=false;
  try{ok=document.execCommand(value.text?'insertText':'delete',false,value.text)}finally{locked=savedLock;if(savedLock&&active?.composer===composer)active.writeResult=text(composer)}
  return Boolean(ok)&&composer===editor()&&value.targetKey===targetKey()&&text(composer)===value.text.replace(/\r\n?/g,'\n').trim();
 };
 const probe=value=>{
  const conversation=current();
  if(value.atLatestTail!==true||!conversation?.writable||!messageList()||typeof value.targetKey!=='string'||value.targetKey.replace(/:editable-message-text(?:-modal)?$/,'')!=='peer:'+conversation.id||value.route&&value.route!==conversation.route||!Array.isArray(value.baseline)||!messageId(value.watermark))return null;
  const found=rows().filter(row=>own(row)&&rowId(row)&&BigInt(rowId(row))>BigInt(value.watermark)&&!value.baseline.includes(rowId(row))&&messageText(row)===value.translated&&accepted(row));
  if(found.length!==1)return null;
  return {dispatched:true,confirmed:true,messageId:current().id+':'+rowId(found[0])};
 };
 window.__RT_SEND_COMMIT__=async task=>{
  const snapshot=active;
  const refuse=message=>({dispatched:false,confirmed:false,message});
  if(!snapshot||snapshot.id!==task.id||snapshot.dispatched||!sameSnapshot(snapshot)||snapshot.translated!==task.translated||text(snapshot.composer)!==task.translated||composing.has(snapshot.composer))return refuse('发送前内容已变化，已阻止发送。');
  if(blockedChinese(task.translated,task.targetLanguage||'en'))return refuse('译文仍含中文，已阻止发送。');
  const button=sendButton(snapshot.composer);if(!button)return refuse('发送按钮不可用，译文已保留。');
  // Translation/preview may take time. Freeze receipt evidence at the actual
  // native click, not when the user originally requested translation.
  const beforeClick=rows(),ids=beforeClick.map(rowId).filter(Boolean);
  snapshot.baseline=beforeClick.filter(own).map(rowId).filter(Boolean);
  snapshot.watermark=ids.length?ids.reduce((a,b)=>BigInt(a)>BigInt(b)?a:b):null;
  snapshot.atLatestTail=latestTail(snapshot.list);
  snapshot.dispatched=true;nativeClick=button;
  try{button.click()}finally{nativeClick=null;locked=false}
  const evidence={translated:task.translated,baseline:snapshot.baseline,targetKey:snapshot.targetKey,route:snapshot.route,watermark:snapshot.watermark,atLatestTail:snapshot.atLatestTail};
  for(let attempt=0;attempt<24;attempt++){if(disposed||snapshot.version!==epoch)break;const result=probe(evidence);if(result)return result;await new Promise(resolve=>setTimeout(resolve,250))}
  return {dispatched:true,confirmed:false,baseline:snapshot.baseline,targetKey:snapshot.targetKey,route:snapshot.route,watermark:snapshot.watermark,atLatestTail:snapshot.atLatestTail};
 };
 window.__RT_SEND_PROBE__=probe;
 window.__RT_SEND_RELEASE__=(id,notDispatched)=>{const snapshot=active;locked=false;if(snapshot?.id===id){if(notDispatched){const draft=text(snapshot.composer);if(sameSnapshot(snapshot)&&(draft===snapshot.translated||draft===snapshot.writeResult))window.__RT_EDIT_ATOMIC__({text:snapshot.original,expected:draft,targetKey:snapshot.targetKey,conversationId:snapshot.conversationId});showStatus('发送尚未开始，草稿和译文均已保留。',true)}active=null}};
 window.__RT_RETRY_QUEUED_SEND__=async()=>{await requestSend();return true};
 function stop(event){event.preventDefault();event.stopImmediatePropagation();event.stopPropagation()}
 function isSendAction(button){return button?.matches('.main-button.send,.main-button.edit,.main-button.schedule,.main-button.sendOneTime')||Boolean(button?.closest('.Composer,.Modal,.modal-dialog')&&(button.querySelector('.icon-new-send,.icon-send')||button.closest('.Modal,.modal-dialog')&&button.matches('[class*="send"]')||/^(?:send|发送)(?:\s|$)/i.test(button.getAttribute('aria-label')||'')))}
 function click(event){
  const node=event.target instanceof Element?event.target:event.target?.parentElement;if(!node||node.closest('[data-rt-ui]'))return;
  const button=node.closest('button,[role="button"]');if(button===nativeClick)return;
  if(!isSendAction(button))return;
  const composer=editor();if(!composer)return;
  if(!text(composer)){if(sending||locked)stop(event);return}
  stop(event);void requestSend();
 }
 function key(event){
  const composer=event.target instanceof Element?event.target.closest('#editable-message-text,#editable-message-text-modal'):null;
  if(!composer||event.key!=='Enter')return;
  if(event.isComposing||event.keyCode===229||composing.has(composer)){event.stopImmediatePropagation();event.stopPropagation();return}
  if(event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey)return;
  stop(event);void requestSend();
 }
 const inputLock=event=>{if(locked&&event.target===active?.composer)stop(event)};
 const contextMenu=event=>{const node=event.target instanceof Element?event.target:event.target?.parentElement;if(isSendAction(node?.closest('button,[role="button"]'))&&text(editor())){stop(event);showStatus('请使用普通发送按钮，先确认译文后发送。')}};
 window.addEventListener('click',click,true);window.addEventListener('keydown',key,true);window.addEventListener('contextmenu',contextMenu,true);
 document.addEventListener('beforeinput',inputLock,true);
 document.addEventListener('compositionstart',event=>composing.add(event.target),true);document.addEventListener('compositionend',event=>composing.delete(event.target),true);

 async function translateRow(record,manual=false){
  const conversation=current(),row=record.row,original=messageText(row),version=epoch,id=rowId(row);if(!conversation||!id||!original||record.busy||!visible(row))return;
  const valid=()=>!disposed&&record.box.isConnected&&record.row.isConnected&&epoch===version&&current()?.id===conversation.id&&rowId(row)===id&&messageText(row)===original;
  record.busy=true;record.button.disabled=true;incomingCount++;record.output.textContent='正在翻译…';
  try{
   const payload={text:original,conversationId:conversation.id,messageId:conversation.id+':'+id,manual,outgoing:own(row)};
   let result=await timeout(api.cachedIncoming(payload),8000,'译文缓存读取超时');
   if(!valid())return;
   // Receipt persistence can finish after the native bubble appears. Never buy a
   // second translation for our outgoing bubble while that original is settling.
   if((typeof result!=='string'||!result.trim())&&own(row)&&!manual){record.output.textContent='';record.cacheAttempts=(record.cacheAttempts||0)+1;record.complete=record.cacheAttempts>=3;record.nextCacheAt=Date.now()+1500;if(!record.complete)schedule(1600);return}
   if(typeof result!=='string'||!result.trim())result=await timeout(api.translateIncoming(payload),65000,'翻译超时，请重试');
   if(!valid())return;
   if(typeof result!=='string'||!result.trim())throw new Error('暂未取得译文');
   record.output.textContent=result;record.complete=true;record.button.hidden=true;incomingFailures=0;incomingPausedUntil=0;
  }catch(error){if(valid()){record.output.textContent=error?.message||'翻译暂不可用，请重试';record.button.textContent='重试翻译';record.failed=true;incomingFailures++;incomingPausedUntil=Date.now()+Math.min(60000,2000*2**Math.min(incomingFailures,5))}}
  finally{record.busy=false;record.button.disabled=false;incomingCount--;schedule()}
 }
 function audioUrl(row){
  const audios=Array.from(row.querySelectorAll('audio')).filter(audio=>audio.closest(rowSelector)===row&&/^(?:blob:)/.test(audio.currentSrc||audio.src));
  if(audios.length!==1)return '';
  const audio=audios[0],url=audio.currentSrc||audio.src,identity=current()?.id+':'+rowId(row),previous=audioOwners.get(audio);
  if(previous&&previous.url===url&&previous.identity!==identity)return '';
  audioOwners.set(audio,{url,identity});return url;
 }
 function chooseAudio(){return new Promise(resolve=>{
  const input=document.createElement('input');input.type='file';input.accept='audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm';input.dataset.rtUi='voice-file';input.style.display='none';document.body.append(input);
  const finish=file=>{clearTimeout(wait);input.remove();resolve(file)};const wait=setTimeout(()=>finish(null),120000);
  input.onchange=()=>finish(input.files?.[0]||null);input.oncancel=()=>finish(null);input.click();
 })}
 async function translateVoice(record){
  const conversation=current(),id=rowId(record.row),version=epoch,linkedUrl=audioUrl(record.row);if(!conversation||!id||record.voiceBusy||record.voiceComplete)return;
  const valid=()=>!disposed&&epoch===version&&record.row.isConnected&&record.voiceBox.isConnected&&rowId(record.row)===id&&current()?.id===conversation.id&&(!linkedUrl||audioUrl(record.row)===linkedUrl);
  record.voiceBusy=true;record.voiceButton.disabled=true;let ownedUrl='';
  try{
   let url=linkedUrl;
   if(!url){record.voiceStatus.textContent='请选择从这条语音下载的音频文件，结果会显示在当前气泡内。';const file=await chooseAudio();if(!file||!valid()){record.voiceStatus.textContent='已取消，原语音保留。';return}if(file.size>20*1024*1024)throw new Error('请选择 20 MB 以内的语音文件。');ownedUrl=URL.createObjectURL(file);url=ownedUrl}
   record.voiceStatus.textContent='正在识别并生成中英双语…';const bytes=await decodeVoice(url);if(!valid())return;
   const result=await timeout(api.translateVoiceMessage({bytes,conversationId:conversation.id,messageId:'voice:'+conversation.id+':'+id}),120000,'语音翻译超时，请重试');
   if(!valid())return;
   if(result?.targetLanguage!=='zh-CN'||typeof result.translation!=='string'||!result.translation.trim()||typeof result.englishTranslation!=='string'||!result.englishTranslation.trim())throw new Error('尚未取得完整中英双语，请重试');
   record.english.textContent='English: '+result.englishTranslation;record.chinese.textContent='中文：'+result.translation;record.voiceStatus.textContent='已完成';record.voiceComplete=true;record.voiceSource=linkedUrl;record.voiceButton.hidden=true;
  }catch(error){if(valid()){record.voiceStatus.textContent=error?.message||'语音翻译失败，请重试';record.voiceButton.textContent='重试转中文'}}
  finally{if(ownedUrl)URL.revokeObjectURL(ownedUrl);record.voiceBusy=false;record.voiceButton.disabled=Boolean(record.voiceComplete);if(!valid()&&record.voiceBox.isConnected)record.voiceStatus.textContent='语音或会话已变化，请在原消息上重试。'}
 }
 function mountRow(row){
  const conversation=current(),id=rowId(row),host=bubble(row);if(!conversation||!id||!host)return;
  const original=messageText(row),identity=conversation.id+':'+id;let record=rowRecords.get(row);
  if(record&&(record.identity!==identity||record.original!==original||record.box&&!record.box.isConnected||record.voiceBox&&!record.voiceBox.isConnected)){record.box?.remove();record.voiceBox?.remove();mounted.delete(record);record=null}
  if(!record){record={row,identity,original,busy:false,complete:false,failed:false};rowRecords.set(row,record);mounted.add(record)}
  if(record.voiceComplete&&record.voiceSource&&record.voiceSource!==audioUrl(row)){record.voiceComplete=false;record.english.textContent='';record.chinese.textContent='';record.voiceButton.hidden=false;record.voiceButton.disabled=false;record.voiceStatus.textContent='语音已变化，请重新转为中文。'}
  if(original&&!record.box){
   const box=document.createElement('div');box.dataset.rtUi='translation';box.className='hd-tg-translation';const output=document.createElement('div');output.dataset.translationText='true';const item=button('翻译此消息',()=>void translateRow(record,true));box.append(item,output);box.addEventListener('click',e=>e.stopPropagation());host.append(box);Object.assign(record,{box,output,button:item});
  }
  if(!record.voiceBox&&row.querySelector('.Audio .waveform,.Audio .voice-duration,audio')){
   const box=document.createElement('div');box.dataset.rtUi='voice';box.className='hd-tg-voice';const voiceStatus=document.createElement('div'),english=document.createElement('div'),chinese=document.createElement('div');english.lang='en';chinese.lang='zh-CN';english.dataset.voiceEnglish='true';chinese.dataset.voiceChinese='true';const item=button('转为中文',()=>void translateVoice(record));box.append(item,voiceStatus,english,chinese);box.addEventListener('click',e=>e.stopPropagation());host.append(box);Object.assign(record,{voiceBox:box,voiceButton:item,voiceStatus,english,chinese});
  }
  if(record.box){record.box.hidden=settings.translationsVisible===false;record.box.style.color=settings.translationColor||'';if(Number.isFinite(settings.fontSize))record.box.style.fontSize=Math.max(10,Math.min(30,settings.fontSize))+'px'}
  if(record.nextCacheAt>Date.now()&&!record.complete)schedule(record.nextCacheAt-Date.now()+10);
  if(!document.hidden&&onScreen(row)&&settings.receiveAutoTranslate&&settings.historyMode!=='manual'&&(!conversation.group||settings.groupTranslate)&&incomingCount<MAX_AUTO_CONCURRENCY&&!record.busy&&!record.complete&&!record.failed&&original&&Date.now()>=incomingPausedUntil&&Date.now()>=(record.nextCacheAt||0)&&(!own(row)||!sending&&!active?.dispatched)&&(settings.historyMode==='visible'||approvedHistory.has(identity)))void translateRow(record);
 }
 function refreshContext(){
  const route=routeKey();if(route===lastRoute)return;
  lastRoute=route;epoch++;settingsAt=0;settingsPromise=null;settings={};closePreview(null);clearPending();pendingAt=0;locked=false;active=null;approvedHistory.clear();
  const conversation=current();if(conversation)api.reportConversation?.({id:conversation.id,name:document.querySelector('#MiddleColumn .chat-info .title')?.textContent?.trim()||'Telegram'});
 }
 async function scan(){
  clearTimeout(timer);timer=null;if(disposed)return;refreshContext();
  for(const record of mounted)if(!record.row.isConnected){mounted.delete(record)}
  const connection=navigator.onLine===false?'offline':document.querySelector('#auth-qr-form,#auth-phone-number-form,.Auth')?'login-required':document.querySelector('#LeftColumn')?'page-ready':'loading';if(connection!==lastConnection){lastConnection=connection;api.reportConnection?.(connection)}
  const titleCount=document.title.match(/^\((\d+)\)/),unread=titleCount?Number(titleCount[1]):0;if(unread!==lastUnread){lastUnread=unread;api.reportUnread?.(unread)}
  const version=epoch,listBeforeSettings=messageList();if(document.hidden||!current()||!listBeforeSettings)return;
  void recoverPending();
  try{await runtime()}catch{showStatus('翻译连接暂不可用，聊天页面和草稿已保留。',true)}
  if(disposed||document.hidden||version!==epoch||!current()||messageList()!==listBeforeSettings)return;
  const candidates=rows().slice(-MAX_ROWS),list=messageList(),ids=candidates.map(rowId).filter(Boolean),signature=ids.join(',');
  let baseline=historyBaselines.get(list);
  if(!baseline){baseline={primed:false,signature:'',changedAt:Date.now(),maximum:0n};historyBaselines.set(list,baseline)}
  if(!baseline.primed){
   if(signature!==baseline.signature){baseline.signature=signature;baseline.changedAt=Date.now()}
   for(const id of ids)if(BigInt(id)>baseline.maximum)baseline.maximum=BigInt(id);
   if(ids.length&&Date.now()-baseline.changedAt>=800&&!list.classList.contains('is-animating'))baseline.primed=true;
   else if(ids.length)schedule(900);
  }else{
   for(const id of ids)if(BigInt(id)>baseline.maximum)approvedHistory.add(current().id+':'+id);
   for(const id of ids)if(BigInt(id)>baseline.maximum)baseline.maximum=BigInt(id);
  }
  for(const row of candidates)mountRow(row);
 }
 function schedule(delay=180){if(disposed)return;const ms=typeof delay==='number'?Math.max(1,delay):180,due=Date.now()+ms;if(timer&&timerDue<=due)return;clearTimeout(timer);timerDue=due;timer=setTimeout(()=>void scan(),ms)}
 const observer=new MutationObserver(changes=>{if(changes.every(change=>{const node=change.target.nodeType===1?change.target:change.target.parentElement;return node?.closest('[data-rt-ui]')}))return;schedule()});
 observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-message-id','src','class']});
 window.addEventListener('hashchange',()=>{refreshContext();schedule()});
 const reconnect=()=>{settingsAt=0;incomingPausedUntil=0;incomingFailures=0;for(const record of mounted)record.failed=false;schedule()};
 window.addEventListener('online',reconnect);document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule()});document.addEventListener('scroll',schedule,{passive:true,capture:true});
 window.__RT_RESUME_TRANSLATIONS__=reconnect;
 window.__RT_REFRESH_TRANSLATIONS__=()=>{settingsAt=0;for(const record of mounted){record.complete=false;record.failed=false;record.output&&(record.output.textContent='');record.button&&(record.button.hidden=false)}schedule()};
 window.__RT_APPLY_SETTINGS__=value=>{Object.assign(settings,value||{});for(const record of mounted){if(record.box){record.box.hidden=value?.translationsVisible===false;record.box.style.color=value?.translationColor||''}if(record.voiceBox)record.voiceBox.hidden=value?.translationsVisible===false}schedule()};
 window.__RT_SAVE_WORKSPACE__=async()=>{const composer=editor(),conversation=current();if(composer&&conversation&&!composer.id.endsWith('-modal'))await api.saveDraft({conversationId:conversation.id,targetKey:targetKey()},text(composer));return {busy:sending||locked,editing:composing.has(composer),media:Boolean(document.querySelector('#editable-message-text-modal')),capturing:Boolean(document.querySelector('.main-button.recording'))}};
 window.__RT_INSERT_DRAFT__=value=>{const composer=editor();if(!composer||text(composer)||sending||locked||!messageList()||!current()?.writable)return false;return window.__RT_EDIT_ATOMIC__({text:value,expected:'',targetKey:targetKey(),conversationId:current()?.id})};
 const heartbeat=setInterval(()=>{if(!document.hidden)schedule()},15000);
 window.addEventListener('pagehide',event=>{if(event.persisted)return;disposed=true;observer.disconnect();clearTimeout(timer);clearInterval(heartbeat);closePreview(null);mounted.clear()});
 void scan();
})();
`
