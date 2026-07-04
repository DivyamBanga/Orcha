import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { GitStatus, Project, Workspace } from '../shared/types'

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
    add: (repoPath?: string): Promise<Project | null> =>
      ipcRenderer.invoke(IPC.ProjectsAdd, repoPath),
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.ProjectsList),
    createRepo: (name: string, isPrivate: boolean): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsCreateRepo, name, isPrivate),
    listGithub: (): Promise<{ nameWithOwner: string; name: string }[]> =>
      ipcRenderer.invoke(IPC.ProjectsListGithub),
    cloneGithub: (nameWithOwner: string): Promise<Project> =>
      ipcRenderer.invoke(IPC.ProjectsCloneGithub, nameWithOwner),
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
      effort: string | null = null
    ): Promise<Workspace> => ipcRenderer.invoke(IPC.WorkspacesCreate, projectId, name, model, effort),
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.WorkspacesList),
    archive: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.WorkspacesArchive, workspaceId)
  },
  // Types a prompt into a session's Claude terminal.
  session: {
    send: (workspaceId: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SessionSend, workspaceId, text)
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
