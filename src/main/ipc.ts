import { execFileAsync } from './exec'
import { app, ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { existsSync, mkdirSync } from 'fs'
import { join, sep } from 'path'
import { homedir } from 'os'
import { IPC } from '../shared/ipc'
import * as db from './db'
import { sessionUsage } from './claudeSessions'
import { computeUsageSummary } from './usage'
import {
  cancelPull,
  connections,
  connectionsChanged,
  connectionState,
  models,
  ollamaManager,
  pullModel,
  refreshListed,
  refreshOllama
} from './connections'
import { codexProvider } from './codex'
import { relayAdmin, relayAdminStatus } from './relayAdmin'
import { isMac } from './platform'
import { PROJECTS_ROOT } from './services/ProjectService'
import { exportAllChats, exportChat, fileName } from './chat/exporter'
import { chatSettings, saveChatSettings } from './chat/settings'
import { knowledge, projectInstructions, setProjectInstructions } from './chat/projects'
import { artifactSnapshot, chatToPdf, popOutArtifact } from './chat/windows'
import type {
  Agent,
  ArtifactSnapshot,
  ChatFile,
  ChatRetryInput,
  ChatSettings,
  ChatSendInput,
  CreditPool,
  Identity,
  Project,
  WorkspaceAuth
} from '../shared/types'
import type { WorkspaceManager } from './services/WorkspaceManager'
import type { PtyManager } from './services/PtyManager'
import type { GitService } from './services/GitService'
import type { ProjectService } from './services/ProjectService'
import type { OrchestratorService } from './services/OrchestratorService'
import type { ShareService } from './services/ShareService'
import type { CodexService } from './services/CodexService'
import type { ClipboardService } from './services/ClipboardService'
import type { MobileService } from './services/MobileService'
import type { Updater } from './updater'
import type { ChatService } from './chat/ChatService'

interface Services {
  workspaceManager: WorkspaceManager
  ptyManager: PtyManager
  gitService: GitService
  projectService: ProjectService
  orchestratorService: OrchestratorService
  shareService: ShareService
  codexService: CodexService
  clipboardService: ClipboardService
  mobileService: MobileService
  updater: Updater
  chatService: ChatService
}

// The page every Orcha window shows: the dev server while developing, the
// built index.html otherwise.
const APP_PAGE =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL'])
    : pathToFileURL(join(__dirname, '../renderer/index.html'))

// Only Orcha's own pages may call into the main process: a window's top
// frame showing the app. Never an artifact's frame, nor a page a window was
// steered to (a link, a redirect), whatever it manages to load.
function fromApp(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  return APP_PAGE.protocol === 'file:'
    ? url.protocol === 'file:' && url.pathname.toLowerCase() === APP_PAGE.pathname.toLowerCase()
    : url.origin === APP_PAGE.origin
}

// ipcMain.handle, for Orcha's own pages only (see fromApp).
function handle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('Not allowed.')
    return fn(event, ...(args as never[]))
  })
}

