import { SettingsStore } from './storage/settingsStore'
import { applyDesktopOptions, attachDesktopRuntime, shouldStartMinimized } from './desktopRuntime'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { legacyUserDataPath } from './storage/userDataPath'
import { registerIpc } from './ipc'
import { TranslationEngine } from './translation/translationEngine'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'

let mainWindow: BrowserWindow | null = null
const userData = legacyUserDataPath(app.getPath('appData'), app.getPath('userData'), existsSync)
app.setName('HelloDog')
app.setPath('userData', userData)
app.setAppLogsPath()
const translator = new TranslationEngine()
const whatsapp = new WhatsAppAdapter()
const signal = new SignalAdapter(translator)

function installChineseMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放窗口' }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'HelloDog · 跨语言聊天工作台',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f4ed',
    icon: join(__dirname, '../../resources/brand/hellodog-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  attachDesktopRuntime(mainWindow)
  mainWindow.on('ready-to-show', () => { mainWindow?.show(); if (shouldStartMinimized()) mainWindow?.minimize() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  whatsapp.attachMainWindow(mainWindow)
  signal.attachMainWindow(mainWindow)
  registerIpc(mainWindow, whatsapp, signal, translator)

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  try { applyDesktopOptions(await new SettingsStore().get()) } catch { /* Keep the window available if desktop integration is unsupported. */ }
  installChineseMenu()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { signal.stop(); if (process.platform !== 'darwin') app.quit() })
