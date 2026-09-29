const { ipcRenderer } = require('electron')
ipcRenderer.on('fixture:go', () => {
  ipcRenderer.invoke('fixture:expected-rejection').then(
    () => ipcRenderer.send('fixture:rejection-observed', { unexpectedlyResolved: true }),
    async error => {
      const next = await ipcRenderer.invoke('fixture:subsequent-success')
      ipcRenderer.send('fixture:rejection-observed', { expectedRejection: error.message.includes('Synthetic expected IPC rejection'), subsequentSuccess: next.ok === true })
    }
  )
})
