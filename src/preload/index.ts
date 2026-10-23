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
  UpdateState,
  Identity,
  ChatDetail,
  ChatFile,
  ChatRetryInput,
  ChatSendInput,
  ChatSettings,
  Memory,
  ProjectInstructions,
  ArtifactSnapshot,
  ChatSummary
} from '../shared/types'
import type { ApiKey, AzureConnection, ChatModel, Connections, OllamaState } from '../shared/ai'

const api = {
  // 'darwin' | 'win32' | … — for the few places the UI differs (⌘ vs Ctrl).
  platform: process.platform,
  app: {
    // A real paste into the focused field (the terminal's Paste menu on a Mac).
    paste: (): Promise<void> => ipcRenderer.invoke(IPC.AppPaste)
  },
  update: {
    status: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.UpdateStatus),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.UpdateInstall)
  },
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
    // A project for chats alone (no folder), and what a project's chats
    // start with: instructions and knowledge files.
    createChat: (name: string): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsCreateChat, name),
    instructions: (projectId: string): Promise<ProjectInstructions> =>
      ipcRenderer.invoke(IPC.ProjectInstructions, projectId),
    setInstructions: (projectId: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ProjectSetInstructions, projectId, text),
    files: (projectId: string): Promise<(ChatFile & { id: number })[]> =>
      ipcRenderer.invoke(IPC.ProjectFiles, projectId),
    addFile: (projectId: string, file: ChatFile): Promise<void> =>
      ipcRenderer.invoke(IPC.ProjectAddFile, projectId, file),
    removeFile: (fileId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.ProjectRemoveFile, fileId),
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
  identity: (): Promise<Identity> => ipcRenderer.invoke(IPC.Identity),
  // Chats: replies stream in as ev:chat events; ev:chats:changed means the
  // list (titles, order, stars) changed.
  chat: {
    list: (): Promise<ChatSummary[]> => ipcRenderer.invoke(IPC.ChatList),
    get: (chatId: string): Promise<ChatDetail | null> => ipcRenderer.invoke(IPC.ChatGet, chatId),
    send: (
      input: ChatSendInput
    ): Promise<{ chatId: string; userId: number; assistantId: number }> =>
      ipcRenderer.invoke(IPC.ChatSend, input),
    retry: (
      input: ChatRetryInput
    ): Promise<{ chatId: string; userId: number; assistantId: number }> =>
      ipcRenderer.invoke(IPC.ChatRetry, input),
    // Stores a file for the next message; what it is comes back.
    attach: (name: string, mime: string, data: Uint8Array): Promise<ChatFile> =>
      ipcRenderer.invoke(IPC.ChatAttach, name, mime, data),
    // Markdown files; null when the save dialog is cancelled.
    exportOne: (chatId: string, title: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.ChatExport, chatId, title),
    exportAll: (): Promise<{ folder: string; count: number } | null> =>
      ipcRenderer.invoke(IPC.ChatExportAll),
    exportPdf: (chatId: string, title: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.ChatExportPdf, chatId, title),
    removeAll: (): Promise<void> => ipcRenderer.invoke(IPC.ChatDeleteAll),
    stop: (chatId: string): Promise<void> => ipcRenderer.invoke(IPC.ChatStop, chatId),
    setLeaf: (chatId: string, leafId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.ChatSetLeaf, chatId, leafId),
    rename: (chatId: string, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ChatRename, chatId, title),
    star: (chatId: string, starred: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.ChatStar, chatId, starred),
    remove: (chatId: string): Promise<void> => ipcRenderer.invoke(IPC.ChatDelete, chatId),
    search: (query: string): Promise<{ chatId: string; messageId: number; snippet: string }[]> =>
      ipcRenderer.invoke(IPC.ChatSearch, query)
  },
  // The models on offer, from every connection; ev:models:changed means they
  // (or the connections) changed.
  models: (): Promise<ChatModel[]> => ipcRenderer.invoke(IPC.Models),
  // Settings → Models & keys. Keys go in; only a hint ever comes back.
  connections: {
    get: (): Promise<Connections> => ipcRenderer.invoke(IPC.Connections),
    addKey: (label: string, key: string): Promise<ApiKey> =>
      ipcRenderer.invoke(IPC.KeyAdd, label, key),
    removeKey: (id: string): Promise<void> => ipcRenderer.invoke(IPC.KeyRemove, id),
    setDefaultKey: (id: string): Promise<void> => ipcRenderer.invoke(IPC.KeySetDefault, id),
    renameKey: (id: string, label: string): Promise<void> =>
      ipcRenderer.invoke(IPC.KeyRename, id, label),
    checkKey: (id: string): Promise<ApiKey | null> => ipcRenderer.invoke(IPC.KeyCheck, id),
    setAzure: (endpoint: string, key: string): Promise<AzureConnection> =>
      ipcRenderer.invoke(IPC.AzureSet, endpoint, key),
    reprobeAzure: (): Promise<AzureConnection | null> => ipcRenderer.invoke(IPC.AzureReprobe),
    removeAzure: (): Promise<void> => ipcRenderer.invoke(IPC.AzureRemove),
    setDeployment: (
      name: string,
      patch: { model?: string | null; enabled?: boolean }
    ): Promise<void> => ipcRenderer.invoke(IPC.AzureSetDeployment, name, patch),
    removeDeployment: (name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AzureRemoveDeployment, name),
    ollama: {
      refresh: (): Promise<OllamaState> => ipcRenderer.invoke(IPC.OllamaRefresh),
      start: (): Promise<OllamaState> => ipcRenderer.invoke(IPC.OllamaStart),
      pull: (name: string): Promise<void> => ipcRenderer.invoke(IPC.OllamaPull, name),
      cancelPull: (name: string): Promise<void> => ipcRenderer.invoke(IPC.OllamaCancelPull, name),
      remove: (name: string): Promise<OllamaState> => ipcRenderer.invoke(IPC.OllamaRemove, name),
      unload: (name: string): Promise<OllamaState> => ipcRenderer.invoke(IPC.OllamaUnload, name)
    }
  },
  // An artifact in a window of its own (the window reads it back by id).
  artifact: {
    popOut: (artifact: ArtifactSnapshot): Promise<void> =>
      ipcRenderer.invoke(IPC.ArtifactPopOut, artifact),
    snapshot: (id: string): Promise<ArtifactSnapshot | null> =>
      ipcRenderer.invoke(IPC.ArtifactSnapshot, id)
  },
  // A chat laid out for print says when it has finished drawing.
  print: {
    ready: (): void => ipcRenderer.send(IPC.PrintReady)
  },
  // What chats remember about you (Settings → Memory, and Undo in a chat).
  memory: {
    list: (): Promise<Memory[]> => ipcRenderer.invoke(IPC.MemoryList),
    update: (id: number, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.MemoryUpdate, id, text),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.MemoryRemove, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.MemoryClear)
  },
  // Settings → Profile, Appearance and Defaults.
  settings: {
    get: (): Promise<ChatSettings> => ipcRenderer.invoke(IPC.SettingsGet),
    set: (changes: Partial<ChatSettings>): Promise<ChatSettings> =>
      ipcRenderer.invoke(IPC.SettingsSet, changes),
    setTheme: (theme: 'system' | 'light' | 'dark'): Promise<void> =>
      ipcRenderer.invoke(IPC.AppSetTheme, theme)
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
    setBalance: (guestId: string, pool: CreditPool, balance: number): Promise<AdminGuest> =>
      ipcRenderer.invoke(IPC.RelayAdminBalance, guestId, pool, balance),
    setPaused: (guestId: string, pool: CreditPool, paused: boolean): Promise<AdminGuest> =>
      ipcRenderer.invoke(IPC.RelayAdminPause, guestId, pool, paused),
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
    // Pasted bytes with no file behind them (a screenshot, long text) saved
    // as a file; returns the path the session should reference.
    saveBlob: (workspaceId: string, data: Uint8Array, extension: string): Promise<string> =>
      ipcRenderer.invoke(IPC.ClipboardSaveBlob, workspaceId, data, extension),
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
