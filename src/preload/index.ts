import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  GitStatus,
  Project,
  Workspace,
  WorkspaceAuth,
  CodexStatus,
  MobileInfo,
  SessionUsage,
  UsageSummary,
  ClipEntry,
  PasteTarget,
  Agent,
  AdminGuest,
  CreditPool,
  GuestBalance,
  GuestStatus,
  GuestUsage,
  ToolName,
  ToolsStatus
} from '../shared/types'

const api = {
  setup: {
    status: (): Promise<{ gh: boolean; claude: boolean }> => ipcRenderer.invoke(IPC.SetupStatus)
  },
  ui: {
    getState: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC.UiGetState, key),
    saveState: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke(IPC.UiSaveState, key, value)
  },
  projects: {
    add: (repoPath?: string, agent?: Agent): Promise<Project | null> =>
      ipcRenderer.invoke(IPC.ProjectsAdd, repoPath, agent),
    // Makes a plain folder a git repo, then opens it as a project.
    initGit: (folder: string, agent?: Agent): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsInitGit, folder, agent),
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.ProjectsList),
    createRepo: (name: string, isPrivate: boolean, agent?: Agent): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsCreateRepo, name, isPrivate, agent),
    listGithub: (): Promise<{ nameWithOwner: string; name: string }[]> =>
      ipcRenderer.invoke(IPC.ProjectsListGithub),
    cloneGithub: (nameWithOwner: string, agent?: Agent): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsCloneGithub, nameWithOwner, agent),
    addRemote: (
      host: string,
      user: string,
      port: number | null,
      remotePath: string
    ): Promise<Project> => ipcRenderer.invoke(IPC.ProjectsAddRemote, host, user, port, remotePath),
    remove: (projectId: string): Promise<void> => ipcRenderer.invoke(IPC.ProjectsRemove, projectId)
  },
  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.ShellOpenPath, path)
  },
  workspaces: {
    create: (
      projectId: string,
      name: string,
      model: string | null = null,
      effort: string | null = null,
      agent: Agent = 'claude'
    ): Promise<Workspace> =>
      ipcRenderer.invoke(IPC.WorkspacesCreate, projectId, name, model, effort, agent),
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.WorkspacesList),
    archive: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.WorkspacesArchive, workspaceId),
    authGet: (workspaceId: string): Promise<WorkspaceAuth> =>
      ipcRenderer.invoke(IPC.WorkspaceAuthGet, workspaceId),
    authSet: (workspaceId: string, auth: WorkspaceAuth): Promise<void> =>
      ipcRenderer.invoke(IPC.WorkspaceAuthSet, workspaceId, auth)
  },
  // Types a prompt into a session's Claude terminal.
  session: {
    send: (workspaceId: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SessionSend, workspaceId, text),
    remoteControl: (workspaceId: string): Promise<{ url: string }> =>
      ipcRenderer.invoke(IPC.SessionRemoteControl, workspaceId),
    usage: (workspaceId: string): Promise<SessionUsage | null> =>
      ipcRenderer.invoke(IPC.SessionUsage, workspaceId),
    // Switches the agent/model a tab runs and restarts it (conversation resumes).
    setAgent: (workspaceId: string, agent: Agent, model: string | null): Promise<Workspace> =>
      ipcRenderer.invoke(IPC.SessionSetAgent, workspaceId, agent, model)
  },
  guest: {
    status: (): Promise<GuestStatus> => ipcRenderer.invoke(IPC.GuestStatus),
    redeem: (link: string): Promise<GuestStatus> => ipcRenderer.invoke(IPC.GuestRedeem, link),
    leave: (): Promise<void> => ipcRenderer.invoke(IPC.GuestLeave),
    balance: (force?: boolean): Promise<GuestBalance | null> =>
      ipcRenderer.invoke(IPC.GuestBalance, force),
    usage: (): Promise<GuestUsage | null> => ipcRenderer.invoke(IPC.GuestUsage),
    // An invite link sitting on the clipboard, if there is one.
    clipboardInvite: (): Promise<string | null> => ipcRenderer.invoke(IPC.GuestClipboardInvite)
  },
  tools: {
    status: (): Promise<ToolsStatus> => ipcRenderer.invoke(IPC.ToolsStatus),
    install: (name: ToolName): Promise<void> => ipcRenderer.invoke(IPC.ToolsInstall, name)
  },
  relayAdmin: {
    status: (): Promise<{ configured: boolean; url: string | null }> =>
      ipcRenderer.invoke(IPC.RelayAdminStatus),
    guests: (): Promise<AdminGuest[]> => ipcRenderer.invoke(IPC.RelayAdminGuests),
    create: (
      name: string,
      hostName: string,
      caps: Record<CreditPool, number>
    ): Promise<{ guest: AdminGuest; inviteUrl: string }> =>
      ipcRenderer.invoke(IPC.RelayAdminCreate, name, hostName, caps),
    invite: (guestId: string): Promise<{ inviteUrl: string }> =>
      ipcRenderer.invoke(IPC.RelayAdminInvite, guestId),
    topUp: (guestId: string, pool: CreditPool, amount: number): Promise<AdminGuest> =>
      ipcRenderer.invoke(IPC.RelayAdminTopUp, guestId, pool, amount),
    access: (guestId: string, access: 'revoke' | 'restore'): Promise<AdminGuest> =>
      ipcRenderer.invoke(IPC.RelayAdminAccess, guestId, access)
  },
  usage: {
    summary: (force?: boolean): Promise<UsageSummary> => ipcRenderer.invoke(IPC.UsageSummary, force)
  },
  share: {
    start: (workspaceId: string): Promise<{ url: string }> =>
      ipcRenderer.invoke(IPC.ShareStart, workspaceId),
    stop: (workspaceId: string): Promise<void> => ipcRenderer.invoke(IPC.ShareStop, workspaceId)
  },
  orchestrator: {
    send: (text: string): Promise<void> => ipcRenderer.invoke(IPC.OrchestratorSend, text),
    interrupt: (): Promise<void> => ipcRenderer.invoke(IPC.OrchestratorInterrupt),
    history: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.OrchestratorHistory)
  },
  git: {
    status: (workspaceId: string): Promise<GitStatus> =>
      ipcRenderer.invoke(IPC.GitStatus, workspaceId),
    commitPush: (workspaceId: string, message: string): Promise<void> =>
      ipcRenderer.invoke(IPC.GitCommitPush, workspaceId, message),
    createPr: (workspaceId: string): Promise<{ url: string }> =>
      ipcRenderer.invoke(IPC.GitCreatePr, workspaceId),
    pull: (workspaceId: string): Promise<void> => ipcRenderer.invoke(IPC.GitPull, workspaceId),
    openGithub: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.GitOpenGithub, workspaceId)
  },
  codex: {
    status: (): Promise<CodexStatus> => ipcRenderer.invoke(IPC.CodexStatus),
    setup: (): Promise<void> => ipcRenderer.invoke(IPC.CodexSetup)
  },
  mobile: {
    info: (): Promise<MobileInfo> => ipcRenderer.invoke(IPC.MobileInfo)
  },
  clipboard: {
    paste: (workspaceId: string): Promise<PasteTarget> =>
      ipcRenderer.invoke(IPC.ClipboardPaste, workspaceId),
    copy: (text: string): Promise<void> => ipcRenderer.invoke(IPC.ClipboardCopy, text),
    history: (): Promise<ClipEntry[]> => ipcRenderer.invoke(IPC.ClipboardHistory),
    use: (workspaceId: string, id: string): Promise<PasteTarget> =>
      ipcRenderer.invoke(IPC.ClipboardUse, workspaceId, id),
    pathFor: (workspaceId: string, localPath: string): Promise<string> =>
      ipcRenderer.invoke(IPC.SessionPathFor, workspaceId, localPath),
    // Electron strips File.path in the renderer; this is the supported way to
    // recover the real path of a dropped file.
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  pty: {
    create: (workspaceId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.PtyCreate, workspaceId, cols, rows),
    input: (workspaceId: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PtyInput, workspaceId, data),
    resize: (workspaceId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.PtyResize, workspaceId, cols, rows),
    kill: (workspaceId: string): Promise<void> => ipcRenderer.invoke(IPC.PtyKill, workspaceId),
    restart: (workspaceId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.PtyRestart, workspaceId, cols, rows)
  },
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type OrchaApi = typeof api

contextBridge.exposeInMainWorld('orcha', api)
