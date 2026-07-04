import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import * as db from '../db'
import type { Workspace } from '../../shared/types'

const execFileAsync = promisify(execFile)

const WORKTREE_ROOT = join(homedir(), '.orcha', 'worktrees')

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workspace'
}

export class WorkspaceManager {
  // Serialize worktree operations per project: concurrent `git worktree add`
  // on one repo can collide on .git/worktrees locks.
  private queues = new Map<string, Promise<unknown>>()

  // Called before archiving so sessions/ptys holding the worktree cwd can be
  // shut down first (wired up by SessionManager/PtyManager registration).
  onBeforeArchive: ((workspaceId: string) => Promise<void>) | null = null

  private enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.queues.set(projectId, next)
    return next
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args])
    return stdout
  }

  async create(
    projectId: string,
    name: string,
    model: string | null = null,
    effort: Workspace['effort'] = null
  ): Promise<Workspace> {
    const project = db.projects.list().find((p) => p.id === projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)

    return this.enqueue(projectId, async () => {
      const base = slugify(name)
      let slug = base
      for (let i = 2; ; i++) {
        const branchTaken = await this.git(project.repoPath, [
          'branch',
          '--list',
          `orcha/${slug}`
        ]).then((out) => out.trim() !== '')
        const dirTaken = existsSync(join(WORKTREE_ROOT, project.name, slug))
        if (!branchTaken && !dirTaken) break
        slug = `${base}-${i}`
      }

      const branch = `orcha/${slug}`
      const worktreePath = join(WORKTREE_ROOT, project.name, slug)
      mkdirSync(join(WORKTREE_ROOT, project.name), { recursive: true })

      await this.git(project.repoPath, ['worktree', 'add', worktreePath, '-b', branch])

      const workspace: Workspace = {
        id: randomUUID(),
        projectId,
        name,
        branch,
        worktreePath,
        sessionId: null,
        status: 'active',
        createdAt: Date.now(),
        lastActivityAt: null,
        model,
        effort,
        kind: 'worktree'
      }
      db.workspaces.insert(workspace)
      return workspace
    })
  }

  // The default tab for a project: a session rooted at the repo folder itself.
  createMain(projectId: string): Workspace {
    const project = db.projects.list().find((p) => p.id === projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const workspace: Workspace = {
      id: randomUUID(),
      projectId,
      name: project.name,
      branch: '',
      worktreePath: project.repoPath,
      sessionId: null,
      status: 'active',
      createdAt: Date.now(),
      lastActivityAt: null,
      model: null,
      effort: null,
      kind: 'main'
    }
    db.workspaces.insert(workspace)
    return workspace
  }

  async archive(workspaceId: string): Promise<void> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)

    await this.onBeforeArchive?.(workspaceId)

    // NEVER remove folders for main sessions — that's the user's actual repo.
    const project =
      workspace.kind === 'worktree'
        ? db.projects.list().find((p) => p.id === workspace.projectId)
        : undefined
    if (project) {
      await this.enqueue(workspace.projectId, async () => {
        try {
          await this.git(project.repoPath, ['worktree', 'remove', '--force', workspace.worktreePath])
        } catch {
          // Windows file locks: retry once after the holder had time to die.
          await new Promise((r) => setTimeout(r, 500))
          await this.git(project.repoPath, ['worktree', 'remove', '--force', workspace.worktreePath])
        }
        await this.git(project.repoPath, ['worktree', 'prune'])
      })
    }
    db.workspaces.setStatus(workspaceId, 'archived')
  }
}
