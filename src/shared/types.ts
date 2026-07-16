export interface Project {
  id: string
  name: string
  repoPath: string // unique key; for remote projects a display/dedup ssh:// string, not a real path
  createdAt: number
  remotePath: string | null // actual POSIX path to cd into on the server; null = local project
  sshHost: string | null
  sshUser: string | null
  sshPort: number | null // null = default 22
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Workspace {
  id: string
  projectId: string
  name: string
  branch: string
  worktreePath: string // for kind 'main' this IS the repo folder
  sessionId: string | null
  status: 'active' | 'archived'
  createdAt: number
  lastActivityAt: number | null
  model: string | null // null = account default; else 'opus' | 'sonnet' | 'haiku'
  effort: EffortLevel | null // null = default
  kind: 'main' | 'worktree'
}

export type SessionStatus = 'idle' | 'busy' | 'error'

// Renderer-side chat items, reduced from raw SDK messages.
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_text'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      input: unknown
      result?: string
      isError?: boolean
    }
  | { kind: 'error'; text: string }

export interface GitStatus {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
}
