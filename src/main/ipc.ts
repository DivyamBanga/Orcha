import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import * as db from './db'
import type { Project } from '../shared/types'
import type { WorkspaceManager } from './services/WorkspaceManager'

interface Services {
  workspaceManager: WorkspaceManager
}

export function registerIpc(mainWindow: BrowserWindow, services: Services): void {
  const { workspaceManager } = services

  ipcMain.handle(IPC.ProjectsAdd, async (_e, pickedPath?: string): Promise<Project | null> => {
    let repoPath = pickedPath
    if (!repoPath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Add a git repository',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      repoPath = result.filePaths[0]
    }
    if (!existsSync(join(repoPath, '.git'))) {
      throw new Error(`Not a git repository: ${repoPath}`)
    }
    const existing = db.projects.byRepoPath(repoPath)
    if (existing) return existing

    const project: Project = {
      id: randomUUID(),
      name: basename(repoPath),
      repoPath,
      createdAt: Date.now()
    }
    db.projects.insert(project)
    return project
  })

  ipcMain.handle(IPC.ProjectsList, () => db.projects.list())

  ipcMain.handle(IPC.WorkspacesCreate, (_e, projectId: string, name: string) =>
    workspaceManager.create(projectId, name)
  )
  ipcMain.handle(IPC.WorkspacesList, () => db.workspaces.listActive())
  ipcMain.handle(IPC.WorkspacesArchive, (_e, workspaceId: string) =>
    workspaceManager.archive(workspaceId)
  )
}
