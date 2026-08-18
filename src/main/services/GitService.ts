import { execFileAsync } from '../exec'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import type { GitStatus } from '../../shared/types'


type SendFn = (channel: string, payload: unknown) => void

export class GitService {
  constructor(private send: SendFn) {}

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args])
    return stdout
  }

  async status(workspaceId: string): Promise<GitStatus> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)

    const out = await this.git(workspace.worktreePath, [
      'status',
      '--porcelain=v2',
      '--branch'
    ])
    let branch = workspace.branch
    let ahead = 0
    let behind = 0
    let dirty = false
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      } else if (line && !line.startsWith('#')) dirty = true
    }
    const status: GitStatus = { branch, dirty, ahead, behind }
    this.send(IPC.EvGitStatus, { workspaceId, status })
    return status
  }

  async commitAndPush(workspaceId: string, message: string): Promise<void> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const cwd = workspace.worktreePath

    await this.git(cwd, ['add', '-A'])
    const staged = await this.git(cwd, ['status', '--porcelain'])
    if (staged.trim()) {
      await this.git(cwd, ['commit', '-m', message])
    }
    // HEAD works for main sessions (whatever branch is checked out) and worktrees alike.
    await this.git(cwd, ['push', '-u', 'origin', 'HEAD'])
    await this.status(workspaceId)
  }

  async pull(workspaceId: string): Promise<void> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    await this.git(workspace.worktreePath, ['pull', '--ff-only'])
    await this.status(workspaceId)
  }

  // Compact per-session git snapshot for remote surfaces (the phone, Daisy's
  // WhatsApp door): status plus the last commit in one call. Local repos only —
  // ssh projects have no local checkout to ask.
  async summary(workspaceId: string): Promise<{
    branch: string
    dirtyFiles: number
    ahead: number
    behind: number
    lastCommit: { subject: string; ageS: number } | null
  }> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const cwd = workspace.worktreePath

    const out = await this.git(cwd, ['status', '--porcelain=v2', '--branch'])
    let branch = workspace.branch
    let ahead = 0
    let behind = 0
    let dirtyFiles = 0
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      } else if (line && !line.startsWith('#')) dirtyFiles++
    }

    let lastCommit: { subject: string; ageS: number } | null = null
    try {
      const log = await this.git(cwd, ['log', '-1', '--format=%ct%x09%s'])
      const [ct, ...rest] = log.trim().split('\t')
      const subject = rest.join('\t')
      if (subject) {
        lastCommit = { subject, ageS: Math.max(0, Math.floor(Date.now() / 1000 - Number(ct))) }
      }
    } catch {
      // repo with no commits yet
    }
    return { branch, dirtyFiles, ahead, behind, lastCommit }
  }

  // https URL of the repo at the current branch, from the origin remote.
  async githubUrl(workspaceId: string): Promise<string> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const remote = (await this.git(workspace.worktreePath, ['remote', 'get-url', 'origin'])).trim()
    const https = remote
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '')
    const branch = (
      await this.git(workspace.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim()
    return branch && branch !== 'HEAD' ? `${https}/tree/${branch}` : https
  }

  async createPr(workspaceId: string): Promise<{ url: string }> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const cwd = workspace.worktreePath

    // Push first so the PR has a head; gh infers the branch from the checkout.
    await this.git(cwd, ['push', '-u', 'origin', 'HEAD'])
    const { stdout } = await execFileAsync('gh', ['pr', 'create', '--fill'], { cwd })
    const url = stdout.trim().split('\n').pop() ?? ''
    await this.status(workspaceId)
    return { url }
  }
}
