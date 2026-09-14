import { t, onUiLanguageChanged } from './uiLocale'
import { SettingsStore } from './storage/settingsStore'
import { installWebSecurity } from './webSecurity'
import { applyDesktopOptions, attachDesktopRuntime, shouldStartMinimized, restartDesktop } from './desktopRuntime'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { legacyUserDataPath } from './storage/userDataPath'
import { registerIpc } from './ipc'
import { TranslationEngine } from './translation/translationEngine'
import { WhatsAppAdapter } from './platforms/whatsapp/whatsAppAdapter'
import { SignalAdapter } from './platforms/signal/signalAdapter'
import { markReady } from './runtimeHealth'
import { restoreWindowState, trackWindowState } from './windowState'
import { registerSignalMediaScheme, installSignalMediaProtocol } from './platforms/signal/signalMediaProtocol'

registerSignalMediaScheme()

let mainWindow: BrowserWindow | null = null
const isolatedTest = process.argv.includes('--isolated-test')
const testProfile = process.argv.find(value => /^--test-profile=[a-z0-9-]{1,32}$/.test(value))?.slice('--test-profile='.length)
// Preserve the already-linked beta6 test profile through local beta updates.
const userData = isolatedTest ? join(app.getPath('appData'),'HelloDog-test-' + (testProfile || 'beta6')) : !app.isPackaged && process.env.HELLODOG_TEST_USER_DATA ? process.env.HELLODOG_TEST_USER_DATA : legacyUserDataPath(app.getPath('appData'), app.getPath('userData'), existsSync)
app.setName('HelloDog')
// Match the NSIS shortcut identity so Windows groups badges and notifications with HelloDog.
if (process.platform === 'win32') app.setAppUserModelId('com.local.whatsappsignaltranslator')
app.setPath('userData', userData)
app.setAppLogsPath()
const translator = new TranslationEngine()
const whatsapp = new WhatsAppAdapter()
const signal = new SignalAdapter(translator)

function installApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: t('文件'),
      submenu: [
        { role: 'close', label: t('关闭窗口') },
        { label: t('重启 HelloDog'), click: () => { void restartDesktop().catch(error => mainWindow?.webContents.send('translator:error',error.message)) } },
        { type: 'separator' },
        { role: 'quit', label: t('退出') }
      ]
    },
    {
      label: t('编辑'),
      submenu: [
        { role: 'undo', label: t('撤销') },
        { role: 'redo', label: t('重做') },
        { type: 'separator' },
        { role: 'cut', label: t('剪切') },
        { role: 'copy', label: t('复制') },
        { role: 'paste', label: t('粘贴') },
        { role: 'selectAll', label: t('全选') }
      ]
    },
    {
      label: t('查看'),
      submenu: [
        { label: t('刷新当前聊天'), accelerator: 'F5', click: () => mainWindow?.webContents.send('ui:shortcut',{key:'F5'}) },
        { label: t('重新连接当前聊天'), accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.send('ui:shortcut',{key:'F5'}) },
        { type: 'separator' },
        { role: 'resetZoom', label: t('实际大小') },
        { role: 'zoomIn', label: t('放大') },
        { role: 'zoomOut', label: t('缩小') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('全屏') }
      ]
    },
    {
      label: t('窗口'),
      submenu: [
        { role: 'minimize', label: t('最小化') },
        { role: 'zoom', label: t('缩放窗口') }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow(): void {
  const geometry = restoreWindowState()
  mainWindow = new BrowserWindow({
    title: t('HelloDog · 跨语言聊天工作台'),
    x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
    minWidth: Math.min(960, geometry.width),
    minHeight: Math.min(620, geometry.height),
    show: false,
    backgroundColor: '#f5f4ed',
    icon: join(__dirname, '../../resources/brand/hellodog-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: true
    }
  })

  attachDesktopRuntime(mainWindow)
  trackWindowState(mainWindow)
  mainWindow.webContents.setZoomFactor(Math.min(1, geometry.width / 960, geometry.height / 620))
  if (geometry.maximized) mainWindow.maximize()
  if (isolatedTest) mainWindow.on('page-title-updated', event => { event.preventDefault(); mainWindow?.setTitle('HelloDog ' + app.getVersion() + t(' · 独立测试窗口')) })
  mainWindow.on('ready-to-show', () => { markReady(); if (!app.isPackaged && process.env.HELLODOG_TEST_HIDDEN === '1') return; mainWindow?.show(); if (shouldStartMinimized()) mainWindow?.minimize() })
  installWebSecurity(mainWindow.webContents, 'app')
  whatsapp.attachMainWindow(mainWindow)
  signal.attachMainWindow(mainWindow)
  registerIpc(mainWindow, whatsapp, signal, translator)

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() }
})
app.whenReady().then(async () => {
  installSignalMediaProtocol()
  try { const settings = new SettingsStore(); await settings.migrateLegacySecrets(); applyDesktopOptions(await settings.get()) } catch { /* Preserve original records and allow the recovery UI to open. */ }
  installApplicationMenu()
  createWindow()
  onUiLanguageChanged(() => { installApplicationMenu(); mainWindow?.setTitle(t('HelloDog · 跨语言聊天工作台')) })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { signal.stop(); if (process.platform !== 'darwin') app.quit() })
}
