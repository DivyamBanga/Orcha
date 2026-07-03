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
