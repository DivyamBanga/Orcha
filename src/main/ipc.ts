import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import * as db from './db'
import type { Project } from '../shared/types'
import type { WorkspaceManager } from './services/WorkspaceManager'
import type { SessionManager } from './services/SessionManager'
import type { PtyManager } from './services/PtyManager'
import type { GitService } from './services/GitService'

interface Services {
  workspaceManager: WorkspaceManager
  sessionManager: SessionManager
  ptyManager: PtyManager
  gitService: GitService
}

export function registerIpc(mainWindow: BrowserWindow, services: Services): void {
  const { workspaceManager, sessionManager, ptyManager, gitService } = services

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

  ipcMain.handle(IPC.SessionSend, (_e, workspaceId: string, text: string) =>
    sessionManager.sendPrompt(workspaceId, text)
  )
  ipcMain.handle(IPC.SessionInterrupt, (_e, workspaceId: string) =>
    sessionManager.interrupt(workspaceId)
  )
  ipcMain.handle(IPC.SessionHistory, (_e, workspaceId: string) =>
    sessionManager.getHistory(workspaceId)
  )

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

  ipcMain.handle(IPC.GitStatus, (_e, workspaceId: string) => gitService.status(workspaceId))
  ipcMain.handle(IPC.GitCommitPush, (_e, workspaceId: string, message: string) =>
    gitService.commitAndPush(workspaceId, message)
  )
  ipcMain.handle(IPC.GitCreatePr, (_e, workspaceId: string) => gitService.createPr(workspaceId))
}
