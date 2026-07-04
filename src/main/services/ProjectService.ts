import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import * as db from '../db'
import type { Project } from '../../shared/types'
import type { WorkspaceManager } from './WorkspaceManager'

const execFileAsync = promisify(execFile)

export const PROJECTS_ROOT = join(homedir(), 'Desktop', 'Projects')

export class ProjectService {
  constructor(private workspaceManager: WorkspaceManager) {}

  // Idempotent: registers the repo as a project and ensures a main session tab.
  register(repoPath: string): Project {
    const existing = db.projects.byRepoPath(repoPath)
    if (existing) {
      const hasMain = db.workspaces
        .listActive()
        .some((w) => w.projectId === existing.id && w.kind === 'main')
      if (!hasMain) this.workspaceManager.createMain(existing.id)
      return existing
    }
    const project: Project = {
      id: randomUUID(),
      name: basename(repoPath),
      repoPath,
      createdAt: Date.now()
    }
    db.projects.insert(project)
    this.workspaceManager.createMain(project.id)
    return project
  }

  addLocal(repoPath: string): Project {
    if (!existsSync(join(repoPath, '.git'))) {
      throw new Error(`Not a git repository: ${repoPath}`)
    }
    return this.register(repoPath)
  }

  // Create a new GitHub repo (with README so the clone has a commit), clone it
  // under Desktop\Projects, and register it.
  async createRepo(name: string, isPrivate: boolean): Promise<Project> {
    mkdirSync(PROJECTS_ROOT, { recursive: true })
    const target = join(PROJECTS_ROOT, name)
    if (existsSync(target)) throw new Error(`Folder already exists: ${target}`)
    await execFileAsync(
      'gh',
      ['repo', 'create', name, isPrivate ? '--private' : '--public', '--clone', '--add-readme'],
      { cwd: PROJECTS_ROOT }
    )
    return this.register(target)
  }

  async listGithub(): Promise<{ nameWithOwner: string; name: string }[]> {
    const { stdout } = await execFileAsync('gh', [
      'repo',
      'list',
      '--json',
      'nameWithOwner,name',
      '--limit',
      '100'
    ])
    return JSON.parse(stdout)
  }

  // Unregister a project from Orcha. Closes its sessions (worktree folders are
  // removed, the repo folder itself is never touched) and drops the entry.
  async remove(projectId: string): Promise<void> {
    const sessions = db.workspaces.listActive().filter((w) => w.projectId === projectId)
    for (const session of sessions) {
      await this.workspaceManager.archive(session.id)
    }
    // Drop the session rows too — archived rows would block the project
    // delete via the foreign key.
    db.workspaces.removeByProject(projectId)
    db.projects.remove(projectId)
  }

  async cloneGithub(nameWithOwner: string): Promise<Project> {
    mkdirSync(PROJECTS_ROOT, { recursive: true })
    const name = nameWithOwner.split('/').pop() ?? nameWithOwner
    const target = join(PROJECTS_ROOT, name)
    if (!existsSync(target)) {
      await execFileAsync('gh', ['repo', 'clone', nameWithOwner, target])
    }
    return this.register(target)
  }
}