export function registerIpc(mainWindow: BrowserWindow, services: Services): void {
  const {
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
    chatService
  } = services

  // --- setup / onboarding ---------------------------------------------------

  handle(IPC.SetupStatus, async () => {
    let gh = false
    try {
      await execFileAsync('gh', ['auth', 'status'])
      gh = true
    } catch {
      gh = false
    }
    const claude =
      existsSync(join(homedir(), '.claude', '.credentials.json')) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      (isMac && (await claudeKeychainLogin()))
    return { gh, claude }
  })

  // --- projects ---------------------------------------------------------------

  // Codex tabs need an Azure connection; without one a request for one is
  // quietly a Claude tab.
  const agentFor = (agent?: Agent): Agent =>
    agent === 'codex' && codexProvider() ? 'codex' : 'claude'

  handle(
    IPC.ProjectsAdd,
    async (_e, pickedPath?: string, agent?: Agent): Promise<Project | null> => {
      let repoPath = pickedPath
      if (!repoPath) {
        if (isMac) mkdirSync(PROJECTS_ROOT, { recursive: true })
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Open a local git repository',
          // A Mac's picker shows no New Folder button without createDirectory.
          properties: ['openDirectory', 'createDirectory'],
          ...(isMac ? { defaultPath: PROJECTS_ROOT } : {})
        })
        if (result.canceled || result.filePaths.length === 0) return null
        repoPath = result.filePaths[0]
        if (isMac && !(await confirmMacFolder(mainWindow, repoPath))) return null
      }
      return projectService.addLocal(repoPath, agentFor(agent))
    }
  )

  // A plain folder picked by someone who just wants to work in it: make it a
  // git repo (sessions, worktrees and the git chip all need one), then open it.
  handle(IPC.ProjectsInitGit, async (_e, folder: string, agent?: Agent) => {
    await execFileAsync('git', ['init'], { cwd: folder })
    return projectService.addLocal(folder, agentFor(agent))
  })

  handle(IPC.ProjectsList, () => db.projects.list())

  // Projects for chats: one with no folder, its instructions (the repo's
  // CLAUDE.md when it has one here), and its knowledge files.
  const project = (id: string): Project => {
    const p = db.projects.get(id)
    if (!p) throw new Error('That project no longer exists.')
    return p
  }
  handle(IPC.ProjectsCreateChat, (_e, name: string) =>
    projectService.createChatProject(String(name))
  )
  handle(IPC.ProjectInstructions, (_e, id: string) => projectInstructions(project(id)))
  handle(IPC.ProjectSetInstructions, (_e, id: string, text: string) =>
    setProjectInstructions(project(id), String(text))
  )
  handle(IPC.ProjectFiles, (_e, id: string) => knowledge.list(id))
  handle(IPC.ProjectAddFile, (_e, id: string, file: ChatFile) =>
    knowledge.add(project(id).id, file)
  )
  handle(IPC.ProjectRemoveFile, (_e, fileId: number) => knowledge.remove(fileId))

  handle(IPC.ProjectsCreateRepo, (_e, name: string, isPrivate: boolean, agent?: Agent) =>
    projectService.createRepo(name, isPrivate, agentFor(agent))
  )
  handle(IPC.ProjectsListGithub, () => projectService.listGithub())
  handle(IPC.ProjectsCloneGithub, (_e, nameWithOwner: string, agent?: Agent) =>
    projectService.cloneGithub(nameWithOwner, agentFor(agent))
  )
  handle(
    IPC.ProjectsAddRemote,
    (_e, host: string, user: string, port: number | null, remotePath: string) =>
      projectService.addRemote(host, user, port, remotePath)
  )

  // --- sessions (workspaces) ---------------------------------------------------

  handle(
    IPC.WorkspacesCreate,
    (
      _e,
      projectId: string,
      name: string,
      model: string | null,
      effort: string | null,
      agent?: Agent
    ) =>
      workspaceManager.create(
        projectId,
        name,
        model,
        effort as Parameters<typeof workspaceManager.create>[3],
        agentFor(agent)
      )
  )
  handle(IPC.WorkspacesList, () => db.workspaces.listActive())
  handle(IPC.WorkspacesArchive, (_e, workspaceId: string) => workspaceManager.archive(workspaceId))

  // --- Mission Control chat ------------------------------------------------

  handle(IPC.OrchestratorSend, (_e, text: string) => orchestratorService.sendPrompt(text))
  handle(IPC.OrchestratorInterrupt, () => orchestratorService.interrupt())
  handle(IPC.OrchestratorHistory, () => orchestratorService.getHistory())

  // --- git -------------------------------------------------------------------

  handle(IPC.GitStatus, (_e, workspaceId: string) => gitService.status(workspaceId))
  handle(IPC.GitCommitPush, (_e, workspaceId: string, message: string) =>
    gitService.commitAndPush(workspaceId, message)
  )
  handle(IPC.GitCreatePr, (_e, workspaceId: string) => gitService.createPr(workspaceId))
  handle(IPC.GitPull, (_e, workspaceId: string) => gitService.pull(workspaceId))
  handle(IPC.GitOpenGithub, async (_e, workspaceId: string) => {
    const url = await gitService.githubUrl(workspaceId)
    await shell.openExternal(url)
  })
  handle(IPC.ShellOpenPath, (_e, path: string) => shell.openPath(path))
  handle(IPC.ProjectsRemove, (_e, projectId: string) => projectService.remove(projectId))

  // --- terminals ---------------------------------------------------------------

  handle(IPC.PtyCreate, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.create(workspaceId, cols, rows)
  )
  handle(IPC.PtyInput, (_e, workspaceId: string, data: string) =>
    ptyManager.write(workspaceId, data)
  )
  handle(IPC.PtyResize, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.resize(workspaceId, cols, rows)
  )
  handle(IPC.PtyKill, (_e, workspaceId: string) => ptyManager.kill(workspaceId))
  handle(IPC.PtyRestart, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.restart(workspaceId, cols, rows)
  )

  // Typing a prompt into a session's TUI from UI buttons ("Ask Claude ...").
  handle(IPC.SessionSend, (_e, workspaceId: string, text: string) =>
    ptyManager.dispatchPrompt(workspaceId, text)
  )

  // Token usage/estimated cost for a workspace's current session, parsed
  // from its local transcript. Remote (SSH) workspaces have no local
  // transcript to read, so this returns null for those.
  handle(IPC.SessionUsage, (_e, workspaceId: string) => {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) return null
    const project = db.projects.get(workspace.projectId)
    if (project?.sshHost) return null
    return sessionUsage(db.database(), workspace.worktreePath)
  })

  // Per-workspace auth-mode override (subscription login vs. API key).
  // Applies on the next restart of that workspace's pty (see PtyManager.authEnv).
  handle(IPC.WorkspaceAuthGet, (_e, workspaceId: string) => db.workspaceAuth.get(workspaceId))
  handle(IPC.WorkspaceAuthSet, (_e, workspaceId: string, auth: WorkspaceAuth) =>
    db.workspaceAuth.set(workspaceId, auth)
  )

  // Real subscription limits from Anthropic's usage endpoint, plus local
  // transcript-derived attribution for what's consuming them — see
  // planUsage.ts and usage/insights.ts.
  handle(IPC.UsageSummary, (_e, force?: boolean) => computeUsageSummary(force === true))

  // Connect a session to your phone via Claude Code's official Remote Control:
  // type /remote-control into the TUI, then watch its output for the session
  // link. The link only counts if printed after the command was sent, so a
  // stale URL from a --continue recap can't win.
  handle(IPC.SessionRemoteControl, async (_e, workspaceId: string) => {
    // Esc closes the TUI's Remote Control panel, which otherwise stays open
    // as a dialog and swallows the next dispatched prompt. The connection
    // itself stays up. Skipped while output is streaming, where Esc would
    // interrupt a running turn instead.
    const dismissPanel = (): void => {
      const outputAge = ptyManager.outputAgeMs(workspaceId)
      if (outputAge === null || outputAge > 2000) ptyManager.write(workspaceId, '\x1b')
    }
    ptyManager.clearRemoteUrl(workspaceId)
    await ptyManager.dispatchPrompt(workspaceId, '/remote-control')
    const since = Date.now()
    const deadline = since + 35_000
    let retried = false
    while (Date.now() < deadline) {
      const url = ptyManager.remoteUrlSince(workspaceId, since)
      if (url) {
        setTimeout(dismissPanel, 2500)
        return { url }
      }
      // A cold TUI can still eat the first /remote-control despite the boot
      // wait (input typed during a boot pause vanishes silently). One retype
      // lands on the now-warm TUI; if the first DID run, the retype is
      // swallowed by the open panel and the buffer fallback finds the URL.
      if (!retried && Date.now() - since > 12_000) {
        retried = true
        await ptyManager.dispatchPrompt(workspaceId, '/remote-control')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    // No fresh print (e.g. Remote Control auto-reconnected on --continue and
    // the panel repaint got garbled). The link is per-conversation, so the
    // last one anywhere in this terminal's history is still the live one.
    const fallback = ptyManager.lastRemoteUrlInBuffer(workspaceId)
    if (fallback) {
      dismissPanel()
      return { url: fallback }
    }
    throw new Error(
      'No session link appeared. Check the terminal: Remote Control needs a claude.ai (Pro/Max) login and an up-to-date Claude Code, and works best when the session is idle.'
    )
  })

  // --- live share ------------------------------------------------------------

  handle(IPC.ShareStart, (_e, workspaceId: string) => shareService.start(workspaceId))
  handle(IPC.ShareStop, (_e, workspaceId: string) => shareService.stop(workspaceId))

  // --- clipboard -------------------------------------------------------------

  handle(IPC.ClipboardPaste, (_e, workspaceId: string) => clipboardService.paste(workspaceId))
  handle(IPC.ClipboardCopy, (_e, text: string) => clipboardService.copy(text))
  handle(IPC.ClipboardHistory, () => clipboardService.entries())
  handle(IPC.ClipboardUse, (_e, workspaceId: string, id: string) =>
    clipboardService.use(workspaceId, id)
  )
  // Files dropped onto a session: local sessions reference them where they
  // are, remote ones get a copy on the server first.
  handle(IPC.SessionPathFor, (_e, workspaceId: string, localPath: string) =>
    clipboardService.pathFor(workspaceId, localPath)
  )
  handle(IPC.ClipboardSaveBlob, (_e, workspaceId: string, data: Uint8Array, extension: string) =>
    clipboardService.saveBlob(workspaceId, data, extension.replace(/[^a-z0-9]/gi, '') || 'bin')
  )
  // The terminal's own "Paste" menu item on a Mac: a real paste into the
  // focused field, so it takes the same path as ⌘V.
  handle(IPC.AppPaste, () => mainWindow.webContents.paste())

  // --- chat ------------------------------------------------------------------

  handle(IPC.ChatList, () => chatService.list())
  handle(IPC.ChatGet, (_e, chatId: string) => chatService.detail(chatId))
  handle(IPC.ChatSend, (_e, input: ChatSendInput) => chatService.send(input))
  handle(IPC.ChatRetry, (_e, input: ChatRetryInput) => chatService.retry(input))
  handle(IPC.ChatAttach, (_e, name: string, mime: string, data: Uint8Array) =>
    chatService.attach(String(name), String(mime), new Uint8Array(data))
  )
  handle(IPC.ChatStop, (_e, chatId: string) => chatService.stop(chatId))
  handle(IPC.ChatSetLeaf, (_e, chatId: string, leafId: number) =>
    chatService.setLeaf(chatId, leafId)
  )
  handle(IPC.ChatRename, (_e, chatId: string, title: string) => chatService.rename(chatId, title))
  handle(IPC.ChatStar, (_e, chatId: string, starred: boolean) => chatService.star(chatId, starred))
  handle(IPC.ChatDelete, (_e, chatId: string) => chatService.remove(chatId))
  handle(IPC.ChatSearch, (_e, query: string) => chatService.search(query))
  handle(IPC.ChatDeleteAll, () => chatService.removeAll())
  // Export as Markdown: one chat to a file, or every chat into a folder.
  // Null when the dialog is cancelled.
  handle(IPC.ChatExport, async (_e, chatId: string, title: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(app.getPath('documents'), `${fileName(title)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || !filePath) return null
    exportChat(chatId, filePath)
    return filePath
  })
  handle(IPC.ChatExportPdf, async (_e, chatId: string, title: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(app.getPath('documents'), `${fileName(title)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    await chatToPdf(chatId, filePath)
    return filePath
  })
  handle(IPC.ArtifactPopOut, (_e, artifact: ArtifactSnapshot) => popOutArtifact(artifact))
  handle(IPC.ArtifactSnapshot, (_e, id: string) => artifactSnapshot(id))
  handle(IPC.ChatExportAll, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for your chats',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return null
    return { folder: filePaths[0], count: exportAllChats(filePaths[0]) }
  })

  handle(IPC.MemoryList, () => chatService.memories())
  handle(IPC.MemoryUpdate, (_e, id: number, text: string) => chatService.updateMemory(id, text))
  handle(IPC.MemoryRemove, (_e, id: number) => chatService.removeMemory(id))
  handle(IPC.MemoryClear, () => chatService.clearMemories())

  // --- settings --------------------------------------------------------------

  handle(IPC.SettingsGet, () => chatSettings())
  handle(IPC.SettingsSet, (_e, changes: Partial<ChatSettings>) => saveChatSettings(changes))
  // Light, dark, or the system's. The window follows through
  // prefers-color-scheme, and its frame through nativeTheme's 'updated'.
  handle(IPC.AppSetTheme, (_e, theme: string) => {
    const value = theme === 'light' || theme === 'dark' ? theme : 'system'
    db.appState.set('ui:theme', value)
    nativeTheme.themeSource = value
  })

  // --- updates and support ---------------------------------------------------

  handle(IPC.UpdateStatus, () => updater.status())
  handle(IPC.UpdateInstall, () => updater.install())

  // Switch what a tab runs (Claude/Codex) and on which model, then restart it
  // in place; the conversation resumes.
  handle(
    IPC.SessionSetAgent,
    async (_e, workspaceId: string, agent: Agent, model: string | null) => {
      db.workspaces.setAgentModel(workspaceId, agentFor(agent), model)
      const size = ptyManager.size(workspaceId) ?? { cols: 120, rows: 30 }
      if (ptyManager.has(workspaceId)) await ptyManager.restart(workspaceId, size.cols, size.rows)
      return db.workspaces.get(workspaceId)
    }
  )

  // --- who this Orcha is ----------------------------------------------------

  // The host is the machine with a relay's admin file; Codex needs an Azure
  // connection.
  handle(IPC.Identity, (): Identity => ({
    kind: relayAdminStatus().configured ? 'host' : 'local',
    codex: codexProvider() !== null
  }))
  handle(IPC.Models, () => models())

  // --- Settings → Models & keys -----------------------------------------------
  // A key is only ever sent this way (pasted into Settings); none comes back.

  handle(IPC.Connections, () => connectionState())
  // A change to the default key changes which models Anthropic lists.
  const keysChanged = (): void => {
    connectionsChanged()
    void refreshListed()
  }
  handle(IPC.KeyAdd, async (_e, label: string, key: string) => {
    const added = await connections().addKey(String(label), String(key))
    keysChanged()
    return added
  })
  handle(IPC.KeyRemove, (_e, id: string) => {
    connections().removeKey(String(id))
    keysChanged()
  })
  handle(IPC.KeySetDefault, (_e, id: string) => {
    connections().setDefaultKey(String(id))
    keysChanged()
  })
  handle(IPC.KeyRename, (_e, id: string, label: string) => {
    connections().updateKey(String(id), { label: String(label) })
    connectionsChanged()
  })
  handle(IPC.KeyCheck, async (_e, id: string) => {
    const key = await connections().checkKey(String(id))
    connectionsChanged()
    return key
  })
  handle(IPC.AzureSet, async (_e, endpoint: string, key: string) => {
    const azure = await connections().setAzure(String(endpoint), String(key))
    connectionsChanged()
    return azure
  })
  handle(IPC.AzureReprobe, async () => {
    const azure = await connections().reprobeAzure()
    connectionsChanged()
    return azure
  })
  handle(IPC.AzureRemove, () => {
    connections().removeAzure()
    connectionsChanged()
  })
  handle(
    IPC.AzureSetDeployment,
    (_e, name: string, patch: { model?: string | null; enabled?: boolean }) => {
      const clean = String(name).trim()
      if (!clean) throw new Error('Type the deployment name as it appears in Azure.')
      connections().setDeployment(clean, {
        ...(patch && 'model' in patch ? { model: patch.model ? String(patch.model) : null } : {}),
        ...(typeof patch?.enabled === 'boolean' ? { enabled: patch.enabled } : {})
      })
      connectionsChanged()
    }
  )
  handle(IPC.AzureRemoveDeployment, (_e, name: string) => {
    connections().removeDeployment(String(name))
    connectionsChanged()
  })
  handle(IPC.OllamaRefresh, () => refreshOllama())
  handle(IPC.OllamaStart, async () => {
    await ollamaManager().ensureRunning()
    return refreshOllama()
  })
  handle(IPC.OllamaPull, (_e, name: string) => {
    // Runs on; progress arrives as ev:models:changed.
    void pullModel(String(name).trim())
  })
  handle(IPC.OllamaCancelPull, (_e, name: string) => cancelPull(String(name)))
  handle(IPC.OllamaRemove, async (_e, name: string) => {
    await ollamaManager().remove(String(name))
    return refreshOllama()
  })
  handle(IPC.OllamaUnload, async (_e, name: string) => {
    await ollamaManager().unload(String(name))
    return refreshOllama()
  })

  // --- host: managing guests on your own relay ---------------------------------

  handle(IPC.RelayAdminStatus, () => relayAdminStatus())
  handle(IPC.RelayAdminGuests, () => relayAdmin.guests())
  handle(
    IPC.RelayAdminCreate,
    (_e, name: string, hostName: string, caps: Record<CreditPool, number>) =>
      relayAdmin.create(name, hostName, caps)
  )
  handle(IPC.RelayAdminInvite, (_e, guestId: string) => relayAdmin.invite(guestId))
  handle(IPC.RelayAdminBalance, (_e, guestId: string, pool: CreditPool, balance: number) =>
    relayAdmin.setBalance(guestId, pool, balance)
  )
  handle(IPC.RelayAdminPause, (_e, guestId: string, pool: CreditPool, paused: boolean) =>
    relayAdmin.setPaused(guestId, pool, paused)
  )
  handle(IPC.RelayAdminAccess, (_e, guestId: string, access: 'revoke' | 'restore') =>
    relayAdmin.setAccess(guestId, access)
  )

  // --- codex plugin ------------------------------------------------------

  handle(IPC.CodexStatus, () => codexService.status())
  handle(IPC.CodexSetup, () => codexService.setup())

  // Pairing info for the phone companion (Settings → Phone shows it as a QR).
  handle(IPC.MobileInfo, async () => {
    await mobileService.ensureStarted()
    return mobileService.info()
  })

  // Small persisted UI state (open sessions, last active) in app_state.
  handle(IPC.UiGetState, (_e, key: string) => db.appState.get(`ui:${key}`) ?? null)
  handle(IPC.UiSaveState, (_e, key: string, value: string) => db.appState.set(`ui:${key}`, value))
}

// Claude Code on a Mac keeps its login in the Keychain rather than in
// ~/.claude/.credentials.json. Only whether the item exists is asked (no -w),
// so the secret is never read and macOS shows no Keychain prompt.
async function claudeKeychainLogin(): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials'
    ])
    return true
  } catch {
    return false
  }
}

// Desktop and Documents are permission-gated on a Mac, and iCloud may sync
// them; a git repo inside an iCloud-synced folder gets corrupted. Worth one
// plain warning before a project lands there.
async function confirmMacFolder(window: BrowserWindow, folder: string): Promise<boolean> {
  const home = homedir()
  const risky = ['Desktop', 'Documents', join('Library', 'Mobile Documents')].some((dir) =>
    (folder + sep).startsWith(join(home, dir) + sep)
  )
  if (!risky) return true
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Choose another folder', 'Use it anyway'],
    defaultId: 0,
    cancelId: 0,
    message: 'This folder may be synced to iCloud',
    detail: `Projects in Desktop or Documents can be uploaded to iCloud, which can break them. The Projects folder in your home folder (${PROJECTS_ROOT}) is safer.`
  })
  return response === 1
}
