import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { IPC } from '../shared/ipc'
import * as db from './db'
import type { Project } from '../shared/types'
import type { WorkspaceManager } from './services/WorkspaceManager'
import type { PtyManager } from './services/PtyManager'
import type { GitService } from './services/GitService'
import type { ProjectService } from './services/ProjectService'
import type { OrchestratorService } from './services/OrchestratorService'
import type { ShareService } from './services/ShareService'

const execFileAsync = promisify(execFile)

interface Services {
  workspaceManager: WorkspaceManager
  ptyManager: PtyManager
  gitService: GitService
  projectService: ProjectService
  orchestratorService: OrchestratorService
  shareService: ShareService
}

export function registerIpc(mainWindow: BrowserWindow, services: Services): void {
  const {
    workspaceManager,
    ptyManager,
    gitService,
    projectService,
    orchestratorService,
    shareService
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
      Boolean(process.env.ANTHROPIC_API_KEY)
    return { gh, claude }
  })

  // --- projects ---------------------------------------------------------------

  ipcMain.handle(IPC.ProjectsAdd, async (_e, pickedPath?: string): Promise<Project | null> => {
    let repoPath = pickedPath
    if (!repoPath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open a local git repository',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      repoPath = result.filePaths[0]
    }
    return projectService.addLocal(repoPath)
  })

  ipcMain.handle(IPC.ProjectsList, () => db.projects.list())

  ipcMain.handle(IPC.ProjectsCreateRepo, (_e, name: string, isPrivate: boolean) =>
    projectService.createRepo(name, isPrivate)
  )
  ipcMain.handle(IPC.ProjectsListGithub, () => projectService.listGithub())
  ipcMain.handle(IPC.ProjectsCloneGithub, (_e, nameWithOwner: string) =>
    projectService.cloneGithub(nameWithOwner)
  )

  // --- sessions (workspaces) ---------------------------------------------------

  ipcMain.handle(
    IPC.WorkspacesCreate,
    (_e, projectId: string, name: string, model: string | null, effort: string | null) =>
      workspaceManager.create(
        projectId,
        name,
        model,
        effort as Parameters<typeof workspaceManager.create>[3]
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

  // Small persisted UI state (open sessions, last active) in app_state.
  ipcMain.handle(IPC.UiGetState, (_e, key: string) => db.appState.get(`ui:${key}`) ?? null)
  ipcMain.handle(IPC.UiSaveState, (_e, key: string, value: string) =>
    db.appState.set(`ui:${key}`, value)
  )
}
