import { voiceAudioWav } from '../../../../shared/voiceAudio'
import { whatsappVoiceMedia } from './voiceMedia'

export const whatsappVoiceScript=String.raw`
(()=>{
 if(window.__HD_VOICE_INSTALLED__)return;
 const decode=${voiceAudioWav.toString()};
 const readMedia=${whatsappVoiceMedia.toString()};
 const bubbleSelector='.message-in,.message-out,[data-testid="msg-container"]';
 const rowSelector=bubbleSelector+',[data-id]';
 const quoteSelector='[data-testid*="quoted"],[data-testid="reply-context"],[aria-label^="Quoted message" i],[aria-label^="引用消息"],[data-rt-ui]';
 // Lazy voice controls can be role=button elements with no mounted audio yet.
 // Generic play icons also belong to videos: only accept explicit audio/voice markers.
 const voiceSelector='audio,[data-icon^="audio-"],[data-icon*="audio-play"],[data-icon*="audio-pause"],[data-icon^="ptt"],[data-testid^="audio-"],[data-testid*="ptt"],[aria-label*="voice message" i],[aria-label*="voice note" i],[aria-label*="audio message" i],[aria-label*="语音消息"],[aria-label*="播放语音"],[aria-label*="暂停语音"]';
 const voiceControl=row=>Array.from(row.querySelectorAll(voiceSelector)).find(node=>!node.closest(quoteSelector));
 const records=new WeakMap(),mounted=new Set(),audioBindings=new WeakMap();let scheduled=false,epoch=0,context,scanTimer,disposed=false;
 const nodeIdentity=node=>{
  const id=node?.getAttribute('data-id')||'';
  const match=id.match(/^(?:true|false)_([^_]+@[^_]+)_(.+)$/);
  if(match)return {messageId:'voice:'+id,conversationId:'peer:'+match[1],kind:'peer',node};
  // Current opaque IDs have no peer embedded. Scope only to this message,
  // never invent a peer from a display name shared by unrelated contacts.
  return /^[A-Za-z0-9-]{8,128}$/.test(id)?{messageId:'voice:whatsapp-message:'+id,conversationId:'whatsapp-message:'+id,kind:'message',node}:null;
 };
 const identity=row=>nodeIdentity(row)||Array.from(row.querySelectorAll('[data-id]')).filter(node=>!node.closest(quoteSelector)).map(nodeIdentity).find(Boolean)||nodeIdentity(row.closest('[data-id]'));
 const rows=main=>{
  const candidates=new Map();for(const row of main?.querySelectorAll(rowSelector)||[]){const key=identity(row);if(key&&!row.closest(quoteSelector))candidates.set(row,key)}
  // Generated data-id containers may surround several real messages. They are
  // not themselves a message and cannot absorb the IDs of their descendants.
  const containers=new Set();for(const [row,key] of candidates)for(let parent=row.parentElement;parent&&parent!==main;parent=parent.parentElement){const other=candidates.get(parent);if(other&&other.messageId!==key.messageId)containers.add(parent)}
  const messages=new Set([...candidates.keys()].filter(row=>!containers.has(row)));
  return [...messages].filter(row=>{for(let parent=row.parentElement;parent&&parent!==main;parent=parent.parentElement)if(messages.has(parent))return false;return true});
 };
 const current=knownRows=>{
  if(disposed||!window.document?.documentElement)return {main:null,header:null,peer:'',title:''};
  const main=document.querySelector('#main'),header=main?.querySelector('header');
  const peers=new Set((knownRows||rows(main)).map(identity).filter(key=>key?.kind==='peer').map(key=>key.conversationId));
  const title=Array.from(header?.querySelectorAll('[data-testid="conversation-info-header-chat-title"],span[title][dir="auto"]')||[]).find(node=>!node.closest('[data-rt-ui]'));
  return {main,header,peer:peers.size===1?[...peers][0]:'',title:title?.getAttribute('title')||title?.textContent||''};
 };
 function interrupt(record){if(!record.busy)return;record.run++;record.cancelRead?.();record.busy=false;record.button.disabled=false;record.button.textContent='重试转中文';record.status.textContent='页面或语音已变化，请在原消息上重试。'}
 function refreshContext(knownRows){const next=current(knownRows);if(context&&(next.main!==context.main||next.header!==context.header||next.peer!==context.peer||next.title!==context.title)){epoch++;for(const record of mounted)interrupt(record)}context=next;return next}
 const source=audio=>audio?.currentSrc||audio?.src||audio?.querySelector('source[src]')?.src||'';
 const localSource=url=>/^(?:blob:|hellodog-media:)/.test(url);
 const audioIndex=()=>{const index=new Map();for(const audio of document.querySelectorAll('audio')){if(audio.closest(quoteSelector)||!source(audio))continue;const id=identity(audio)?.messageId;if(id){const matches=index.get(id)||[];matches.push(audio);index.set(id,matches)}}return index};
 const audioFor=(row,index)=>{
  const key=identity(row);if(!key)return null;
  // An external player is usable only with the exact durable message ID.
  // Never infer its owner from the last click, playback time, or DOM proximity.
  const matches=(index||audioIndex()).get(key.messageId)||[];
  if(matches.length!==1)return null;
  const audio=matches[0],declared=audio.src||audio.querySelector('source[src]')?.src||'',url=source(audio),previous=audioBindings.get(audio);
  if(audio.currentSrc&&declared&&audio.currentSrc!==declared)return null;
  // A virtualized row can acquire a new ID before its old audio is replaced.
  if(previous&&previous.url===url&&previous.id!==key.messageId)return null;
  audioBindings.set(audio,{id:key.messageId,url});return audio;
 };
 function bubbleFor(row){
  const control=voiceControl(row);let semantic=null;
  for(let node=control?.parentElement;node&&row.contains(node);node=node.parentElement){
   if(node.matches('button,[role="button"],audio,svg')||node.closest(quoteSelector))continue;
   if(node.matches('.copyable-text,[data-testid="msg-container"]')&&!semantic)semantic=node;
   const style=getComputedStyle(node),background=style.backgroundColor,rect=node.getBoundingClientRect();
   if(background&&background!=='transparent'&&!/^rgba\([^)]*,\s*0\s*\)$/.test(background)&&parseFloat(style.borderRadius)>0&&(rect.width>=160||!rect.width))return node;
  }
  return semantic||Array.from(row.querySelectorAll(bubbleSelector)).find(node=>node.contains(control))||row;
 }
 function mount(row,index){
  const key=identity(row);if(!key)return;
  const ownedAudio=audioFor(row,index);
  let record=records.get(row);
  if(record?.id===key.messageId&&record.owner===key.node&&record.box.isConnected){
   mounted.add(record);
   // Lazy players may unload after use. Only a new known source invalidates a
   // completed result; losing a player alone must not erase text or invite billing.
   if(record.completed?.kind==='direct'&&ownedAudio&&record.completed.url!==source(ownedAudio)||record.completed?.kind==='model'&&!record.completed.current()){record.completed=null;record.output.hidden=true;record.output.textContent='';record.english.hidden=true;record.english.textContent='';record.original.hidden=true;record.transcript.textContent='';record.button.hidden=false;record.button.disabled=false;record.button.textContent='转为中文';record.status.textContent='语音已更新，请重新转为中文。'}
   return;
  }
  if(record){interrupt(record);record.box.remove();mounted.delete(record)}
  const box=document.createElement('div');box.dataset.rtUi='voice';box.className='rt-voice-translation';
  box.style.cssText='display:block;box-sizing:border-box;flex:0 0 100%;width:100%;padding:6px 8px;max-width:100%;font-size:12px;line-height:1.5;white-space:normal';
  const button=document.createElement('button');button.type='button';button.textContent='转为中文';
  button.style.cssText='color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:4px 8px;cursor:pointer';
  const status=document.createElement('div');status.setAttribute('role','status');status.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';
  const output=document.createElement('div');output.dataset.voiceTranslation='true';output.style.cssText='padding-top:6px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere';output.hidden=true;
  output.lang='zh-CN';output.setAttribute('aria-label','中文译文');
  const english=document.createElement('div');english.dataset.voiceEnglish='true';english.lang='en';english.setAttribute('aria-label','英文译文');english.style.cssText=output.style.cssText;english.hidden=true;
  const original=document.createElement('details');original.hidden=true;const summary=document.createElement('summary');summary.textContent='识别原文';summary.style.cursor='pointer';const transcript=document.createElement('div');transcript.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';original.append(summary,transcript);
  const bubble=bubbleFor(row),layout=getComputedStyle(bubble);
  if(layout.display==='flex'&&layout.flexDirection!=='column'&&layout.flexDirection!=='column-reverse')bubble.style.flexWrap='wrap';
  box.append(button,status,english,output,original);bubble.appendChild(box);record={id:key.messageId,owner:key.node,row,box,button,status,output,english,original,transcript,run:0,busy:false,completed:null,cancelRead:null};records.set(row,record);mounted.add(record);
  box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('keydown',e=>e.stopPropagation());
  const start=async()=>{
   if(disposed)return;
   const state=refreshContext();
   if(button.disabled||record.busy||!row.isConnected||records.get(row)!==record||identity(row)?.messageId!==key.messageId||key.kind==='peer'&&state.peer!==key.conversationId||!state.main?.contains(row))return;
   const run=++record.run,version=epoch,audio=audioFor(row),control=voiceControl(row),url=source(audio),modelMode=!localSource(url);let mediaUrl='',media,expired=false,timeoutMessage='';
   const valid=()=>{const now=refreshContext(),live=identity(row);return !disposed&&!expired&&record.run===run&&epoch===version&&row.isConnected&&records.get(row)===record&&live?.messageId===key.messageId&&live?.node===key.node&&Boolean(control?.isConnected)&&voiceControl(row)===control&&now.main===state.main&&now.header===state.header&&(key.kind==='message'||now.peer===key.conversationId)&&(modelMode||Boolean(audio?.isConnected)&&audioFor(row)===audio&&source(audio)===url)};
   const bounded=(work,ms,message)=>new Promise((resolve,reject)=>{
    let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(record.cancelRead===cancel)record.cancelRead=null;error?reject(error):resolve(value)};
    const cancel=()=>finish(new Error('页面或语音已变化，请在原消息上重试。'));
    const timer=setTimeout(()=>{expired=true;timeoutMessage=message;finish(new Error(message))},ms);record.cancelRead=cancel;
    Promise.resolve(work).then(value=>finish(null,value),error=>finish(error));
   });
   record.busy=true;button.disabled=true;button.textContent='处理中…';status.textContent='正在读取语音…';output.hidden=true;output.textContent='';english.hidden=true;english.textContent='';original.hidden=true;transcript.textContent='';
   try{
    if(typeof window.realtimeTranslator?.translateVoiceMessage!=='function')throw new Error('语音翻译尚未准备好，请重新打开此账号窗口。');
    if(modelMode){
     media=await bounded(readMedia(row,key.node.getAttribute('data-id'),valid),45000,'读取语音超时，请检查连接后重试。');if(!valid()||!media.current())return;mediaUrl=URL.createObjectURL(media.blob);
    }
    const bytes=await bounded(decode(mediaUrl||url),45000,'语音解码超时，请在原消息上重试。');if(!valid()||media&&!media.current())return;status.textContent='正在识别并转为中文…';
    const result=await bounded(window.realtimeTranslator.translateVoiceMessage({bytes,messageId:key.messageId,conversationId:key.conversationId}),330000,'语音翻译超时，请在原消息上重试。');if(!valid()||media&&!media.current())return;
    if(result?.targetLanguage!=='zh-CN'||typeof result?.translation!=='string'||!result.translation.trim()||result.translation.length>40000||typeof result?.englishTranslation!=='string'||!result.englishTranslation.trim()||result.englishTranslation.length>40000||typeof result?.text!=='string'||!result.text.trim()||!/^[a-f0-9]{64}$/.test(result?.audioId||''))throw new Error('未取得完整的中文和英文结果，请重试。');
    english.textContent=result.englishTranslation;english.hidden=false;output.textContent=result.translation;output.hidden=false;transcript.textContent=result.text;original.hidden=result.text===result.translation||result.text===result.englishTranslation;
    record.completed={kind:modelMode?'model':'direct',audio,url,current:media?.current};status.textContent='已转为中文';button.textContent='已转为中文';button.disabled=true;button.hidden=true;
   }catch(error){if(record.run===run&&row.isConnected&&records.get(row)===record){status.textContent=expired?timeoutMessage:!valid()?'页面或语音已变化，请在原消息上重试。':error?.message||'语音翻译失败，请重试。';button.textContent='重试转中文';button.disabled=false}}
   finally{if(mediaUrl)URL.revokeObjectURL(mediaUrl);if(record.run===run){record.busy=false;if(output.hidden){button.disabled=false;button.textContent='重试转中文';if(status.textContent==='正在读取语音…'||status.textContent==='正在识别并转为中文…')status.textContent='页面或语音已变化，请在原消息上重试。'}}}
  };
  button.onclick=()=>start();
 }
 function scan(){clearTimeout(scanTimer);scheduled=false;scanTimer=undefined;if(disposed||!window.document?.documentElement||document.hidden)return;const messageRows=rows(document.querySelector('#main'));refreshContext(messageRows);const index=audioIndex();
  for(const record of mounted)if(!record.row.isConnected||!voiceControl(record.row)){interrupt(record);record.box.remove();records.delete(record.row);mounted.delete(record)}
  for(const row of messageRows){
   if(voiceControl(row))mount(row,index);
  }
 }
 const observer=new MutationObserver(changes=>{
  if(disposed||!window.document?.documentElement)return;
  if(changes.every(change=>(change.target instanceof Element?change.target:change.target.parentElement)?.closest('[data-rt-ui]')))return;
  // Idle page mutations coalesce into one scan. Only in-flight work needs an
  // immediate context check, including while the window is in the background.
  if([...mounted].some(record=>record.busy))refreshContext();
  for(const record of mounted){
   if(!record.busy)continue;
   const changed=changes.some(change=>change.type==='attributes'&&change.attributeName==='data-id'&&(change.target.contains(record.row)||record.row.contains(change.target))||change.type==='childList'&&Array.from(change.removedNodes).some(node=>node===record.row||node.contains?.(record.row)));
   if(changed)interrupt(record);
  }
  if(!document.hidden&&!scheduled){scheduled=true;scanTimer=setTimeout(scan,100)}
 });
 // Capture navigation intent before React can replace and restore the same row.
 const navigate=event=>{const target=event.target instanceof Element?event.target:event.target?.parentElement;if(target&&!target.closest('#main')&&!target.closest('[data-rt-ui]')){epoch++;for(const record of mounted)interrupt(record)}};
 const navigateKey=event=>{if(event.key==='Enter'||event.key===' ')navigate(event)};
 const visibility=()=>{if(document.hidden){clearTimeout(scanTimer);scanTimer=undefined;scheduled=false}else scan()};
 const cleanup=()=>{
  disposed=true;epoch++;observer.disconnect();clearTimeout(scanTimer);scheduled=false;
  document.removeEventListener('visibilitychange',visibility);document.removeEventListener('pointerdown',navigate,true);document.removeEventListener('keydown',navigateKey,true);
  window.removeEventListener('pagehide',pagehide);
  for(const record of mounted){interrupt(record);record.button.onclick=null}mounted.clear();context=null;
 };
 const pagehide=event=>{if(!event.persisted&&!disposed)cleanup()};
 try{
  document.addEventListener('visibilitychange',visibility);document.addEventListener('pointerdown',navigate,true);document.addEventListener('keydown',navigateKey,true);window.addEventListener('pagehide',pagehide);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,characterData:true,attributeFilter:['data-id','src','title','data-icon','data-testid','aria-label']});scan();
  window.__HD_VOICE_INSTALLED__=true;
 }catch(error){for(const record of mounted)record.box.remove();cleanup();throw error}
})();
`
