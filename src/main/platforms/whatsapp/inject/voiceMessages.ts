import { voiceAudioWav } from '../../../../shared/voiceAudio'

export const whatsappVoiceScript=String.raw`
(()=>{
 if(window.__HD_VOICE_INSTALLED__)return;window.__HD_VOICE_INSTALLED__=true;
 const decode=${voiceAudioWav.toString()};
 const rowSelector='.message-in,.message-out,[data-testid="msg-container"]';
 const records=new WeakMap(),mounted=new Set(),audioBindings=new WeakMap();let scheduled=false,epoch=0,context;
 const identity=row=>{
  const node=row.closest('[data-id]')||row.querySelector('[data-id]'),id=node?.getAttribute('data-id')||'';
  const match=id.match(/^(?:true|false)_([^_]+@[^_]+)_(.+)$/);
  return match?{messageId:'voice:'+id,conversationId:'peer:'+match[1],node}:null;
 };
 const rows=main=>Array.from(main?.querySelectorAll(rowSelector)||[]).filter(row=>!row.parentElement?.closest(rowSelector));
 const current=()=>{
  const main=document.querySelector('#main'),header=main?.querySelector('header');
  const peers=new Set(rows(main).map(identity).filter(Boolean).map(key=>key.conversationId));
  const title=Array.from(header?.querySelectorAll('[data-testid="conversation-info-header-chat-title"],span[title][dir="auto"]')||[]).find(node=>!node.closest('[data-rt-ui]'));
  return {main,header,peer:peers.size===1?[...peers][0]:'',title:title?.getAttribute('title')||title?.textContent||''};
 };
 function interrupt(record){if(!record.busy)return;record.run++;record.busy=false;record.button.disabled=false;record.button.textContent='重试转中文';record.status.textContent='页面或语音已变化，请在原消息上重试。'}
 function refreshContext(){const next=current();if(context&&(next.main!==context.main||next.header!==context.header||next.peer!==context.peer||next.title!==context.title)){epoch++;for(const record of mounted)interrupt(record)}context=next;return next}
 const source=audio=>audio?.currentSrc||audio?.src||'';
 const audioFor=row=>{
  const key=identity(row);if(!key)return null;
  // An external player is usable only with the exact durable message ID.
  // Never infer its owner from the last click, playback time, or DOM proximity.
  const matches=Array.from(document.querySelectorAll('audio')).filter(audio=>identity(audio)?.messageId===key.messageId&&source(audio));
  if(matches.length!==1)return null;
  const audio=matches[0],url=source(audio),previous=audioBindings.get(audio);
  // A virtualized row can acquire a new ID before its old audio is replaced.
  if(previous&&previous.url===url&&previous.id!==key.messageId)return null;
  audioBindings.set(audio,{id:key.messageId,url});return audio;
 };
 function mount(row){
  const key=identity(row);if(!key)return;
  const ownedAudio=audioFor(row);
  let record=records.get(row);
  if(record?.id===key.messageId&&record.box.isConnected){
   mounted.add(record);
   if(record.completed&&(record.completed.audio!==ownedAudio||record.completed.url!==source(ownedAudio))){record.completed=null;record.output.hidden=true;record.output.textContent='';record.original.hidden=true;record.transcript.textContent='';record.button.hidden=false;record.button.disabled=false;record.button.textContent='转为中文';record.status.textContent='语音已更新，请重新转为中文。'}
   return;
  }
  if(record){interrupt(record);record.box.remove();mounted.delete(record)}
  const box=document.createElement('div');box.dataset.rtUi='voice';box.className='rt-voice-translation';
  box.style.cssText='display:block;padding:6px 0;max-width:100%;font-size:12px;line-height:1.5;white-space:normal';
  const button=document.createElement('button');button.type='button';button.textContent='转为中文';
  button.style.cssText='color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:4px 8px;cursor:pointer';
  const status=document.createElement('div');status.setAttribute('role','status');status.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';
  const output=document.createElement('div');output.dataset.voiceTranslation='true';output.style.cssText='padding-top:6px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere';output.hidden=true;
  const original=document.createElement('details');original.hidden=true;const summary=document.createElement('summary');summary.textContent='识别原文';summary.style.cursor='pointer';const transcript=document.createElement('div');transcript.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';original.append(summary,transcript);
  box.append(button,status,output,original);row.appendChild(box);record={id:key.messageId,row,box,button,status,output,original,transcript,run:0,busy:false,completed:null};records.set(row,record);mounted.add(record);
  box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('keydown',e=>e.stopPropagation());
  button.onclick=async()=>{
   const state=refreshContext();
   if(button.disabled||record.busy||!row.isConnected||records.get(row)!==record||identity(row)?.messageId!==key.messageId||state.peer!==key.conversationId||!state.main?.contains(row))return;
   const run=++record.run,version=epoch,audio=audioFor(row),url=source(audio);
   const valid=()=>{const now=refreshContext();return record.run===run&&epoch===version&&row.isConnected&&records.get(row)===record&&identity(row)?.messageId===key.messageId&&now.main===state.main&&now.header===state.header&&now.peer===key.conversationId&&Boolean(audio?.isConnected)&&audioFor(row)===audio&&source(audio)===url};
   record.busy=true;button.disabled=true;button.textContent='处理中…';status.textContent='正在读取语音…';output.hidden=true;output.textContent='';original.hidden=true;transcript.textContent='';
   try{
    if(!url)throw new Error('请先下载或播放这条语音，再重试。仍无法读取时，可保存语音文件后到“设置 → 语音翻译”处理。');
    if(typeof window.realtimeTranslator?.translateVoiceMessage!=='function')throw new Error('语音翻译尚未准备好，请重新打开此账号窗口。');
    const bytes=await decode(url);if(!valid())return;status.textContent='正在识别并转为中文…';
    const result=await window.realtimeTranslator.translateVoiceMessage({bytes,messageId:key.messageId,conversationId:key.conversationId});if(!valid())return;
    if(result?.targetLanguage!=='zh-CN'||typeof result?.translation!=='string'||!result.translation.trim()||typeof result?.text!=='string'||!result.text.trim()||!/^[a-f0-9]{64}$/.test(result?.audioId||''))throw new Error('未取得完整的中文结果，请重试。');
    output.textContent=result.translation;output.hidden=false;transcript.textContent=result.text;original.hidden=false;
    record.completed={audio,url};status.textContent='已转为中文';button.textContent='已转为中文';button.disabled=true;button.hidden=true;
   }catch(error){if(record.run===run&&row.isConnected&&records.get(row)===record){status.textContent=audio&&!valid()?'页面或语音已变化，请在原消息上重试。':error?.message||'语音翻译失败，请重试。';button.textContent='重试转中文';button.disabled=false}}
   finally{if(record.run===run){record.busy=false;if(output.hidden){button.disabled=false;button.textContent='重试转中文';if(status.textContent==='正在读取语音…'||status.textContent==='正在识别并转为中文…')status.textContent='页面或语音已变化，请在原消息上重试。'}}}
  };
 }
 function scan(){scheduled=false;refreshContext();
  for(const record of mounted)if(!record.row.isConnected){interrupt(record);mounted.delete(record)}
  for(const row of rows(document.querySelector('#main'))){
   if(row.querySelector('audio,[data-icon*="audio-play"],[data-icon*="audio-pause"],[data-icon*="ptt"],[data-testid="audio-play"],button[aria-label*="voice message"],button[aria-label*="语音消息"]'))mount(row);
  }
 }
 const observer=new MutationObserver(changes=>{
  refreshContext();
  for(const record of mounted){
   if(!record.busy)continue;
   const changed=changes.some(change=>change.type==='attributes'&&change.attributeName==='data-id'&&(change.target.contains(record.row)||record.row.contains(change.target))||change.type==='childList'&&Array.from(change.removedNodes).some(node=>node===record.row||node.contains?.(record.row)));
   if(changed)interrupt(record);
  }
  if(!scheduled){scheduled=true;setTimeout(scan,100)}
 });
 // Capture navigation intent before React can replace and restore the same row.
 const navigate=event=>{const target=event.target instanceof Element?event.target:event.target?.parentElement;if(target&&!target.closest('#main')&&!target.closest('[data-rt-ui]')){epoch++;for(const record of mounted)interrupt(record)}};
 document.addEventListener('pointerdown',navigate,true);document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')navigate(event)},true);
 observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,characterData:true,attributeFilter:['data-id','src','title']});scan();
})();
`
