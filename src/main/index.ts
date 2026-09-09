import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { TranslationEngine } from './translation/translationEngine'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'

let mainWindow: BrowserWindow | null = null
const translator = new TranslationEngine()
const whatsapp = new WhatsAppAdapter()
const signal = new SignalAdapter(translator)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#10151d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  whatsapp.attachMainWindow(mainWindow)
  signal.attachMainWindow(mainWindow)
  registerIpc(mainWindow, whatsapp, signal, translator)

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { signal.stop(); if (process.platform !== 'darwin') app.quit() })
