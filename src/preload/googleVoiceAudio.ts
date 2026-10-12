import {voiceAudioWav} from '../shared/voiceAudio'

export interface GoogleVoiceAudioResult {text:string;translation:string;englishTranslation:string;audioId:string;targetLanguage:'zh-CN'}
export interface GoogleVoiceAudioContext {conversationId:string;messageId:string}
interface Options {
 translateAudio:(bytes:Uint8Array,context:GoogleVoiceAudioContext)=>Promise<GoogleVoiceAudioResult>
 decode?:(url:string)=>Promise<Uint8Array>
}
const customPlayers='gv-audio-player,gv-voicemail-player,[gv-test-id="audio-player"],[gv-test-id="voicemail-player"],.gv-audio-player,.voicemail-player,.audio-player'
const messageRows='[data-message-id],[data-voicemail-id],gv-voicemail-message,gv-voicemail-detail,gv-voicemail-details,gv-voicemail-thread,gv-message-item,gv-message'
const liveControls='gv-active-call,gv-call-controls,gv-call-dialer,[gv-test-id="active-call"],[gv-test-id="call-controls"]'
const ownUi='[data-hellodog-voice-audio]'
const identities=['data-message-id','data-voicemail-id','data-id','id']
type Candidate={player:HTMLElement;native:boolean;row:HTMLElement;identity:string;audio?:HTMLAudioElement;source:string}
type Entry=Candidate&{page:string;host:HTMLElement;revision:number;busy:boolean;restoreWrap?:()=>void}
// Context/provider changes reinstall this module on the same document. Keep
// fallback row identities stable there, without sharing them across documents.
const documentRowKeys=new WeakMap<Document,WeakMap<Element,string>>()
// A virtualized player can retain its previous blob while the message/route
// changes. Remember every observed URL owner for this audio node, including
// across same-document reinstalls; a second scan must not adopt stale media.
const documentAudioOwners=new WeakMap<Document,WeakMap<HTMLAudioElement,Map<string,string>>>()

/** Custom controls still get an entry when Google uses shared media. Direct
 * decoding requires one audio descendant owned by that player; otherwise the
 * explicit local file chooser stays in this bubble. Never infer global audio
 * ownership from a play click or record a live call. */
