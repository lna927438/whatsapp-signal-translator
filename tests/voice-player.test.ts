import test from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {acquireVoicePlayer} from '../src/shared/voicePlayer'

function fixture(){
 const dom=new JSDOM('<div id="player"><button aria-label="Play audio">Play</button></div>',{url:'https://web.telegram.org/a/#123',pretendToBeVisual:true})
 const view=dom.window,root=view.document.querySelector<HTMLElement>('#player')!,control=root.querySelector('button')!
 let plays=0,pauses=0,mutedAtPlay=false
 view.HTMLMediaElement.prototype.play=function(){plays++;mutedAtPlay=this.muted;return Promise.resolve()}
 view.HTMLMediaElement.prototype.pause=function(){pauses++}
 return {dom,view,root,control,stats:()=>({plays,pauses,mutedAtPlay}),audio:()=>view.document.createElement('audio')}
}
test('owned blob is read without triggering playback; release revokes the lease only',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='blob:https://web.telegram.org/owned';f.root.append(audio);const lease=await acquireVoicePlayer(f.root,f.control,'message-a',()=>true);assert.equal(lease.audio,audio);assert.equal(lease.current(),true);assert.equal(f.stats().plays,0);lease.release();assert.equal(lease.current(),false)}finally{f.dom.window.close()}
})
test('detached player is acquired only from synchronous owned play control; original play is restored and muted state preserved',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='blob:https://web.telegram.org/detached';const original=f.view.HTMLMediaElement.prototype.play;f.control.onclick=()=>void audio.play();const lease=await acquireVoicePlayer(f.root,f.control,'message-a',()=>true);assert.equal(lease.audio,audio);assert.deepEqual(f.stats(),{plays:1,pauses:1,mutedAtPlay:true});assert.equal(audio.muted,false);assert.equal(f.view.HTMLMediaElement.prototype.play,original);assert.equal(lease.current(),true);audio.src='blob:https://web.telegram.org/other';assert.equal(lease.current(),false)}finally{f.dom.window.close()}
})
test('lazy descendant loads under same owned player without any file selector',async()=>{
 const f=fixture();try{f.control.onclick=()=>{f.view.setTimeout(()=>{const audio=f.audio();audio.src='blob:https://web.telegram.org/lazy';f.root.append(audio)},10)};const lease=await acquireVoicePlayer(f.root,f.control,'message-a',()=>true,{timeoutMs:300});assert.equal(lease.url,'blob:https://web.telegram.org/lazy');assert.equal(f.view.document.querySelector('input[type=file]'),null)}finally{f.dom.window.close()}
})
test('first-load asynchronous detached media is reacquired only by the same controls pause and synchronous play',async()=>{
 const f=fixture();try{
  const audio=f.audio();let loaded=false,playing=false,clicks=0
  f.control.onclick=()=>{clicks++;if(playing){playing=false;audio.pause();f.control.setAttribute('aria-label','Play audio');return}if(loaded){playing=true;f.control.setAttribute('aria-label','Pause audio');void audio.play();return}f.view.setTimeout(()=>{loaded=true;playing=true;audio.src='blob:https://web.telegram.org/first-load';f.control.setAttribute('aria-label','Pause audio');void audio.play()},20)}
  const lease=await acquireVoicePlayer(f.root,f.control,'message-a',()=>true,{timeoutMs:500});assert.equal(lease.audio,audio);assert.equal(lease.current(),true);assert.equal(clicks,3);assert.equal(f.stats().plays,2);assert.equal(f.stats().pauses,2);assert.equal(f.view.document.querySelector('input[type=file]'),null)
 }finally{f.dom.window.close()}
})
test('a preexisting playing detached voice resumes its original playback after exact-control acquisition',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='blob:https://web.telegram.org/playing';let playing=true;f.control.setAttribute('aria-label','Pause audio');f.control.onclick=()=>{playing=!playing;f.control.setAttribute('aria-label',playing?'Pause audio':'Play audio');if(playing)void audio.play();else audio.pause()};const lease=await acquireVoicePlayer(f.root,f.control,'message-a',()=>true,{timeoutMs:500});assert.equal(lease.current(),true);assert.equal(playing,true);assert.equal(f.stats().pauses,1);assert.equal(f.stats().mutedAtPlay,false)}finally{f.dom.window.close()}
})
test('unrelated global or asynchronous detached media is never adopted and a missing player times out',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='blob:https://web.telegram.org/other';f.view.document.body.append(audio);f.control.onclick=()=>{f.view.setTimeout(()=>void audio.play(),10)};await assert.rejects(acquireVoicePlayer(f.root,f.control,'message-a',()=>true,{timeoutMs:100}),/无法读取/);assert.equal(f.view.document.querySelector('input[type=file]'),null)}finally{f.dom.window.close()}
})
test('context change during loading cancels before selecting an audio source',async()=>{
 const f=fixture();try{let current=true;f.control.onclick=()=>{current=false};await assert.rejects(acquireVoicePlayer(f.root,f.control,'message-a',()=>current,{timeoutMs:100}));assert.equal(f.stats().plays,0)}finally{f.dom.window.close()}
})
test('same source cannot be reassigned to another message, while different bytes URL can be acquired',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='blob:https://web.telegram.org/owned';f.root.append(audio);const first=await acquireVoicePlayer(f.root,undefined,'message-a',()=>true);first.release();await assert.rejects(acquireVoicePlayer(f.root,undefined,'message-b',()=>true));audio.src='blob:https://web.telegram.org/new';const second=await acquireVoicePlayer(f.root,undefined,'message-b',()=>true);assert.equal(second.current(),true);audio.src='blob:https://web.telegram.org/owned';await assert.rejects(acquireVoicePlayer(f.root,undefined,'message-b',()=>true))}finally{f.dom.window.close()}
})
test('ambiguous media, live streams, stale currentSrc and foreign HTTPS never become translation input',async()=>{
 for(const mode of ['many','stream','stale','foreign']){const f=fixture();try{const audio=f.audio();audio.src=mode==='foreign'?'https://example.invalid/a.mp3':'blob:https://web.telegram.org/current';f.root.append(audio);if(mode==='many')f.root.append(f.audio());if(mode==='stream')Object.defineProperty(audio,'srcObject',{value:{}});if(mode==='stale')Object.defineProperty(audio,'currentSrc',{value:'blob:https://web.telegram.org/previous'});await assert.rejects(acquireVoicePlayer(f.root,undefined,'message-a',()=>true,{allowedOrigin:'https://web.telegram.org'}));assert.equal(f.stats().plays,0)}finally{f.dom.window.close()}}
})
test('only an explicit matching current HTTPS origin can authorize an owned remote source',async()=>{
 const f=fixture();try{const audio=f.audio();audio.src='https://web.telegram.org/stream/voice';f.root.append(audio);await assert.rejects(acquireVoicePlayer(f.root,undefined,'message-a',()=>true));const lease=await acquireVoicePlayer(f.root,undefined,'message-a',()=>true,{allowedOrigin:'https://web.telegram.org'});assert.equal(lease.current(),true)}finally{f.dom.window.close()}
})
