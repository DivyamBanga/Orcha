import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb } from './db'
import { registerIpc } from './ipc'
import { WorkspaceManager } from './services/WorkspaceManager'
import { PtyManager } from './services/PtyManager'
import { GitService } from './services/GitService'
import { ProjectService } from './services/ProjectService'
import { OrchestratorService } from './services/OrchestratorService'
import { ActivityMonitor } from './services/ActivityMonitor'
import { IPC } from '../shared/ipc'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0d',
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
  const ptyManager = new PtyManager(send)
  const gitService = new GitService(send)
  const projectService = new ProjectService(workspaceManager)
  const orchestratorService = new OrchestratorService(
    send,
    workspaceManager,
    ptyManager,
    gitService,
    projectService
  )
  workspaceManager.onBeforeArchive = async (workspaceId) => {
    ptyManager.kill(workspaceId)
    // Give Windows a beat to release file handles before worktree removal.
    await new Promise((r) => setTimeout(r, 300))
  }
  const activityMonitor = new ActivityMonitor(send, ptyManager)
  activityMonitor.isWindowFocused = () => mainWindow.isFocused()
  activityMonitor.onNotificationClick = (workspaceId) => {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    send(IPC.EvFocusSession, { workspaceId })
  }
  activityMonitor.start()
  app.on('before-quit', () => {
    activityMonitor.stop()
    ptyManager.killAll()
  })
  registerIpc(mainWindow, {
    workspaceManager,
    ptyManager,
    gitService,
    projectService,
    orchestratorService
  })
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
