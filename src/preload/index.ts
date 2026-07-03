import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { Project, Workspace } from '../shared/types'

const api = {
  projects: {
    add: (repoPath?: string): Promise<Project | null> => ipcRenderer.invoke(IPC.ProjectsAdd, repoPath),
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.ProjectsList)
  },
  workspaces: {
    create: (projectId: string, name: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC.WorkspacesCreate, projectId, name),
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.WorkspacesList),
    archive: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.WorkspacesArchive, workspaceId)
  },
  session: {
    send: (workspaceId: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SessionSend, workspaceId, text),
    interrupt: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SessionInterrupt, workspaceId)
  },
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type OrchaApi = typeof api

contextBridge.exposeInMainWorld('orcha', api)
