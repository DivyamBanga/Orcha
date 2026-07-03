import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb } from './db'
import { registerIpc } from './ipc'
import { WorkspaceManager } from './services/WorkspaceManager'
import { SessionManager } from './services/SessionManager'
import { PtyManager } from './services/PtyManager'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#18181b',
    title: 'Orcha',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Sessions stream while the window is unfocused/occluded; keep rendering.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const send = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  const workspaceManager = new WorkspaceManager()
  const sessionManager = new SessionManager(send)
  const ptyManager = new PtyManager(send)
  workspaceManager.onBeforeArchive = async (workspaceId) => {
    sessionManager.interrupt(workspaceId)
    ptyManager.kill(workspaceId)
  }
  app.on('before-quit', () => ptyManager.killAll())
  registerIpc(mainWindow, { workspaceManager, sessionManager, ptyManager })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.orcha.app')
  initDb()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
