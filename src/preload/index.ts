import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { Project } from '../shared/types'

const api = {
  projects: {
    add: (repoPath?: string): Promise<Project | null> => ipcRenderer.invoke(IPC.ProjectsAdd, repoPath),
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.ProjectsList)
  },
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type OrchaApi = typeof api

contextBridge.exposeInMainWorld('orcha', api)
