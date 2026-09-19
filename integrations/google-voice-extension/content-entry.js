import { installGoogleVoiceRuntime } from './content-runtime.js'

installGoogleVoiceRuntime({
  sendRequest: message => chrome.runtime.sendMessage(message),
  subscribe: listener => {
    const handler = (message, sender, reply) => {
      if (sender.id === chrome.runtime.id) return listener(message, reply)
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }
})
