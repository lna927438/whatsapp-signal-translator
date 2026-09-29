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
    let stopAudio=installGoogleVoiceAudio(document,{translateAudio:bytes=>ipcRenderer.invoke('google-voice:voice-audio',bytes)})
    const changed=()=>{stopAudio();stopAudio=installGoogleVoiceAudio(document,{translateAudio:bytes=>ipcRenderer.invoke('google-voice:voice-audio',bytes)})}
    ipcRenderer.on('google-voice:context-changed',changed)
    window.addEventListener('unload',()=>{stopAudio();ipcRenderer.removeListener('google-voice:context-changed',changed)},{once:true})
  } catch { /* Missing native controls keep the explicit Settings file fallback. */ }
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
