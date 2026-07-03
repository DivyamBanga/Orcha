import { create } from 'zustand'
import { reduceMessage } from './wireIpc'
import type { Project, Workspace, SessionStatus, GitStatus, ChatItem } from '../../shared/types'

interface OrchaStore {
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null // workspace id or 'orchestrator'
  sessionStatus: Record<string, SessionStatus>
  gitStatus: Record<string, GitStatus>
  messages: Record<string, ChatItem[]>
  streaming: Record<string, string>
  showNewWorkspace: boolean
  activeTab: 'chat' | 'terminal'
  openTerminals: string[]

  load: () => Promise<void>
  addProject: () => Promise<void>
  createWorkspace: (projectId: string, name: string) => Promise<void>
  archiveWorkspace: (workspaceId: string) => Promise<void>
  loadHistory: (workspaceId: string) => Promise<void>
  sendPrompt: (workspaceId: string, text: string) => void
  interrupt: (workspaceId: string) => void
  setActiveWorkspace: (id: string | null) => void
  setShowNewWorkspace: (show: boolean) => void
  setActiveTab: (tab: 'chat' | 'terminal') => void
}

export const useStore = create<OrchaStore>((set) => ({
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  sessionStatus: {},
  gitStatus: {},
  messages: {},
  streaming: {},
  showNewWorkspace: false,
  activeTab: 'chat',
  openTerminals: [],

  load: async () => {
    const [projects, workspaces] = await Promise.all([
      window.orcha.projects.list(),
      window.orcha.workspaces.list()
    ])
    set({ projects, workspaces })
  },

  addProject: async () => {
    const project = await window.orcha.projects.add()
    if (project) {
      set((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects
          : [...s.projects, project]
      }))
    }
  },

  createWorkspace: async (projectId, name) => {
    const workspace = await window.orcha.workspaces.create(projectId, name)
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      showNewWorkspace: false
    }))
  },

  archiveWorkspace: async (workspaceId) => {
    await window.orcha.workspaces.archive(workspaceId)
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
      activeWorkspaceId: s.activeWorkspaceId === workspaceId ? null : s.activeWorkspaceId,
      openTerminals: s.openTerminals.filter((id) => id !== workspaceId)
    }))
  },

  loadHistory: async (workspaceId) => {
    if (useStore.getState().messages[workspaceId] !== undefined) return
    // Mark as loading synchronously so concurrent calls no-op.
    set((s) => ({ messages: { ...s.messages, [workspaceId]: [] } }))
    const raw = await window.orcha.session.history(workspaceId)
    if (raw.length === 0) return
    let items: ChatItem[] = []
    let streamingText = ''
    for (const msg of raw) {
      const reduced = reduceMessage(items, streamingText, msg as never, true)
      items = reduced.items
      streamingText = reduced.streamingText
    }
    set((s) => ({
      // Live events may have arrived while reading history; keep them after it.
      messages: { ...s.messages, [workspaceId]: [...items, ...(s.messages[workspaceId] ?? [])] }
    }))
  },

  sendPrompt: (workspaceId, text) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [workspaceId]: [...(s.messages[workspaceId] ?? []), { kind: 'user', text }]
      },
      sessionStatus: { ...s.sessionStatus, [workspaceId]: 'busy' }
    }))
    window.orcha.session.send(workspaceId, text).catch((err) => {
      set((s) => ({
        messages: {
          ...s.messages,
          [workspaceId]: [
            ...(s.messages[workspaceId] ?? []),
            { kind: 'error', text: err instanceof Error ? err.message : String(err) }
          ]
        }
      }))
    })
  },

  interrupt: (workspaceId) => {
    window.orcha.session.interrupt(workspaceId)
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id, activeTab: 'chat' }),
  setShowNewWorkspace: (show) => set({ showNewWorkspace: show }),
  setActiveTab: (tab) =>
    set((s) => ({
      activeTab: tab,
      openTerminals:
        tab === 'terminal' &&
        s.activeWorkspaceId &&
        s.activeWorkspaceId !== 'orchestrator' &&
        !s.openTerminals.includes(s.activeWorkspaceId)
          ? [...s.openTerminals, s.activeWorkspaceId]
          : s.openTerminals
    }))
}))

export function useActiveWorkspace(): Workspace | undefined {
  const id = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  return workspaces.find((w) => w.id === id)
}
