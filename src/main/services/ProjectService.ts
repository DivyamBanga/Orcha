import { execFileAsync } from '../exec'
import { existsSync, mkdirSync } from 'fs'
import { join, basename, posix } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import * as db from '../db'
import type { Agent, Project } from '../../shared/types'
import type { WorkspaceManager } from './WorkspaceManager'
import { verifyRemotePath } from '../ssh'


// A Mac keeps it out of Desktop: that folder is permission-gated, and with
// iCloud's Desktop sync on it would upload every repo (which corrupts git).
export const PROJECTS_ROOT =
  process.platform === 'darwin'
    ? join(homedir(), 'Projects')
    : join(homedir(), 'Desktop', 'Projects')

export class ProjectService {
  constructor(private workspaceManager: WorkspaceManager) {}

  // Ensures a project has a main session tab (idempotent).
  private ensureMainWorkspace(projectId: string, agent: Agent = 'claude'): void {
    const hasMain = db.workspaces
      .listActive()
      .some((w) => w.projectId === projectId && w.kind === 'main')
    if (!hasMain) this.workspaceManager.createMain(projectId, agent)
  }

  // Idempotent: registers the repo as a project and ensures a main session tab.
  // `agent` picks what that tab runs when it's first created.
  register(repoPath: string, agent: Agent = 'claude'): Project {
    const existing = db.projects.byRepoPath(repoPath)
    if (existing) {
      this.ensureMainWorkspace(existing.id, agent)
      return existing
    }
    const project: Project = {
      id: randomUUID(),
      name: basename(repoPath),
      repoPath,
      createdAt: Date.now(),
      remotePath: null,
      sshHost: null,
      sshUser: null,
      sshPort: null,
      chatOnly: false
    }
    db.projects.insert(project)
    this.workspaceManager.createMain(project.id, agent)
    return project
  }

  // A project for chats alone: no folder, so no sessions.
  createChatProject(name: string): Project {
    const id = randomUUID()
    const project: Project = {
      id,
      name: name.trim().slice(0, 80) || 'New project',
      repoPath: `chat:${id}`,
      createdAt: Date.now(),
      remotePath: null,
      sshHost: null,
      sshUser: null,
      sshPort: null,
      chatOnly: true
    }
    db.projects.insert(project)
    return project
  }

  // Registers a server folder reachable over SSH as a project (the "remote
  // Claude workspace" flow — same tab UI as local, but the pty runs `ssh`
  // instead of a local shell; see PtyManager.doCreate).
  async addRemote(
    host: string,
    user: string,
    port: number | null,
    remotePath: string
  ): Promise<Project> {
    await verifyRemotePath({ host, user, port }, remotePath)

    const key = `ssh://${user}@${host}:${port ?? 22}${remotePath}`
    const existing = db.projects.byRepoPath(key)
    if (existing) {
      this.ensureMainWorkspace(existing.id)
      return existing
    }
    const project: Project = {
      id: randomUUID(),
      name: posix.basename(remotePath) || host,
      repoPath: key,
      createdAt: Date.now(),
      remotePath,
      sshHost: host,
      sshUser: user,
      sshPort: port,
      chatOnly: false
    }
    db.projects.insert(project)
    this.workspaceManager.createMain(project.id)
    return project
  }

  addLocal(repoPath: string, agent: Agent = 'claude'): Project {
    if (!existsSync(join(repoPath, '.git'))) {
      throw new Error(`Not a git repository: ${repoPath}`)
    }
    return this.register(repoPath, agent)
  }

  // Create a new GitHub repo (with README so the clone has a commit), clone it
  // under PROJECTS_ROOT, and register it.
  async createRepo(name: string, isPrivate: boolean, agent: Agent = 'claude'): Promise<Project> {
    mkdirSync(PROJECTS_ROOT, { recursive: true })
    const target = join(PROJECTS_ROOT, name)
    if (existsSync(target)) throw new Error(`Folder already exists: ${target}`)
    await execFileAsync(
      'gh',
      ['repo', 'create', name, isPrivate ? '--private' : '--public', '--clone', '--add-readme'],
      { cwd: PROJECTS_ROOT }
    )
    return this.register(target, agent)
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

  async cloneGithub(nameWithOwner: string, agent: Agent = 'claude'): Promise<Project> {
    mkdirSync(PROJECTS_ROOT, { recursive: true })
    const name = nameWithOwner.split('/').pop() ?? nameWithOwner
    const target = join(PROJECTS_ROOT, name)
    if (!existsSync(target)) {
      await execFileAsync('gh', ['repo', 'clone', nameWithOwner, target])
    }
    return this.register(target, agent)
  }
}
