import { voiceAudioWav } from '../../../../shared/voiceAudio'

export const whatsappVoiceScript=String.raw`
(()=>{
 if(window.__HD_VOICE_INSTALLED__)return;
 const decode=${voiceAudioWav.toString()};
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
 const current=()=>{
  if(disposed||!window.document?.documentElement)return {main:null,header:null,peer:'',title:''};
  const main=document.querySelector('#main'),header=main?.querySelector('header');
  const peers=new Set(rows(main).map(identity).filter(key=>key?.kind==='peer').map(key=>key.conversationId));
  const title=Array.from(header?.querySelectorAll('[data-testid="conversation-info-header-chat-title"],span[title][dir="auto"]')||[]).find(node=>!node.closest('[data-rt-ui]'));
  return {main,header,peer:peers.size===1?[...peers][0]:'',title:title?.getAttribute('title')||title?.textContent||''};
 };
 function interrupt(record){if(!record.busy)return;record.run++;record.cancelSelection?.();record.busy=false;record.button.disabled=false;record.fileButton.disabled=false;record.button.textContent='重试转中文';record.status.textContent='页面或语音已变化，请在原消息上重试。'}
 function refreshContext(){const next=current();if(context&&(next.main!==context.main||next.header!==context.header||next.peer!==context.peer||next.title!==context.title)){epoch++;for(const record of mounted)interrupt(record)}context=next;return next}
 const source=audio=>audio?.currentSrc||audio?.src||audio?.querySelector('source[src]')?.src||'';
 const localSource=url=>/^(?:blob:|hellodog-media:)/.test(url);
 const audioFor=row=>{
  const key=identity(row);if(!key)return null;
  // An external player is usable only with the exact durable message ID.
  // Never infer its owner from the last click, playback time, or DOM proximity.
  const matches=Array.from(document.querySelectorAll('audio')).filter(audio=>!audio.closest(quoteSelector)&&identity(audio)?.messageId===key.messageId&&source(audio));
  if(matches.length!==1)return null;
  const audio=matches[0],declared=audio.src||audio.querySelector('source[src]')?.src||'',url=source(audio),previous=audioBindings.get(audio);
  if(audio.currentSrc&&declared&&audio.currentSrc!==declared)return null;
  // A virtualized row can acquire a new ID before its old audio is replaced.
  if(previous&&previous.url===url&&previous.id!==key.messageId)return null;
  audioBindings.set(audio,{id:key.messageId,url});return audio;
 };
 function chooseFile(record){return new Promise((resolve,reject)=>{
  const input=document.createElement('input');input.type='file';input.accept='audio/*,.ogg,.opus,.m4a,.mp3,.wav,.aac,.webm';input.hidden=true;input.dataset.rtUi='voice-file';record.box.append(input);
  let settled=false,timer;
  const finish=(file,error)=>{if(settled)return;settled=true;clearTimeout(timer);input.onchange=null;input.oncancel=null;input.remove();record.cancelSelection=null;error?reject(error):resolve(file)};
  record.cancelSelection=()=>finish(null,new Error('页面或语音已变化，请在原消息上重试。'));
  input.onchange=()=>{const file=input.files?.[0];if(!file)return finish(null,new Error('已取消选择，原语音已保留。'));if(!file.size||file.size>20*1024*1024)return finish(null,new Error('请选择不超过 20 MB 的本条语音文件。'));finish(file)};
  input.oncancel=()=>finish(null,new Error('已取消选择，原语音已保留。'));
  timer=setTimeout(()=>finish(null,new Error('文件选择已结束，请在这条语音上重试。')),120000);
  try{input.click()}catch{finish(null,new Error('无法打开文件选择，请重试。'))}
 })}
 function mount(row){
  const key=identity(row);if(!key)return;
  const ownedAudio=audioFor(row);
  let record=records.get(row);
  if(record?.id===key.messageId&&record.owner===key.node&&record.box.isConnected){
   mounted.add(record);
   // Lazy players may unload after use. Only a new known source invalidates a
   // completed result; losing a player alone must not erase text or invite billing.
   if(record.completed?.kind==='direct'&&ownedAudio&&record.completed.url!==source(ownedAudio)){record.completed=null;record.output.hidden=true;record.output.textContent='';record.english.hidden=true;record.english.textContent='';record.original.hidden=true;record.transcript.textContent='';record.button.hidden=false;record.button.disabled=false;record.button.textContent='转为中文';record.status.textContent='语音已更新，请重新转为中文。'}
   return;
  }
  if(record){interrupt(record);record.box.remove();mounted.delete(record)}
  const box=document.createElement('div');box.dataset.rtUi='voice';box.className='rt-voice-translation';
  box.style.cssText='display:block;padding:6px 0;max-width:100%;font-size:12px;line-height:1.5;white-space:normal';
  const button=document.createElement('button');button.type='button';button.textContent='转为中文';
  button.style.cssText='color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:4px 8px;cursor:pointer';
  const fileButton=document.createElement('button');fileButton.type='button';fileButton.textContent='选择本条语音文件';fileButton.style.cssText=button.style.cssText+';margin-left:6px';fileButton.hidden=true;
  const status=document.createElement('div');status.setAttribute('role','status');status.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';
  const output=document.createElement('div');output.dataset.voiceTranslation='true';output.style.cssText='padding-top:6px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere';output.hidden=true;
  output.lang='zh-CN';output.setAttribute('aria-label','中文译文');
  const english=document.createElement('div');english.dataset.voiceEnglish='true';english.lang='en';english.setAttribute('aria-label','英文译文');english.style.cssText=output.style.cssText;english.hidden=true;
  const original=document.createElement('details');original.hidden=true;const summary=document.createElement('summary');summary.textContent='识别原文';summary.style.cursor='pointer';const transcript=document.createElement('div');transcript.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';original.append(summary,transcript);
  const bubble=Array.from(row.querySelectorAll('[data-testid="msg-container"],.copyable-text,'+bubbleSelector)).find(node=>!node.closest(quoteSelector)&&node.contains(voiceControl(row)))||row;
  box.append(button,fileButton,status,english,output,original);bubble.appendChild(box);record={id:key.messageId,owner:key.node,row,box,button,fileButton,status,output,english,original,transcript,run:0,busy:false,completed:null,cancelSelection:null};records.set(row,record);mounted.add(record);
  box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('keydown',e=>e.stopPropagation());
  const start=async(forceFile=false)=>{
   if(disposed)return;
   const state=refreshContext();
   if(button.disabled||record.busy||!row.isConnected||records.get(row)!==record||identity(row)?.messageId!==key.messageId||key.kind==='peer'&&state.peer!==key.conversationId||!state.main?.contains(row))return;
   const run=++record.run,version=epoch,audio=audioFor(row),control=voiceControl(row),url=source(audio),fileMode=forceFile||!localSource(url);let fileUrl='';
   const valid=()=>{const now=refreshContext(),live=identity(row);return !disposed&&record.run===run&&epoch===version&&row.isConnected&&records.get(row)===record&&live?.messageId===key.messageId&&live?.node===key.node&&Boolean(control?.isConnected)&&voiceControl(row)===control&&now.main===state.main&&now.header===state.header&&(key.kind==='message'||now.peer===key.conversationId)&&(fileMode||Boolean(audio?.isConnected)&&audioFor(row)===audio&&source(audio)===url)};
   record.busy=true;button.disabled=true;fileButton.disabled=true;button.textContent='处理中…';status.textContent='正在读取语音…';output.hidden=true;output.textContent='';english.hidden=true;english.textContent='';original.hidden=true;transcript.textContent='';
   try{
    if(typeof window.realtimeTranslator?.translateVoiceMessage!=='function')throw new Error('语音翻译尚未准备好，请重新打开此账号窗口。');
    if(fileMode){status.textContent='请选择从这条语音下载的音频文件，译文会显示在当前气泡内。';const file=await chooseFile(record);if(!valid())return;fileUrl=URL.createObjectURL(file)}
    const bytes=await decode(fileUrl||url);if(!valid())return;status.textContent='正在识别并转为中文…';
    const result=await window.realtimeTranslator.translateVoiceMessage({bytes,messageId:key.messageId,conversationId:key.conversationId});if(!valid())return;
    if(result?.targetLanguage!=='zh-CN'||typeof result?.translation!=='string'||!result.translation.trim()||result.translation.length>40000||typeof result?.englishTranslation!=='string'||!result.englishTranslation.trim()||result.englishTranslation.length>40000||typeof result?.text!=='string'||!result.text.trim()||!/^[a-f0-9]{64}$/.test(result?.audioId||''))throw new Error('未取得完整的中文和英文结果，请重试。');
    english.textContent=result.englishTranslation;english.hidden=false;output.textContent=result.translation;output.hidden=false;transcript.textContent=result.text;original.hidden=result.text===result.translation||result.text===result.englishTranslation;
    record.completed={kind:fileMode?'file':'direct',audio,url};status.textContent='已转为中文';button.textContent='已转为中文';button.disabled=true;button.hidden=true;fileButton.hidden=true;
   }catch(error){if(record.run===run&&row.isConnected&&records.get(row)===record){status.textContent=!valid()?'页面或语音已变化，请在原消息上重试。':error?.message||'语音翻译失败，请重试。';button.textContent='重试转中文';button.disabled=false;if(!fileMode&&valid())fileButton.hidden=false}}
   finally{if(fileUrl)URL.revokeObjectURL(fileUrl);if(record.run===run){record.busy=false;fileButton.disabled=false;if(output.hidden){button.disabled=false;button.textContent='重试转中文';if(status.textContent==='正在读取语音…'||status.textContent==='正在识别并转为中文…')status.textContent='页面或语音已变化，请在原消息上重试。'}}}
  };
  button.onclick=()=>start();fileButton.onclick=()=>start(true);
 }
 function scan(){scheduled=false;scanTimer=undefined;if(disposed||!window.document?.documentElement)return;refreshContext();
  for(const record of mounted)if(!record.row.isConnected||!voiceControl(record.row)){interrupt(record);record.box.remove();records.delete(record.row);mounted.delete(record)}
  for(const row of rows(document.querySelector('#main'))){
   if(voiceControl(row))mount(row);
  }
 }
 const observer=new MutationObserver(changes=>{
  if(disposed||!window.document?.documentElement)return;
  if(changes.every(change=>(change.target instanceof Element?change.target:change.target.parentElement)?.closest('[data-rt-ui]')))return;
  refreshContext();
  for(const record of mounted){
   if(!record.busy)continue;
   const changed=changes.some(change=>change.type==='attributes'&&change.attributeName==='data-id'&&(change.target.contains(record.row)||record.row.contains(change.target))||change.type==='childList'&&Array.from(change.removedNodes).some(node=>node===record.row||node.contains?.(record.row)));
   if(changed)interrupt(record);
  }
  if(!scheduled){scheduled=true;scanTimer=setTimeout(scan,100)}
 });
 // Capture navigation intent before React can replace and restore the same row.
 const navigate=event=>{const target=event.target instanceof Element?event.target:event.target?.parentElement;if(target&&!target.closest('#main')&&!target.closest('[data-rt-ui]')){epoch++;for(const record of mounted)interrupt(record)}};
 const navigateKey=event=>{if(event.key==='Enter'||event.key===' ')navigate(event)};
 const cleanup=()=>{
  disposed=true;epoch++;observer.disconnect();clearTimeout(scanTimer);scheduled=false;
  document.removeEventListener('pointerdown',navigate,true);document.removeEventListener('keydown',navigateKey,true);
  window.removeEventListener('pagehide',pagehide);
  for(const record of mounted){interrupt(record);record.button.onclick=null;record.fileButton.onclick=null}mounted.clear();context=null;
 };
 const pagehide=event=>{if(!event.persisted&&!disposed)cleanup()};
 try{
  document.addEventListener('pointerdown',navigate,true);document.addEventListener('keydown',navigateKey,true);window.addEventListener('pagehide',pagehide);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,characterData:true,attributeFilter:['data-id','src','title','data-icon','data-testid','aria-label']});scan();
  window.__HD_VOICE_INSTALLED__=true;
 }catch(error){for(const record of mounted)record.box.remove();cleanup();throw error}
})();
`
