import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import * as db from './db'
import type { Project } from '../shared/types'

export function registerIpc(mainWindow: BrowserWindow): void {
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
}
