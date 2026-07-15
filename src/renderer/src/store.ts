import { create } from 'zustand'
import { reduceMessage } from './wireIpc'
import type { Project, Workspace, SessionStatus, GitStatus, ChatItem } from '../../shared/types'

const MC = 'orchestrator'

function persistOpenSessions(ids: string[]): void {
  window.orcha.ui.saveState('openSessions', JSON.stringify(ids)).catch(() => {})
}

interface OrchaStore {
  setup: { gh: boolean; claude: boolean } | null
  projects: Project[]
  workspaces: Workspace[]
  activeId: string | null // workspace id or 'orchestrator'
  openSessions: string[] // terminals kept mounted
  activity: Record<string, 'working' | 'waiting' | 'off'>
  gitStatus: Record<string, GitStatus>
  unread: Record<string, boolean>
  mcQueue: string[]
  // Live-share state per session: progress phase while the tunnel spins up,
  // then the public URL once ready.
  shareStatus: Record<string, { phase: string; url?: string }>
  // Which link modal is open (live share or phone Remote Control), if any.
  linkModal: { kind: 'share' | 'phone'; workspaceId: string } | null

  // Mission Control chat state (keyed map so wireIpc stays generic)
  messages: Record<string, ChatItem[]>
  streaming: Record<string, string>
  sessionStatus: Record<string, SessionStatus>
  slashCommands: Record<string, string[]>

  showNewProject: boolean
  // Project id to preselect in the parallel-session dialog, or null = closed.
  showNewSession: string | null

  checkSetup: () => Promise<void>
  load: () => Promise<void>
  restoreOpenSessions: () => Promise<void>
  setActive: (id: string | null) => void
  archiveSession: (workspaceId: string) => Promise<void>
  removeProject: (projectId: string) => Promise<void>
  createParallelSession: (
    projectId: string,
    name: string,
    model?: string | null,
    effort?: string | null
  ) => Promise<void>
  mcSend: (text: string) => void
  mcInterrupt: () => void
  mcLoadHistory: () => Promise<void>
  setShowNewProject: (show: boolean) => void
  setShowNewSession: (projectId: string | null) => void
  setLinkModal: (modal: { kind: 'share' | 'phone'; workspaceId: string } | null) => void
}

export const useStore = create<OrchaStore>((set) => ({
  setup: null,
  projects: [],
  workspaces: [],
  activeId: null,
  openSessions: [],
  activity: {},
  gitStatus: {},
  unread: {},
  mcQueue: [],
  shareStatus: {},
  linkModal: null,
  messages: {},
  streaming: {},
  sessionStatus: {},
  slashCommands: {},
  showNewProject: false,
  showNewSession: null,

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

  // Reopen the sessions that were live when the app last quit.
  restoreOpenSessions: async () => {
    const raw = await window.orcha.ui.getState('openSessions')
    if (!raw) return
    let ids: string[]
    try {
      ids = JSON.parse(raw)
    } catch {
      return
    }
    const valid = ids.filter((id) => useStore.getState().workspaces.some((w) => w.id === id))
    if (valid.length > 0) {
      set((s) => ({ openSessions: [...new Set([...s.openSessions, ...valid])] }))
    }
  },

  setActive: (id) =>
    set((s) => {
      const openSessions =
        id && id !== MC && !s.openSessions.includes(id)
          ? [...s.openSessions, id]
          : s.openSessions
      if (openSessions !== s.openSessions) persistOpenSessions(openSessions)
      return {
        activeId: id,
        unread: id ? { ...s.unread, [id]: false } : s.unread,
        openSessions
      }
    }),

  archiveSession: async (workspaceId) => {
    await window.orcha.workspaces.archive(workspaceId)
    set((s) => {
      const openSessions = s.openSessions.filter((id) => id !== workspaceId)
      persistOpenSessions(openSessions)
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        activeId: s.activeId === workspaceId ? null : s.activeId,
        openSessions
      }
    })
  },

  removeProject: async (projectId) => {
    await window.orcha.projects.remove(projectId)
    set((s) => {
      const removedIds = s.workspaces.filter((w) => w.projectId === projectId).map((w) => w.id)
      return {
        projects: s.projects.filter((p) => p.id !== projectId),
        workspaces: s.workspaces.filter((w) => w.projectId !== projectId),
        openSessions: s.openSessions.filter((id) => !removedIds.includes(id)),
        activeId: removedIds.includes(s.activeId ?? '') ? null : s.activeId
      }
    })
  },

  createParallelSession: async (projectId, name, model = null, effort = null) => {
    const workspace = await window.orcha.workspaces.create(projectId, name, model, effort)
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeId: workspace.id,
      openSessions: [...s.openSessions, workspace.id],
      showNewSession: null
    }))
  },

  mcSend: (text) => {
    const busy = useStore.getState().sessionStatus[MC] === 'busy'
    if (busy) {
      // Queue it; wireIpc flushes when the current turn ends.
      set((s) => ({
        mcQueue: [...s.mcQueue, text],
        messages: { ...s.messages, [MC]: [...(s.messages[MC] ?? []), { kind: 'user', text }] }
      }))
      return
    }
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
  setShowNewSession: (projectId) => set({ showNewSession: projectId }),
  setLinkModal: (modal) => set({ linkModal: modal })
}))

export function useActiveWorkspace(): Workspace | undefined {
  const id = useStore((s) => s.activeId)
  const workspaces = useStore((s) => s.workspaces)
  return workspaces.find((w) => w.id === id)
}
