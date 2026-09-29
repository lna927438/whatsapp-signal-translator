import {voiceAudioWav} from '../shared/voiceAudio'

export interface GoogleVoiceAudioResult {text:string;translation:string;audioId:string;targetLanguage:'zh-CN'}
interface Options {
 translateAudio:(bytes:Uint8Array)=>Promise<GoogleVoiceAudioResult>
 decode?:(url:string)=>Promise<Uint8Array>
}
type Entry={audio:HTMLAudioElement;source:string;page:string;host:HTMLElement;button:HTMLButtonElement;status:HTMLElement;output:HTMLElement;original:HTMLElement;revision:number;busy:boolean}

/** Only a visible native player owns its audio here. No Google-specific
 * voicemail selectors, hidden shared players, stream capture or remote fetch.
 * Unsupported players retain the official controls and a usable file fallback. */
export function installGoogleVoiceAudio(document:Document,options:Options):()=>void {
 const view=document.defaultView!
 if(!view||view!==view.top||view.location.origin!=='https://voice.google.com')return()=>{}
 const entries=new Map<HTMLAudioElement,Entry>(),decode=options.decode||voiceAudioWav
 let disposed=false,scheduled:number|undefined
 const fallback='此播放器暂不支持直接读取。请使用官方保存或下载功能，再打开 HelloDog 设置 → 语音翻译，选择文件转为中文。'
 const source=(audio:HTMLAudioElement)=>{
  const candidates=audio.querySelectorAll('source');if(!audio.src&&candidates.length>1)return ''
  const declared=audio.src||candidates[0]?.src||'',selected=audio.currentSrc
  // currentSrc can still point to the previous clip while a new src is loading.
  if(declared&&selected&&declared!==selected)return ''
  return declared||selected
 }
 const visible=(audio:HTMLAudioElement)=>{
  if(!audio.isConnected||!audio.controls||audio.closest('[hidden],[aria-hidden="true"]')||!audio.getClientRects().length)return false
  for(let element:Element|null=audio;element;element=element.parentElement){const style=view.getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false}
  return true
 }
 const allowed=(url:string)=>{try{const value=new URL(url);return value.protocol==='blob:'&&value.origin==='https://voice.google.com'}catch{return false}}
 const current=(entry:Entry,revision:number)=>!disposed&&entry.revision===revision&&entries.get(entry.audio)===entry&&entry.host.isConnected&&visible(entry.audio)&&entry.page===view.location.href&&source(entry.audio)===entry.source
 const clear=(entry:Entry)=>{entry.revision++;entry.host.remove();entries.delete(entry.audio)}
 function add(audio:HTMLAudioElement,url:string){
  const host=document.createElement('span');host.setAttribute('data-hellodog-voice-audio','');host.style.cssText='display:block;max-width:100%;margin:8px 0'
  const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style')
  style.textContent=':host{color-scheme:dark}.box{font:13px/1.55 system-ui,sans-serif;background:#18211e;color:#e1eee8;border:1px solid #456054;border-radius:8px;padding:10px;max-width:560px;overflow-wrap:anywhere}button{font:inherit;background:#245f49;color:#fff;border:1px solid #5c8a74;border-radius:6px;padding:6px 12px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}p{margin:8px 0 0;white-space:pre-wrap}details{margin-top:8px}summary{cursor:pointer}small{display:block;margin-top:6px;color:#bac8c1}'
  const box=document.createElement('div');box.className='box'
  const button=document.createElement('button');button.type='button';button.textContent='转为中文'
  const status=document.createElement('p');status.setAttribute('role','status')
  const output=document.createElement('p');output.setAttribute('aria-label','中文译文')
  const details=document.createElement('details'),summary=document.createElement('summary'),original=document.createElement('p');summary.textContent='查看识别原文';details.append(summary,original);details.hidden=true
  const note=document.createElement('small');note.textContent='仅处理这条播放器里的语音；不录制或翻译实时通话。'
  box.append(button,status,output,details,note);shadow.append(style,box);audio.insertAdjacentElement('afterend',host)
  const entry:Entry={audio,source:url,page:view.location.href,host,button,status,output,original,revision:0,busy:false};entries.set(audio,entry)
  if(!allowed(url)){button.hidden=true;status.textContent=fallback;return}
  button.addEventListener('click',async event=>{
   // Page scripts cannot use the isolated button to initiate a paid task.
   if(!event.isTrusted||entry.busy||!current(entry,entry.revision))return
   const revision=++entry.revision;entry.busy=true;button.disabled=true;status.textContent='正在转为中文…';output.textContent='';original.textContent='';details.hidden=true
   try{
    const bytes=await decode(entry.source);if(!current(entry,revision))return
    const result=await options.translateAudio(bytes);if(!current(entry,revision))return
    if(!result||result.targetLanguage!=='zh-CN'||typeof result.text!=='string'||!result.text.trim()||Array.from(result.text).length>12000||typeof result.translation!=='string'||!result.translation.trim()||result.translation.length>40000||!/^[a-f0-9]{64}$/.test(result.audioId))throw Error('语音翻译返回无效，请重试。')
    output.textContent=result.translation;original.textContent=result.text;details.hidden=false;status.textContent='已转为中文';button.hidden=true
   }catch{
    if(current(entry,revision))status.textContent='这次未能转为中文，可重试；若音频无法读取，请保存文件后在 HelloDog 设置 → 语音翻译中打开。'
   }finally{if(current(entry,revision)){entry.busy=false;button.disabled=false}}
  })
 }
 function scan(){
  scheduled=undefined;if(disposed)return
  for(const entry of [...entries.values()])if(!visible(entry.audio)||entry.source!==source(entry.audio)||entry.page!==view.location.href||!entry.host.isConnected)clear(entry)
  if(view.location.origin!=='https://voice.google.com')return
  for(const audio of document.querySelectorAll<HTMLAudioElement>('audio[controls]'))if(!entries.has(audio)&&visible(audio))add(audio,source(audio))
 }
 const schedule=()=>{if(!disposed&&scheduled===undefined)scheduled=view.setTimeout(scan,120)}
 const invalidate=()=>{for(const entry of [...entries.values()])clear(entry);schedule()}
 const observer=new view.MutationObserver(schedule)
 observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['src','controls','hidden','aria-hidden','style','class']})
 document.addEventListener('loadedmetadata',schedule,true);document.addEventListener('emptied',schedule,true)
 view.addEventListener('popstate',invalidate);view.addEventListener('hashchange',invalidate);view.addEventListener('resize',schedule)
 schedule()
 const stop=()=>{if(disposed)return;disposed=true;view.clearTimeout(scheduled);observer.disconnect();for(const entry of [...entries.values()])clear(entry);document.removeEventListener('loadedmetadata',schedule,true);document.removeEventListener('emptied',schedule,true);view.removeEventListener('popstate',invalidate);view.removeEventListener('hashchange',invalidate);view.removeEventListener('resize',schedule);view.removeEventListener('pagehide',stop)}
 view.addEventListener('pagehide',stop)
 return stop
}
