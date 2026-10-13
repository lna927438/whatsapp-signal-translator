import { ipcRenderer, webFrame } from 'electron'
import { installGoogleVoiceRuntime } from '../../integrations/google-voice-extension/content-runtime.js'
import { installGoogleVoiceUnread } from './googleVoiceUnread'
import { installGoogleVoiceAudio } from './googleVoiceAudio'
import { readGoogleVoicePlayer } from './googleVoiceAudioReader'
import { parseGoogleVoiceRuntimeHealth } from '../shared/googleVoiceRuntimeHealth'

// Runs only in the isolated preload world. No bridge or IPC primitive is
// exposed to Google page scripts, including on accounts.google.com.
if (process.isMainFrame && window === window.top && location.origin === 'https://voice.google.com') {
  const reportHealth = (input: unknown) => {
    const value = parseGoogleVoiceRuntimeHealth(input)
    if (value) void ipcRenderer.invoke('google-voice:runtime-health', value).catch(() => undefined)
  }
  // Unread badges are independent: their setup must not prevent translation.
  try { installGoogleVoiceUnread(document, value => ipcRenderer.invoke('google-voice:unread', value)) } catch { /* no page details logged */ }
  try {
    const installAudio=()=>installGoogleVoiceAudio(document,{
      acquireAudio:(player,control,identity,current)=>readGoogleVoicePlayer(code=>webFrame.executeJavaScript(code),player,control,identity,current),
      translateAudio:(bytes,context)=>ipcRenderer.invoke('google-voice:voice-audio',{bytes,conversationId:context.conversationId,messageId:context.messageId})
    })
    let stopAudio=installAudio()
    const changed=()=>{try{stopAudio();stopAudio=installAudio()}catch{/* Audio recovery must not prevent send-context invalidation. */}}
    ipcRenderer.on('google-voice:context-changed',changed)
    window.addEventListener('unload',()=>{stopAudio();ipcRenderer.removeListener('google-voice:context-changed',changed)},{once:true})
  } catch { /* Voice setup must not prevent the official page or text translation. */ }
  try { installGoogleVoiceRuntime({
    onHealth: reportHealth,
    sendRequest: message => ipcRenderer.invoke('google-voice:translate-request', message),
    subscribe: listener => {
      const changed = (_event: unknown, input?: {token?:unknown}) => {
        // Runtime invalidation is synchronous. ACK only after it has cancelled
        // all pending native dispatches; nothing is exposed to the page world.
        listener({ v: 1, type: 'voice.connection-changed' })
        if (typeof input?.token === 'string' && /^[a-f0-9-]{36}$/.test(input.token)) void ipcRenderer.invoke('google-voice:context-ack', input.token).catch(() => undefined)
      }
      ipcRenderer.on('google-voice:context-changed', changed)
      return () => ipcRenderer.removeListener('google-voice:context-changed', changed)
    }
  }) } catch { reportHealth({ phase: 'error', code: 'preload-failed', messageCount: 0 }) }
}
