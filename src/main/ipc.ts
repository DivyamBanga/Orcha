import { execFileAsync } from './exec'
import { app, ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, sep } from 'path'
import { homedir } from 'os'
import { IPC } from '../shared/ipc'
import * as db from './db'
import { sessionUsage } from './claudeSessions'
import { computeUsageSummary } from './usageStats'
import {
  guestBalance,
  guestStatus,
  guestUsage,
  INVITE_LINK,
  isGuest,
  leaveGuestMode,
  redeemInvite,
  relayConfig,
  takePendingInvite
} from './guest'
import { catalog, refreshCatalog } from './catalog'
import { relayAdmin, relayAdminStatus } from './relayAdmin'
import { installTool, refreshPath, toolsStatus } from './tools'
import { isMac, logFilePath } from './platform'
import { PROJECTS_ROOT } from './services/ProjectService'
import type {
  Agent,
  ChatRetryInput,
  ChatSendInput,
  CreditPool,
  Identity,
  Project,
  ToolName,
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

  ipcMain.handle(IPC.SetupStatus, async () => {
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

  // Codex tabs need a relay (a guest's, or the host's own); without one a
  // request for one is quietly a Claude tab.
  const agentFor = (agent?: Agent): Agent =>
    agent === 'codex' && relayConfig() ? 'codex' : 'claude'

  ipcMain.handle(
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
  ipcMain.handle(IPC.ProjectsInitGit, async (_e, folder: string, agent?: Agent) => {
    await execFileAsync('git', ['init'], { cwd: folder })
    return projectService.addLocal(folder, agentFor(agent))
  })

  ipcMain.handle(IPC.ProjectsList, () => db.projects.list())

  ipcMain.handle(IPC.ProjectsCreateRepo, (_e, name: string, isPrivate: boolean, agent?: Agent) =>
    projectService.createRepo(name, isPrivate, agentFor(agent))
  )
  ipcMain.handle(IPC.ProjectsListGithub, () => projectService.listGithub())
  ipcMain.handle(IPC.ProjectsCloneGithub, (_e, nameWithOwner: string, agent?: Agent) =>
    projectService.cloneGithub(nameWithOwner, agentFor(agent))
  )
  ipcMain.handle(
    IPC.ProjectsAddRemote,
    (_e, host: string, user: string, port: number | null, remotePath: string) =>
      projectService.addRemote(host, user, port, remotePath)
  )

  // --- sessions (workspaces) ---------------------------------------------------

  ipcMain.handle(
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
  ipcMain.handle(IPC.WorkspacesList, () => db.workspaces.listActive())
  ipcMain.handle(IPC.WorkspacesArchive, (_e, workspaceId: string) =>
    workspaceManager.archive(workspaceId)
  )

  // --- Mission Control chat ------------------------------------------------

  ipcMain.handle(IPC.OrchestratorSend, (_e, text: string) => orchestratorService.sendPrompt(text))
  ipcMain.handle(IPC.OrchestratorInterrupt, () => orchestratorService.interrupt())
  ipcMain.handle(IPC.OrchestratorHistory, () => orchestratorService.getHistory())

  // --- git -------------------------------------------------------------------

  ipcMain.handle(IPC.GitStatus, (_e, workspaceId: string) => gitService.status(workspaceId))
  ipcMain.handle(IPC.GitCommitPush, (_e, workspaceId: string, message: string) =>
    gitService.commitAndPush(workspaceId, message)
  )
  ipcMain.handle(IPC.GitCreatePr, (_e, workspaceId: string) => gitService.createPr(workspaceId))
  ipcMain.handle(IPC.GitPull, (_e, workspaceId: string) => gitService.pull(workspaceId))
  ipcMain.handle(IPC.GitOpenGithub, async (_e, workspaceId: string) => {
    const url = await gitService.githubUrl(workspaceId)
    await shell.openExternal(url)
  })
  ipcMain.handle(IPC.ShellOpenPath, (_e, path: string) => shell.openPath(path))
  ipcMain.handle(IPC.ProjectsRemove, (_e, projectId: string) => projectService.remove(projectId))

  // --- terminals ---------------------------------------------------------------

  ipcMain.handle(IPC.PtyCreate, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.create(workspaceId, cols, rows)
  )
  ipcMain.handle(IPC.PtyInput, (_e, workspaceId: string, data: string) =>
    ptyManager.write(workspaceId, data)
  )
  ipcMain.handle(IPC.PtyResize, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.resize(workspaceId, cols, rows)
  )
  ipcMain.handle(IPC.PtyKill, (_e, workspaceId: string) => ptyManager.kill(workspaceId))
  ipcMain.handle(IPC.PtyRestart, (_e, workspaceId: string, cols: number, rows: number) =>
    ptyManager.restart(workspaceId, cols, rows)
  )

  // Typing a prompt into a session's TUI from UI buttons ("Ask Claude ...").
  ipcMain.handle(IPC.SessionSend, (_e, workspaceId: string, text: string) =>
    ptyManager.dispatchPrompt(workspaceId, text)
  )

  // Token usage/estimated cost for a workspace's current session, parsed
  // from its local transcript. Remote (SSH) workspaces have no local
  // transcript to read, so this returns null for those.
  ipcMain.handle(IPC.SessionUsage, (_e, workspaceId: string) => {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) return null
    const project = db.projects.get(workspace.projectId)
    if (project?.sshHost) return null
    return sessionUsage(workspace.worktreePath, workspace.model)
  })

  // Per-workspace auth-mode override (subscription login vs. API key).
  // Applies on the next restart of that workspace's pty (see PtyManager.authEnv).
  ipcMain.handle(IPC.WorkspaceAuthGet, (_e, workspaceId: string) =>
    db.workspaceAuth.get(workspaceId)
  )
  ipcMain.handle(IPC.WorkspaceAuthSet, (_e, workspaceId: string, auth: WorkspaceAuth) =>
    db.workspaceAuth.set(workspaceId, auth)
  )

  // Real subscription limits from Anthropic's usage endpoint, plus local
  // transcript-derived attribution for what's consuming them — see
  // planUsage.ts and usageStats.ts.
  ipcMain.handle(IPC.UsageSummary, (_e, force?: boolean) => computeUsageSummary(force === true))

  // Connect a session to your phone via Claude Code's official Remote Control:
  // type /remote-control into the TUI, then watch its output for the session
  // link. The link only counts if printed after the command was sent, so a
  // stale URL from a --continue recap can't win.
  ipcMain.handle(IPC.SessionRemoteControl, async (_e, workspaceId: string) => {
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

  ipcMain.handle(IPC.ShareStart, (_e, workspaceId: string) => shareService.start(workspaceId))
  ipcMain.handle(IPC.ShareStop, (_e, workspaceId: string) => shareService.stop(workspaceId))

  // --- clipboard -------------------------------------------------------------

  ipcMain.handle(IPC.ClipboardPaste, (_e, workspaceId: string) =>
    clipboardService.paste(workspaceId)
  )
  ipcMain.handle(IPC.ClipboardCopy, (_e, text: string) => clipboardService.copy(text))
  ipcMain.handle(IPC.ClipboardHistory, () => clipboardService.entries())
  ipcMain.handle(IPC.ClipboardUse, (_e, workspaceId: string, id: string) =>
    clipboardService.use(workspaceId, id)
  )
  // Files dropped onto a session: local sessions reference them where they
  // are, remote ones get a copy on the server first.
  ipcMain.handle(IPC.SessionPathFor, (_e, workspaceId: string, localPath: string) =>
    clipboardService.pathFor(workspaceId, localPath)
  )
  ipcMain.handle(
    IPC.ClipboardSaveBlob,
    (_e, workspaceId: string, data: Uint8Array, extension: string) =>
      clipboardService.saveBlob(workspaceId, data, extension.replace(/[^a-z0-9]/gi, '') || 'bin')
  )
  // The terminal's own "Paste" menu item on a Mac: a real paste into the
  // focused field, so it takes the same path as ⌘V.
  ipcMain.handle(IPC.AppPaste, () => mainWindow.webContents.paste())

  // --- chat ------------------------------------------------------------------

  ipcMain.handle(IPC.ChatList, () => chatService.list())
  ipcMain.handle(IPC.ChatGet, (_e, chatId: string) => chatService.detail(chatId))
  ipcMain.handle(IPC.ChatSend, (_e, input: ChatSendInput) => chatService.send(input))
  ipcMain.handle(IPC.ChatRetry, (_e, input: ChatRetryInput) => chatService.retry(input))
  ipcMain.handle(IPC.ChatStop, (_e, chatId: string) => chatService.stop(chatId))
  ipcMain.handle(IPC.ChatSetLeaf, (_e, chatId: string, leafId: number) =>
    chatService.setLeaf(chatId, leafId)
  )
  ipcMain.handle(IPC.ChatRename, (_e, chatId: string, title: string) =>
    chatService.rename(chatId, title)
  )
  ipcMain.handle(IPC.ChatStar, (_e, chatId: string, starred: boolean) =>
    chatService.star(chatId, starred)
  )
  ipcMain.handle(IPC.ChatDelete, (_e, chatId: string) => chatService.remove(chatId))
  ipcMain.handle(IPC.ChatSearch, (_e, query: string) => chatService.search(query))

  // --- updates and support ---------------------------------------------------

  ipcMain.handle(IPC.UpdateStatus, () => updater.status())
  ipcMain.handle(IPC.UpdateInstall, () => updater.install())
  ipcMain.handle(IPC.AppDiagnostics, () => diagnostics())

  // Switch what a tab runs (Claude/Codex) and on which model, then restart it
  // in place; the conversation resumes.
  ipcMain.handle(
    IPC.SessionSetAgent,
    async (_e, workspaceId: string, agent: Agent, model: string | null) => {
      db.workspaces.setAgentModel(workspaceId, agentFor(agent), model)
      const size = ptyManager.size(workspaceId) ?? { cols: 120, rows: 30 }
      if (ptyManager.has(workspaceId)) await ptyManager.restart(workspaceId, size.cols, size.rows)
      return db.workspaces.get(workspaceId)
    }
  )

  // --- guest mode ------------------------------------------------------------

  ipcMain.handle(IPC.GuestStatus, () => guestStatus())
  ipcMain.handle(IPC.GuestRedeem, async (_e, link: string) => {
    const status = await redeemInvite(link)
    // A guest machine runs no phone server, and may have just installed tools.
    mobileService.stop()
    await refreshPath()
    await refreshCatalog().catch(() => {})
    return status
  })
  ipcMain.handle(IPC.GuestLeave, () => leaveGuestMode())
  ipcMain.handle(IPC.GuestBalance, (_e, force?: boolean) => guestBalance(force === true))
  ipcMain.handle(IPC.GuestUsage, () => guestUsage())
  // A Mac never reads the clipboard behind the user's back (newer macOS shows
  // an "allow paste?" alert for that); invites arrive by the orcha:// link.
  ipcMain.handle(IPC.GuestClipboardInvite, () =>
    isMac ? null : (clipboard.readText().match(INVITE_LINK)?.[0] ?? null)
  )
  ipcMain.handle(IPC.GuestPendingInvite, () => takePendingInvite())

  // Who this Orcha bills, and what it can run.
  ipcMain.handle(IPC.Identity, (): Identity => ({
    kind: isGuest() ? 'guest' : relayAdminStatus().configured ? 'host' : 'local',
    codex: relayConfig() !== null
  }))
  ipcMain.handle(IPC.Catalog, () => catalog())

  ipcMain.handle(IPC.ToolsStatus, () => toolsStatus())
  ipcMain.handle(IPC.ToolsInstall, (e, name: ToolName) =>
    installTool(name, (message) => e.sender.send(IPC.EvToolsProgress, { tool: name, message }))
  )

  // --- host: managing guests on your own relay ---------------------------------

  ipcMain.handle(IPC.RelayAdminStatus, () => relayAdminStatus())
  ipcMain.handle(IPC.RelayAdminGuests, () => relayAdmin.guests())
  ipcMain.handle(
    IPC.RelayAdminCreate,
    (_e, name: string, hostName: string, caps: Record<CreditPool, number>) =>
      relayAdmin.create(name, hostName, caps)
  )
  ipcMain.handle(IPC.RelayAdminInvite, (_e, guestId: string) => relayAdmin.invite(guestId))
  ipcMain.handle(IPC.RelayAdminTopUp, (_e, guestId: string, pool: CreditPool, amount: number) =>
    relayAdmin.topUp(guestId, pool, amount)
  )
  ipcMain.handle(IPC.RelayAdminAccess, (_e, guestId: string, access: 'revoke' | 'restore') =>
    relayAdmin.setAccess(guestId, access)
  )

  // --- codex plugin ------------------------------------------------------

  ipcMain.handle(IPC.CodexStatus, () => codexService.status())
  ipcMain.handle(IPC.CodexSetup, () => codexService.setup())

  // Pairing info for the phone companion (Settings → Phone shows it as a QR).
  ipcMain.handle(IPC.MobileInfo, async () => {
    if (!isGuest()) await mobileService.ensureStarted()
    return mobileService.info()
  })

  // Small persisted UI state (open sessions, last active) in app_state.
  ipcMain.handle(IPC.UiGetState, (_e, key: string) => db.appState.get(`ui:${key}`) ?? null)
  ipcMain.handle(IPC.UiSaveState, (_e, key: string, value: string) =>
    db.appState.set(`ui:${key}`, value)
  )
}

// A support snapshot to paste into a message: versions, tools, PATH and the
// recent log. Relay tokens and API keys are blanked out.
async function diagnostics(): Promise<string> {
  const tools = await toolsStatus().catch(() => null)
  let log = ''
  try {
    log = readFileSync(logFilePath(), 'utf8').split('\n').slice(-200).join('\n')
  } catch {
    log = '(no log yet)'
  }
  const guest = guestStatus()
  const text = [
    `Orcha ${app.getVersion()} · ${process.platform} ${process.getSystemVersion()} ${process.arch}`,
    `Guest: ${guest.paired ? `${guest.name} on ${guest.hostName}'s credits` : 'no'}`,
    `Tools: ${
      tools
        ? Object.entries(tools)
            .map(([k, v]) => `${k} ${v.version ?? 'missing'}`)
            .join(', ')
        : 'unknown'
    }`,
    `PATH: ${process.env.PATH ?? ''}`,
    `LANG: ${process.env.LANG ?? ''}`,
    '',
    log
  ].join('\n')
  return text.replace(/\b(og_|oa_|sk-ant-)[A-Za-z0-9_-]+/g, '$1…')
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
