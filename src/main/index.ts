import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb } from './db'
import * as db from './db'
import { registerIpc } from './ipc'
import { WorkspaceManager } from './services/WorkspaceManager'
import { PtyManager } from './services/PtyManager'
import { GitService } from './services/GitService'
import { ProjectService } from './services/ProjectService'
import { OrchestratorService } from './services/OrchestratorService'
import { ShareService } from './services/ShareService'
import { ActivityMonitor } from './services/ActivityMonitor'
import { CodexService } from './services/CodexService'
import { ClipboardService } from './services/ClipboardService'
import { MobileService } from './services/MobileService'
import { IPC } from '../shared/ipc'
import { isGuest } from './guest'
import { refreshPath } from './tools'

// Replaces Electron's default menu so the editing roles — and the
// Ctrl+C/X/V/A accelerators that come with them — are guaranteed in every
// text field rather than left to whatever Chromium does by default. The bar
// itself stays hidden (autoHideMenuBar).
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

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

  // Right-click in any text field gets the standard editing menu. The
  // terminal cancels this event and draws its own styled menu instead.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    ]).popup({ window: mainWindow })
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
  const shareService = new ShareService(send, ptyManager)
  const codexService = new CodexService()
  const clipboardService = new ClipboardService()
  clipboardService.start()
  workspaceManager.onBeforeArchive = async (workspaceId) => {
    shareService.stop(workspaceId)
    ptyManager.kill(workspaceId)
    // Give Windows a beat to release file handles before worktree removal.
    await new Promise((r) => setTimeout(r, 300))
  }
  const activityMonitor = new ActivityMonitor(send, ptyManager)
  activityMonitor.isWindowFocused = () => mainWindow.isFocused()
  ptyManager.onUnexpectedExit = (workspaceId, hadInput) =>
    activityMonitor.onUnexpectedExit(workspaceId, hadInput)
  const mobileService = new MobileService(ptyManager, activityMonitor, gitService)
  activityMonitor.onPing = (workspaceId, kind, body, focused) =>
    mobileService.handlePing(workspaceId, kind, body, focused)
  activityMonitor.onState = (workspaceId, state) => mobileService.handleState(workspaceId, state)
  // The phone companion opens a network port, so it only starts at launch on
  // a machine where it's already been set up; otherwise the first open of
  // Settings → Phone starts it (and a fresh install never meets a firewall
  // prompt for a feature nobody asked for). Guest machines never run it, and
  // instead pick up tools installed from inside Orcha since Windows last
  // logged in.
  if (isGuest()) {
    refreshPath().catch(() => {})
  } else if (db.appState.get('mobile:token')) {
    mobileService.start().catch((err) => console.log('[mobile] failed to start:', err))
  }
  activityMonitor.onNotificationClick = (workspaceId) => {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    // On Windows focus() alone often only flashes the taskbar; a brief
    // always-on-top toggle forces the window to the foreground.
    mainWindow.setAlwaysOnTop(true)
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(false)
    send(IPC.EvFocusSession, { workspaceId })
  }
  activityMonitor.start()
  app.on('before-quit', () => {
    activityMonitor.stop()
    clipboardService.stop()
    shareService.stopAll()
    mobileService.stop()
    ptyManager.killAll()
  })
  registerIpc(mainWindow, {
    workspaceManager,
    ptyManager,
    gitService,
    projectService,
    orchestratorService,
    shareService,
    codexService,
    clipboardService,
    mobileService
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.orcha.app')
  buildMenu()
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
