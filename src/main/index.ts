import {
  app,
  shell,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  powerSaveBlocker,
  protocol
} from 'electron'
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
import { ensureHostRelay, isGuest, queueInviteLink } from './guest'
import { refreshCatalog } from './catalog'
import { refreshPath } from './tools'
import { isMac, resolveShellEnv, startLogFile } from './platform'
import { Updater } from './updater'
import { registerSmoke } from './smoke'
import { ChatService } from './chat/ChatService'
import { serveAttachments } from './chat/attachments'

// Replaces Electron's default menu so the editing roles — and the
// Ctrl+C/X/V/A accelerators that come with them — are guaranteed in every
// text field rather than left to whatever Chromium does by default. The bar
// itself stays hidden (autoHideMenuBar). A Mac's menu bar is always visible
// and its first menu is the app menu, so it gets the standard set (⌘Q, ⌘H,
// ⌘W, ⌘M come from the app and window roles). No Reset Zoom there: its ⌘0
// would steal the Mission Control shortcut.
function buildMenu(): void {
  const edit: Electron.MenuItemConstructorOptions = {
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
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      isMac
        ? [
            { role: 'appMenu' },
            edit,
            {
              label: 'View',
              submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
              ]
            },
            { role: 'windowMenu' }
          ]
        : [
            edit,
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
          ]
    )
  )
}

let appWindow: BrowserWindow | null = null
// Set once a real quit starts; until then, closing the window on a Mac only
// hides it, so the sessions behind it keep running and one set of services
// lives for the whole app.
let quitting = false
app.on('before-quit', () => (quitting = true))

// orcha://join/… from an invite page. Registered before launch finishes so a
// link that starts Orcha isn't lost; the welcome screen picks it up.
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const link = queueInviteLink(url)
    if (link && appWindow && !appWindow.isDestroyed()) {
      appWindow.webContents.send(IPC.EvInviteLink, { link })
      appWindow.show()
    }
  })
})

// The window's own colours, matching the theme the renderer will paint.
const surface = (): string => (nativeTheme.shouldUseDarkColors ? '#09090b' : '#fcfcfd')
const captionColors = (): Electron.TitleBarOverlay => ({
  color: surface(),
  symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1aa' : '#52525b',
  height: 47
})

function createWindow(): void {
  // Light or dark per Settings → Appearance (default: follow the system). The
  // renderer follows through prefers-color-scheme.
  const theme = db.appState.get('ui:theme')
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system'

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: surface(),
    title: 'Orcha',
    // Orcha draws its own title bar (.titlebar in main.css): the traffic
    // lights inset over the sidebar on a Mac, the caption buttons over the
    // main bar's right end on Windows.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: captionColors() }
        : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Sessions stream while the window is unfocused/occluded; keep rendering.
      backgroundThrottling: false
    }
  })
  appWindow = mainWindow

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  nativeTheme.on('updated', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.setBackgroundColor(surface())
    if (process.platform === 'win32') mainWindow.setTitleBarOverlay(captionColors())
  })

  mainWindow.on('close', (event) => {
    if (isMac && !quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
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
  // The paste-history poll reads the clipboard in the background, which newer
  // macOS answers with an "allow paste?" alert, so a Mac goes without it.
  if (!isMac) clipboardService.start()
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
  // App Nap throttles a hidden app's timers, which would delay the activity
  // poll (and its notifications) while you're elsewhere; a Mac holds it off
  // only while some session is actually working.
  let napBlocker: number | null = null
  activityMonitor.onState = (workspaceId, state) => {
    mobileService.handleState(workspaceId, state)
    if (!isMac) return
    const working = activityMonitor.anyWorking()
    if (working && napBlocker === null) {
      napBlocker = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!working && napBlocker !== null) {
      powerSaveBlocker.stop(napBlocker)
      napBlocker = null
    }
  }
  const updater = new Updater(send)
  updater.busy = () => activityMonitor.anyWorking()
  updater.start()
  // The model list from the relay (and, on the host's machine, the token that
  // lets their own chat and Codex tabs use it).
  const loadCatalog = (): void => {
    ensureHostRelay()
      .catch((err) => console.log('[relay] host token:', err instanceof Error ? err.message : err))
      .then(() => refreshCatalog())
      .then((fresh) => send(IPC.EvCatalog, fresh))
      .catch((err) => console.log('[relay] catalog:', err instanceof Error ? err.message : err))
  }
  loadCatalog()
  setInterval(loadCatalog, 6 * 60 * 60_000)
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
    if (isMac) {
      app.focus({ steal: true })
    } else {
      // On Windows focus() alone often only flashes the taskbar; a brief
      // always-on-top toggle forces the window to the foreground.
      mainWindow.setAlwaysOnTop(true)
      mainWindow.focus()
      mainWindow.setAlwaysOnTop(false)
    }
    send(IPC.EvFocusSession, { workspaceId })
  }
  activityMonitor.start()
  registerSmoke(mainWindow, ptyManager, activityMonitor)
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
    mobileService,
    updater,
    chatService: new ChatService(send)
  })
}

// A downloaded Mac app that's opened where it landed runs from a randomised
// read-only copy and can't update itself, so offer to move it once.
async function offerMoveToApplications(): Promise<boolean> {
  if (!isMac || !app.isPackaged || process.argv.includes('--orcha-smoke')) return false
  if (app.isInApplicationsFolder()) return false
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move Orcha to your Applications folder?',
    detail: 'Orcha can keep itself up to date from there.'
  })
  if (response !== 0) return false
  try {
    return app.moveToApplicationsFolder() // relaunches from the new place
  } catch {
    return false
  }
}

// Chat attachments (see chat/attachments.ts); must be declared before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'orcha-file', privileges: { standard: true, secure: true } }
])

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.orcha.app')
  startLogFile()
  if (await offerMoveToApplications()) return
  // Before anything spawns a process: a Finder-launched Mac app has no PATH.
  await resolveShellEnv()
  buildMenu()
  initDb()
  serveAttachments()
  if (isMac && app.isPackaged) app.setAsDefaultProtocolClient('orcha')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // A Mac's window only ever hides (see 'close'), so the Dock icon brings the
  // same one back.
  app.on('activate', function () {
    if (appWindow && !appWindow.isDestroyed()) appWindow.show()
    else if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
