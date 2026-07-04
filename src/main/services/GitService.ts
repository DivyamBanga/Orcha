import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import type { GitStatus } from '../../shared/types'

const execFileAsync = promisify(execFile)

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
    await this.git(cwd, ['push', '-u', 'origin', workspace.branch])
    await this.status(workspaceId)
  }

  async createPr(workspaceId: string): Promise<{ url: string }> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const cwd = workspace.worktreePath

    // Push first so the PR has a head.
    await this.git(cwd, ['push', '-u', 'origin', workspace.branch])
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'create', '--fill', '--head', workspace.branch],
      { cwd }
    )
    const url = stdout.trim().split('\n').pop() ?? ''
    await this.status(workspaceId)
    return { url }
  }
}
