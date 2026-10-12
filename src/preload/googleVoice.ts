import { ipcRenderer } from 'electron'
import { installGoogleVoiceRuntime } from '../../integrations/google-voice-extension/content-runtime.js'
import { installGoogleVoiceUnread } from './googleVoiceUnread'
import { installGoogleVoiceAudio } from './googleVoiceAudio'
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
    const installAudio=()=>installGoogleVoiceAudio(document,{translateAudio:(bytes,context)=>ipcRenderer.invoke('google-voice:voice-audio',{bytes,conversationId:context.conversationId,messageId:context.messageId})})
    let stopAudio=installAudio()
    const changed=()=>{stopAudio();stopAudio=installAudio()}
    ipcRenderer.on('google-voice:context-changed',changed)
    window.addEventListener('unload',()=>{stopAudio();ipcRenderer.removeListener('google-voice:context-changed',changed)},{once:true})
  } catch { /* Voice setup must not prevent the official page or text translation. */ }
  try { installGoogleVoiceRuntime({
    onHealth: reportHealth,
    sendRequest: message => ipcRenderer.invoke('google-voice:translate-request', message),
    subscribe: listener => {
      const changed = () => listener({ v: 1, type: 'voice.connection-changed' })
      ipcRenderer.on('google-voice:context-changed', changed)
      return () => ipcRenderer.removeListener('google-voice:context-changed', changed)
    }
  }) } catch { reportHealth({ phase: 'error', code: 'preload-failed', messageCount: 0 }) }
}
