import { ipcRenderer } from 'electron'
// Give keyboard focus back to HelloDog's own controls when leaving the embedded
// Signal window. This never consumes a mouse/key event or handles message text.
document.addEventListener('pointerdown', event => {
  if (event.isTrusted) ipcRenderer.send('signal-desktop:activate-host')
}, true)
