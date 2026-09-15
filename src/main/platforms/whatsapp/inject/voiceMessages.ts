import { voiceAudioWav } from '../../../../shared/voiceAudio'

export const whatsappVoiceScript=String.raw`
(()=>{
 if(window.__HD_VOICE_INSTALLED__)return;window.__HD_VOICE_INSTALLED__=true;
 const decode=${voiceAudioWav.toString()};
 const records=new WeakMap();let scheduled=false;
 const identity=row=>{
  const node=row.closest('[data-id]')||row.querySelector('[data-id]');const id=node?.getAttribute('data-id')||'';
  const match=id.match(/^(?:true|false)_([^_]+@[^_]+)_/);
  return match?{messageId:'voice:'+id,conversationId:'peer:'+match[1]}:null;
 };
 const active=()=>Array.from(document.querySelectorAll('#main [data-id]')).map(x=>x.getAttribute('data-id')||'').find(x=>/^(?:true|false)_[^_]+@[^_]+_/.test(x))?.match(/^(?:true|false)_([^_]+@[^_]+)_/)?.[1]||'';
 const runtimeConversation=()=>{
  const header=document.querySelector('#main header');if(!header)return null;
  const normalize=text=>String(text||'').replace(/\u00a0/g,' ').replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'').replace(/\s+/g,' ').trim();
  let name='';for(const selector of ['[data-testid="conversation-info-header-chat-title"]','span[title][dir="auto"]','[title][dir="auto"]','span[title]']){
   name=Array.from(header.querySelectorAll(selector)).filter(node=>!node.closest('[data-rt-ui]')).map(node=>normalize(node.getAttribute('title')||node.textContent||'')).find(value=>value&&value.length<160)||'';if(name)break;
  }
  if(!name)name=normalize((header.innerText||'').split('\n')[0]||'');
  return name?{conversationId:'wa:'+name.toLowerCase(),conversationName:name}:null;
 };
 const audioFor=row=>{
  const key=identity(row);if(!key)return null;
  // WhatsApp can place the player outside the message. Time since a click is
  // not proof of ownership: accept only a matching durable message ID.
  return Array.from(document.querySelectorAll('audio')).find(audio=>identity(audio)?.messageId===key.messageId)||null;
 };
 function mount(row){
  const key=identity(row);if(!key)return;
  let record=records.get(row);
  if(record?.id===key.messageId&&record.box.isConnected)return;
  record?.box.remove();
  const box=document.createElement('div');box.dataset.rtUi='voice';box.className='rt-voice-translation';
  box.style.cssText='display:block;padding:6px 0;max-width:100%;font-size:12px;line-height:1.5;white-space:normal';
  const recognize=document.createElement('button');recognize.type='button';recognize.textContent='翻译语音';
  recognize.style.cssText='color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:4px 8px;cursor:pointer';
  const status=document.createElement('div');status.setAttribute('role','status');status.style.cssText='padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere';
  box.append(recognize,status);row.appendChild(box);record={id:key.messageId,box};records.set(row,record);
  box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('keydown',e=>e.stopPropagation());
  const valid=()=>row.isConnected&&records.get(row)===record&&identity(row)?.messageId===key.messageId&&key.conversationId==='peer:'+active();
  recognize.onclick=async()=>{
   if(recognize.disabled||!valid())return;recognize.disabled=true;status.textContent='正在读取语音…';
   try{
    const audio=audioFor(row),url=audio?.currentSrc||audio?.src;
    if(!url)throw new Error('无法直接读取这条语音，请先保存语音文件，再打开“记录与恢复 → 快捷操作 → 语音文件翻译”。');
    const bytes=await decode(url);if(!valid())return;status.textContent='正在识别语音…';
    const result=await window.realtimeTranslator.recognizeVoice(bytes);if(!valid())return;
    if(typeof result?.text!=='string'||!result.text.trim())throw new Error('没有识别到清晰人声。');
    status.textContent='核对识别文字后翻译，可先修改识别有误的内容。';
    box.querySelector('[data-voice-review]')?.remove();
    const review=document.createElement('div');review.dataset.voiceReview='true';
    const original=document.createElement('textarea');original.value=result.text;original.maxLength=12000;original.setAttribute('aria-label','语音识别文字');
    original.style.cssText='display:block;box-sizing:border-box;width:100%;min-width:180px;max-width:100%;min-height:64px;background:transparent;color:inherit;border:1px solid #8887;border-radius:6px;padding:6px;margin-top:6px;resize:vertical';
    const translate=document.createElement('button');translate.type='button';translate.textContent='确认并翻译';translate.style.cssText=recognize.style.cssText;
    const output=document.createElement('div');output.style.cssText='padding-top:6px;white-space:pre-wrap;overflow-wrap:anywhere';output.setAttribute('role','status');
    review.append(original,translate,output);box.appendChild(review);
    translate.onclick=async()=>{
     if(translate.disabled||!valid())return;const text=original.value.trim();if(!text)return;
     translate.disabled=true;original.disabled=true;output.textContent='正在翻译…';
     try{const answer=await window.realtimeTranslator.translateIncoming({...key,...runtimeConversation(),text,manual:true,outgoing:key.messageId.startsWith('voice:true_')});if(valid()){output.textContent=answer;status.textContent='语音翻译完成';}}
     catch(error){if(valid())output.textContent=error?.message||'翻译失败，请重试。';}
     finally{if(valid()){translate.disabled=false;original.disabled=false;}}
    };
   }catch(error){if(valid())status.textContent=error?.message||'语音识别失败，请重试。';}
   finally{if(valid())recognize.disabled=false;}
  };
 }
 function scan(){scheduled=false;
  for(const row of document.querySelectorAll('#main .message-in,#main .message-out,#main [data-testid="msg-container"]')){
   if(row.parentElement?.closest('.message-in,.message-out,[data-testid="msg-container"]'))continue;
   if(row.querySelector('audio,[data-icon*="audio-play"],[data-icon*="audio-pause"],[data-icon*="ptt"],[data-testid="audio-play"],button[aria-label*="voice message"],button[aria-label*="语音消息"]'))mount(row);
  }
 }
 const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;setTimeout(scan,200)}});
 observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-id','src']});scan();
})();
`
