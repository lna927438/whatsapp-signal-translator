import { ipcRenderer } from 'electron'
import { installGoogleVoiceRuntime } from '../../integrations/google-voice-extension/content-runtime.js'

// Runs only in the isolated preload world. No bridge or IPC primitive is
// exposed to Google page scripts, including on accounts.google.com.
if (process.isMainFrame && window === window.top && location.origin === 'https://voice.google.com') {
  installGoogleVoiceRuntime({
    sendRequest: message => ipcRenderer.invoke('google-voice:translate-request', message),
    subscribe: listener => {
      const changed = () => listener({ v: 1, type: 'voice.connection-changed' })
      ipcRenderer.on('google-voice:context-changed', changed)
      return () => ipcRenderer.removeListener('google-voice:context-changed', changed)
    }
  })
}
