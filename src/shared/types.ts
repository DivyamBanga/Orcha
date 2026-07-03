export interface Project {
  id: string
  name: string
  repoPath: string
  createdAt: number
}

export interface Workspace {
  id: string
  projectId: string
  name: string
  branch: string
  worktreePath: string
  sessionId: string | null
  status: 'active' | 'archived'
  createdAt: number
  lastActivityAt: number | null
}

export type SessionStatus = 'idle' | 'busy' | 'error'

export interface GitStatus {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
}
