import {acquireVoicePlayer} from '../shared/voicePlayer'
import {voiceAudioWav,VOICE_MAX_BYTES} from '../shared/voiceAudio'

/** Execute only a fixed acquisition program in the official page world. The
 * page receives no IPC, account credentials, file paths or translation bridge. */
export async function readGoogleVoicePlayer(
 execute:(code:string)=>Promise<unknown>,player:HTMLElement,control:HTMLElement|undefined,
 identity:string,current:()=>boolean
):Promise<Uint8Array>{
 const document=player.ownerDocument,view=document.defaultView!,attribute='data-hellodog-audio-request',controlAttribute='data-hellodog-audio-control'
 if(view.location.origin!=='https://voice.google.com'||!current())throw Error('voice-context')
 const token=view.crypto.randomUUID(),page=view.location.href
 if(player.hasAttribute(attribute)||control?.hasAttribute(controlAttribute))throw Error('voice-busy')
 player.setAttribute(attribute,token);control?.setAttribute(controlAttribute,token)
 const script=`(async()=>{
  if(location.origin!=='https://voice.google.com'||location.href!==${JSON.stringify(page)})throw Error('voice-context');
  const token=${JSON.stringify(token)},attribute=${JSON.stringify(attribute)},controlAttribute=${JSON.stringify(controlAttribute)},nodes=document.querySelectorAll('['+attribute+']');
  const matches=[...nodes].filter(node=>node.getAttribute(attribute)===token);if(matches.length!==1)throw Error('voice-context');
  const player=matches[0],controls=[...player.querySelectorAll('['+controlAttribute+']')].filter(node=>node.getAttribute(controlAttribute)===token);
  if(controls.length>1||player.closest('gv-active-call,gv-call-controls,gv-call-dialer,[gv-test-id="active-call"]'))throw Error('voice-context');
  const valid=()=>player.isConnected&&player.getAttribute(attribute)===token&&location.href===${JSON.stringify(page)};
  const lease=await (${acquireVoicePlayer.toString()})(player,controls[0],${JSON.stringify(identity)},valid,{allowedOrigin:'https://voice.google.com'});
  try{const bytes=await (${voiceAudioWav.toString()})(lease.url,'https://voice.google.com');if(!valid()||!lease.current())throw Error('voice-context');return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}finally{lease.release()}
 })()`
 const removeMarkers=()=>{
  if(player.getAttribute(attribute)===token)player.removeAttribute(attribute)
  if(control?.getAttribute(controlAttribute)===token)control.removeAttribute(controlAttribute)
 }
 let watchdog:number|undefined
 try{
  const deadline=Date.now()+45000
  const interrupted=new Promise<never>((_,reject)=>{
   const check=()=>{
    if(!current()||view.location.href!==page||Date.now()>=deadline){removeMarkers();reject(Error('voice-context'));return}
    watchdog=view.setTimeout(check,Math.min(80,Math.max(0,deadline-Date.now())))
   };check()
  })
  const result=await Promise.race([execute(script),interrupted])
  if(!current()||view.location.href!==page||Object.prototype.toString.call(result)!=='[object ArrayBuffer]')throw Error('voice-context')
  const bytes=new Uint8Array(result as ArrayBuffer)
  if(bytes.byteLength<3244||bytes.byteLength>VOICE_MAX_BYTES)throw Error('voice-size')
  return bytes
 }finally{
  view.clearTimeout(watchdog);removeMarkers()
 }
}
