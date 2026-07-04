import { create } from 'zustand'
import { reduceMessage } from './wireIpc'
import type { Project, Workspace, SessionStatus, GitStatus, ChatItem } from '../../shared/types'

const MC = 'orchestrator'

interface OrchaStore {
  setup: { gh: boolean; claude: boolean } | null
  projects: Project[]
  workspaces: Workspace[]
  activeId: string | null // workspace id or 'orchestrator'
  openSessions: string[] // terminals kept mounted
  gitStatus: Record<string, GitStatus>
  unread: Record<string, boolean>

  // Mission Control chat state (keyed map so wireIpc stays generic)
  messages: Record<string, ChatItem[]>
  streaming: Record<string, string>
  sessionStatus: Record<string, SessionStatus>
  slashCommands: Record<string, string[]>

  showNewProject: boolean
  showNewSession: boolean

  checkSetup: () => Promise<void>
  load: () => Promise<void>
  setActive: (id: string | null) => void
  archiveSession: (workspaceId: string) => Promise<void>
  createParallelSession: (
    projectId: string,
    name: string,
    model?: string | null,
    effort?: string | null
  ) => Promise<void>
  updateWorkspaceSettings: (
    workspaceId: string,
    model: string | null,
    effort: string | null
  ) => Promise<void>
  mcSend: (text: string) => void
  mcInterrupt: () => void
  mcLoadHistory: () => Promise<void>
  setShowNewProject: (show: boolean) => void
  setShowNewSession: (show: boolean) => void
}

export const useStore = create<OrchaStore>((set) => ({
  setup: null,
  projects: [],
  workspaces: [],
  activeId: null,
  openSessions: [],
  gitStatus: {},
  unread: {},
  messages: {},
  streaming: {},
  sessionStatus: {},
  slashCommands: {},
  showNewProject: false,
  showNewSession: false,

  checkSetup: async () => {
    const setup = await window.orcha.setup.status()
    set({ setup })
  },

  load: async () => {
    const [projects, workspaces] = await Promise.all([
      window.orcha.projects.list(),
      window.orcha.workspaces.list()
    ])
    set({ projects, workspaces })
  },

  setActive: (id) =>
    set((s) => ({
      activeId: id,
      unread: id ? { ...s.unread, [id]: false } : s.unread,
      openSessions:
        id && id !== MC && !s.openSessions.includes(id)
          ? [...s.openSessions, id]
          : s.openSessions
    })),

  archiveSession: async (workspaceId) => {
    await window.orcha.workspaces.archive(workspaceId)
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
      activeId: s.activeId === workspaceId ? null : s.activeId,
      openSessions: s.openSessions.filter((id) => id !== workspaceId)
    }))
  },

  createParallelSession: async (projectId, name, model = null, effort = null) => {
    const workspace = await window.orcha.workspaces.create(projectId, name, model, effort)
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeId: workspace.id,
      openSessions: [...s.openSessions, workspace.id],
      showNewSession: false
    }))
  },

  updateWorkspaceSettings: async (workspaceId, model, effort) => {
    await window.orcha.workspaces.updateSettings(workspaceId, model, effort)
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, model, effort: effort as Workspace['effort'] } : w
      )
    }))
  },

  mcSend: (text) => {
    set((s) => ({
      messages: { ...s.messages, [MC]: [...(s.messages[MC] ?? []), { kind: 'user', text }] },
      sessionStatus: { ...s.sessionStatus, [MC]: 'busy' }
    }))
    window.orcha.orchestrator.send(text).catch((err) => {
      set((s) => ({
        messages: {
          ...s.messages,
          [MC]: [
            ...(s.messages[MC] ?? []),
            { kind: 'error', text: err instanceof Error ? err.message : String(err) }
          ]
        }
      }))
    })
  },

  mcInterrupt: () => {
    window.orcha.orchestrator.interrupt()
  },

  mcLoadHistory: async () => {
    if (useStore.getState().messages[MC] !== undefined) return
    set((s) => ({ messages: { ...s.messages, [MC]: [] } }))
    const raw = await window.orcha.orchestrator.history()
    if (raw.length === 0) return
    let items: ChatItem[] = []
    let streamingText = ''
    for (const msg of raw) {
      const reduced = reduceMessage(items, streamingText, msg as never, true)
      items = reduced.items
      streamingText = reduced.streamingText
    }
    set((s) => ({
      messages: { ...s.messages, [MC]: [...items, ...(s.messages[MC] ?? [])] }
    }))
  },

  setShowNewProject: (show) => set({ showNewProject: show }),
  setShowNewSession: (show) => set({ showNewSession: show })
}))

export function useActiveWorkspace(): Workspace | undefined {
  const id = useStore((s) => s.activeId)
  const workspaces = useStore((s) => s.workspaces)
  return workspaces.find((w) => w.id === id)
}