export function installGoogleVoiceAudio(document:Document,options:Options):()=>void {
 const view=document.defaultView!
 if(!view||view!==view.top||view.location.origin!=='https://voice.google.com')return()=>{}
 const entries=new Map<HTMLElement,Entry>(),rowKeys=documentRowKeys.get(document)||new WeakMap<Element,string>(),decode=options.decode||voiceAudioWav
 documentRowKeys.set(document,rowKeys)
 const audioOwners=documentAudioOwners.get(document)||new WeakMap<HTMLAudioElement,Map<string,string>>()
 documentAudioOwners.set(document,audioOwners)
 let disposed=false,scheduled:number|undefined
 const visible=(element:HTMLElement)=>{
  if(!element.isConnected||element.closest('[hidden],[inert],[aria-hidden="true"]')||!element.getClientRects().length)return false
  for(let node:Element|null=element;node;node=node.parentElement){const style=view.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false}
  return true
 }
 const source=(audio?:HTMLAudioElement)=>{
  if(!audio||audio.srcObject)return ''
  const candidates=audio.querySelectorAll('source');if(!audio.src&&candidates.length>1)return ''
  const declared=audio.src||candidates[0]?.src||'',selected=audio.currentSrc
  return declared&&selected&&declared!==selected?'':declared||selected
 }
 const allowed=(url:string)=>{try{const value=new URL(url);return value.protocol==='blob:'&&value.origin==='https://voice.google.com'}catch{return false}}
 const excluded=(element:Element)=>Boolean(element.closest(ownUi+','+liveControls))||/\/settings(?:\/|$)/.test(view.location.pathname)
 const playControl=(element:Element)=>{
  const label=(element.getAttribute('aria-label')||element.getAttribute('title')||'').trim()
  const icon=element.querySelector('mat-icon,[data-mat-icon-name],.material-icons,.google-symbols')
  const iconName=(icon?.getAttribute('data-mat-icon-name')||icon?.textContent||'').trim()
  return /^(?:play|pause)(?:\s+(?:(?:the|this)\s+)?(?:voicemail|voice message|message|audio|recording))?$/i.test(label)||/^(?:播放|暂停)(?:此|这条)?(?:语音|语音留言|留言|录音|音频)?$/.test(label)||/^(?:play_arrow|play_circle|play_circle_filled|pause|pause_circle|pause_circle_filled)$/.test(iconName)
 }
 const explicitVoiceControl=(element:Element)=>/voicemail|voice message|语音|留言/i.test(element.getAttribute('aria-label')||element.getAttribute('title')||'')
 const controls=(element:Element)=>[...element.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(control=>playControl(control)&&visible(control))
 const hasTimeline=(element:Element)=>Boolean(element.querySelector('[role="slider"],input[type="range"],mat-slider,audio'))||/(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/.test(element.textContent||'')
 function customRoot(control:HTMLElement):HTMLElement|undefined {
  const known=control.closest<HTMLElement>(customPlayers)
  if(known&&visible(known)&&controls(known).length<=1)return known
  // Accessible voicemail controls cover custom component variants; an
  // unrelated generic Play button alone is insufficient evidence.
  const voicemailContext=control.closest('gv-voicemail,gv-voicemail-view,gv-voicemail-detail,gv-voicemail-thread,[gv-test-id*="voicemail"],[data-voicemail-id]')||/\/voicemail(?:\/|$)/.test(view.location.pathname)
  if(!explicitVoiceControl(control)&&!voicemailContext)return
  let node=control.parentElement
  for(let depth=0;node&&depth<5;depth++,node=node.parentElement){
   if(node===document.body||node.matches('main,[role="main"],nav,[role="navigation"]'))break
   if(controls(node).length>1)break
   if(visible(node)&&hasTimeline(node))return node
  }
 }
 function candidate(player:HTMLElement,native:boolean):Candidate|undefined {
  if(excluded(player)||!visible(player))return
  if(native&&(!(player instanceof view.HTMLAudioElement)||!player.controls))return
  if(!native&&controls(player).length>1)return
  const row=player.closest<HTMLElement>(messageRows)||player
  let rowKey=''
  for(const attribute of identities){const value=row.getAttribute(attribute);if(value&&value.length<=256){rowKey=attribute+':'+value;break}}
  if(!rowKey){rowKey=rowKeys.get(row)||view.crypto.randomUUID();rowKeys.set(row,rowKey)}
  const siblings=native?[...row.querySelectorAll('audio[controls]')]:[...row.querySelectorAll<HTMLElement>(customPlayers)].filter(element=>!element.parentElement?.closest(customPlayers))
  let localKey=rowKeys.get(player);if(!localKey){localKey=view.crypto.randomUUID();rowKeys.set(player,localKey)}
  const slot=siblings.includes(player)?siblings.indexOf(player):localKey
  const identity=row===player?rowKey:rowKey+':player:'+slot
  const audios=native?[player as HTMLAudioElement]:[...player.querySelectorAll<HTMLAudioElement>('audio')].filter(audio=>!audio.closest(liveControls))
  const audio=audios.length===1&&(!audios[0].closest(customPlayers)||audios[0].closest(customPlayers)===player)?audios[0]:undefined
  if(!native&&!controls(player).length&&!(audio?.controls&&visible(audio)))return
  let directSource=source(audio)
  if(audio&&allowed(directSource)){
   const owners=audioOwners.get(audio)||new Map<string,string>(),owner=view.location.href+'\0'+identity,previous=owners.get(directSource)
   if(previous===undefined){owners.set(directSource,owner);audioOwners.set(audio,owners)}
   else if(previous!==owner)directSource=''
  }
  return {player,native,row,identity,audio,source:directSource}
 }
 const same=(entry:Entry,next?:Candidate)=>Boolean(next&&next.row===entry.row&&next.identity===entry.identity&&next.audio===entry.audio&&next.source===entry.source)
 const current=(entry:Entry,revision:number)=>!disposed&&entry.revision===revision&&entries.get(entry.player)===entry&&entry.host.isConnected&&entry.page===view.location.href&&same(entry,candidate(entry.player,entry.native))
 const clear=(entry:Entry)=>{entry.revision++;entry.host.remove();entry.restoreWrap?.();entries.delete(entry.player)}
 const fingerprint=async(value:string)=>[...new Uint8Array(await view.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
 function add(item:Candidate){
  const host=document.createElement('span');host.setAttribute('data-hellodog-voice-audio','');host.style.cssText='display:block;width:100%;max-width:100%;margin:8px 0;flex-basis:100%;grid-column:1 / -1;clear:both'
  const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style')
  style.textContent=':host{color-scheme:light dark}.box{font:13px/1.55 system-ui,sans-serif;color:inherit;border-top:1px solid #7b918477;padding-top:8px;max-width:560px;overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;background:#245f49;color:#fff;border:1px solid #5c8a74;border-radius:6px;padding:6px 12px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}p{margin:8px 0 0;white-space:pre-wrap}p:empty{display:none}details{margin-top:8px}summary{cursor:pointer}small{display:block;margin-top:6px;opacity:.8}input{display:none}'
  const box=document.createElement('div');box.className='box'
  const actions=document.createElement('div');actions.className='actions'
  const button=document.createElement('button');button.type='button';button.textContent='转为中文'
  const fileButton=document.createElement('button');fileButton.type='button';fileButton.textContent='选择语音文件';fileButton.setAttribute('aria-label','选择这条语音对应的本地文件')
  const fileInput=document.createElement('input');fileInput.type='file';fileInput.accept='audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm,.aac,.flac';fileInput.setAttribute('aria-label','选择这条语音对应的本地文件')
  const status=document.createElement('p');status.setAttribute('role','status')
  const english=document.createElement('p');english.setAttribute('aria-label','英文译文');english.lang='en'
  const chinese=document.createElement('p');chinese.setAttribute('aria-label','中文译文');chinese.lang='zh-CN'
  const details=document.createElement('details'),summary=document.createElement('summary'),original=document.createElement('p');summary.textContent='查看识别原文';details.append(summary,original);details.hidden=true
  const note=document.createElement('small');note.textContent=allowed(item.source)?'点击后显示中英文字，保留原语音，不自动播放。':'请先用官方功能保存这条语音，再在这里选择对应文件，显示中英文字。'
  actions.append(button,fileButton);box.append(actions,fileInput,status,english,chinese,details,note);shadow.append(style,box)
  // Prefer the original message container so horizontal controls stay intact.
  // A standalone custom component is itself the bubble: give only our new
  // full-width item a second flex line and restore that one property on removal.
  let restoreWrap:(()=>void)|undefined
  if(item.native)item.player.insertAdjacentElement('afterend',host)
  else{
   if(item.row===item.player&&/^(?:inline-)?flex$/.test(view.getComputedStyle(item.player).display)&&view.getComputedStyle(item.player).flexWrap==='nowrap'){
    const value=item.player.style.getPropertyValue('flex-wrap'),priority=item.player.style.getPropertyPriority('flex-wrap')
    item.player.style.setProperty('flex-wrap','wrap','important')
    restoreWrap=()=>{if(item.player.style.getPropertyValue('flex-wrap')==='wrap'&&item.player.style.getPropertyPriority('flex-wrap')==='important'){if(value)item.player.style.setProperty('flex-wrap',value,priority);else item.player.style.removeProperty('flex-wrap')}}
   }
   item.row.append(host)
  }
  const entry:Entry={...item,page:view.location.href,host,revision:0,busy:false,restoreWrap};entries.set(item.player,entry)
  let selectionRevision:number|undefined,completed=false
  const setBusy=(busy:boolean)=>{entry.busy=busy;button.disabled=busy||completed;fileButton.disabled=busy}
  async function translate(url:string,revision:number){
   completed=false;setBusy(true);status.textContent='正在生成中英文字…';english.textContent='';chinese.textContent='';original.textContent='';details.hidden=true
   try{
    const bytes=await decode(url);if(!current(entry,revision))return
    const [routeId,messageId]=await Promise.all([fingerprint(entry.page),fingerprint(entry.page+'\0'+entry.identity)]);if(!current(entry,revision))return
    const result=await options.translateAudio(bytes,{conversationId:'google-voice-audio:'+routeId,messageId:'voice:google-voice:'+messageId});if(!current(entry,revision))return
    if(!result||result.targetLanguage!=='zh-CN'||typeof result.text!=='string'||!result.text.trim()||Array.from(result.text).length>12000||typeof result.translation!=='string'||!result.translation.trim()||result.translation.length>40000||typeof result.englishTranslation!=='string'||!result.englishTranslation.trim()||result.englishTranslation.length>40000||!/^[a-f0-9]{64}$/.test(result.audioId))throw Error('invalid-result')
    english.textContent=result.englishTranslation;chinese.textContent=result.translation;original.textContent=result.text;details.hidden=result.text===result.translation||result.text===result.englishTranslation;status.textContent='已转为中文';button.textContent='已显示中英文字';completed=true
   }catch{if(current(entry,revision))status.textContent='这次未能生成中英文字，可重试或选择这条语音的本地文件。'}
   finally{if(current(entry,revision))setBusy(false)}
  }
  function selectFile(event:Event){
   if(!event.isTrusted||entry.busy||!current(entry,entry.revision))return
   selectionRevision=++entry.revision;fileInput.value='';fileInput.click()
  }
  button.addEventListener('click',event=>{
   if(!event.isTrusted||entry.busy||completed||!current(entry,entry.revision))return
   if(!allowed(entry.source)){selectFile(event);return}
   selectionRevision=undefined;void translate(entry.source,++entry.revision)
  })
  fileButton.addEventListener('click',selectFile)
  fileInput.addEventListener('change',async event=>{
   const revision=selectionRevision;selectionRevision=undefined
   if(!event.isTrusted||revision===undefined||!current(entry,revision)||entry.busy)return
   const file=fileInput.files?.[0];fileInput.value='';if(!file)return
   if(file.size<=0||file.size>20*1024*1024){status.textContent='请选择 20 MB 以内、5 分钟以内的语音文件。';return}
   const url=view.URL.createObjectURL(file)
   try{await translate(url,revision)}finally{view.URL.revokeObjectURL(url)}
  })
 }
 function scan(){
  scheduled=undefined;if(disposed)return
  for(const entry of [...entries.values()])if(!current(entry,entry.revision))clear(entry)
  if(view.location.origin!=='https://voice.google.com')return
  const players=new Set<HTMLElement>()
  for(const player of document.querySelectorAll<HTMLElement>(customPlayers))if(candidate(player,false))players.add(player)
  for(const control of document.querySelectorAll<HTMLElement>('button,[role="button"]'))if(!excluded(control)&&visible(control)&&playControl(control)){const player=customRoot(control);if(player)players.add(player)}
  for(const player of [...players])if([...players].some(other=>other!==player&&player.contains(other)))players.delete(player)
  for(const player of players){if(entries.has(player))continue;const item=candidate(player,false);if(item)add(item)}
  for(const audio of document.querySelectorAll<HTMLAudioElement>('audio[controls]')){
   if(entries.has(audio)||[...players].some(player=>player.contains(audio)))continue
   const item=candidate(audio,true);if(item)add(item)
  }
 }
 const schedule=()=>{if(!disposed&&scheduled===undefined)scheduled=view.setTimeout(scan,120)}
 const invalidate=()=>{for(const entry of [...entries.values()])clear(entry);schedule()}
 const observer=new view.MutationObserver(records=>{
  let changed=false
  for(const record of records){
   const element=record.target instanceof view.Element?record.target:record.target.parentElement
   if(element?.closest(ownUi))continue
   if(record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(node=>node instanceof view.Element&&node.matches(ownUi)))continue
   changed=true
   // Invalidate transient A->B->A ids and removed/reinserted virtual rows even
   // when the eventual scan sees the same final identity again.
   for(const entry of [...entries.values()]){
    const attributeChanged=record.type==='attributes'&&record.oldValue!==(record.target as Element).getAttribute(record.attributeName!)
    const identityChanged=attributeChanged&&identities.includes(record.attributeName||'')&&(record.target===entry.row||record.target===entry.player)
    const sourceChanged=attributeChanged&&record.attributeName==='src'&&(record.target===entry.audio||Boolean(entry.audio?.contains(record.target)))
    const removed=record.type==='childList'&&[...record.removedNodes].some(node=>node===entry.player||node===entry.row||node.contains(entry.player)||node===entry.audio)
    if(identityChanged||sourceChanged||removed)clear(entry)
   }
  }
  if(changed)schedule()
 })
 observer.observe(document,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['src','controls','hidden','inert','aria-hidden','aria-label','style','class',...identities]})
 document.addEventListener('loadedmetadata',schedule,true);document.addEventListener('emptied',schedule,true)
 view.addEventListener('popstate',invalidate);view.addEventListener('hashchange',invalidate);view.addEventListener('resize',schedule)
 const interval=view.setInterval(schedule,2000)
 schedule()
 const stop=()=>{if(disposed)return;disposed=true;view.clearTimeout(scheduled);view.clearInterval(interval);observer.disconnect();for(const entry of [...entries.values()])clear(entry);document.removeEventListener('loadedmetadata',schedule,true);document.removeEventListener('emptied',schedule,true);view.removeEventListener('popstate',invalidate);view.removeEventListener('hashchange',invalidate);view.removeEventListener('resize',schedule);view.removeEventListener('pagehide',stop)}
 view.addEventListener('pagehide',stop)
 return stop
}
