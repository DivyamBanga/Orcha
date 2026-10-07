import { create } from 'zustand'
import { reduceMessage } from './wireIpc'
import type {
  Project,
  Workspace,
  SessionStatus,
  GitStatus,
  ChatItem,
  SessionUsage,
  UsageSummary,
  GuestBalance,
  GuestStatus,
  GuestUsage,
  ToolsStatus,
  Agent
} from '../../shared/types'

// A small in-app message (budget warnings and the like). Not an OS toast:
// these are about the app itself, so they only matter while you're in it.
export interface Notice {
  id: string
  text: string
  tone: 'neutral' | 'warn' | 'danger'
  // A button on the notice; without one, clicking it opens Credits.
  action?: { label: string; run: () => void }
  // Stays until dismissed even when it isn't 'danger'.
  sticky?: boolean
}

const MC = 'orchestrator'

function persistOpenSessions(ids: string[]): void {
  window.orcha.ui.saveState('openSessions', JSON.stringify(ids)).catch(() => {})
}

function persistActive(id: string | null): void {
  window.orcha.ui.saveState('activeId', id ?? '').catch(() => {})
}

interface OrchaStore {
  setup: { gh: boolean; claude: boolean } | null
  projects: Project[]
  workspaces: Workspace[]
  activeId: string | null // workspace id or 'orchestrator'
  openSessions: string[] // terminals kept mounted
  activity: Record<string, 'working' | 'waiting' | 'off'>
  gitStatus: Record<string, GitStatus>
  usage: Record<string, SessionUsage | null>
  // Real plan limits plus local attribution, polled at the App level so the
  // sidebar glance stays live regardless of which tab is focused.
  usageSummary: UsageSummary | null
  // When usageSummary was fetched — used instead of a live Date.now() call
  // in components, since React's purity rule bans impure calls in render.
  usageSummaryFetchedAt: number | null
  showUsageDashboard: boolean
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
  showSettings: boolean

  // Guest mode (running on a host's credits). null = not checked yet.
  guest: GuestStatus | null
  guestBalance: GuestBalance | null
  guestUsage: GuestUsage | null
  // When guestUsage was fetched, for pace maths without calling Date.now() in
  // render (React's purity rule).
  guestUsageAt: number | null
  showCredits: boolean
  tools: ToolsStatus | null
  notices: Notice[]

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
    effort?: string | null,
    agent?: Agent
  ) => Promise<void>
  mcSend: (text: string) => void
  mcInterrupt: () => void
  mcLoadHistory: () => Promise<void>
  setShowNewProject: (show: boolean) => void
  setShowNewSession: (projectId: string | null) => void
  setShowSettings: (show: boolean) => void
  setLinkModal: (modal: { kind: 'share' | 'phone'; workspaceId: string } | null) => void
  setUsage: (workspaceId: string, usage: SessionUsage | null) => void
  setShowUsageDashboard: (show: boolean) => void
  loadUsageSummary: (force?: boolean) => Promise<void>
  loadGuest: () => Promise<GuestStatus>
  loadGuestBalance: (force?: boolean) => Promise<void>
  loadGuestUsage: () => Promise<void>
  setShowCredits: (show: boolean) => void
  checkTools: () => Promise<ToolsStatus>
  pushNotice: (notice: Notice) => void
  dismissNotice: (id: string) => void
}

export const useStore = create<OrchaStore>((set) => ({
  setup: null,
  projects: [],
  workspaces: [],
  activeId: null,
  openSessions: [],
  activity: {},
  gitStatus: {},
  usage: {},
  usageSummary: null,
  usageSummaryFetchedAt: null,
  showUsageDashboard: false,
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
  showSettings: false,
  guest: null,
  guestBalance: null,
  guestUsage: null,
  guestUsageAt: null,
  showCredits: false,
  tools: null,
  notices: [],

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

  // Reopen the sessions that were live when the app last quit, and land on
  // the tab that was focused then — so the opening reveal uncovers the screen
  // you left, not an empty pane.
  restoreOpenSessions: async () => {
    const [rawOpen, rawActive] = await Promise.all([
      window.orcha.ui.getState('openSessions'),
      window.orcha.ui.getState('activeId')
    ])
    let ids: string[] = []
    if (rawOpen) {
      try {
        ids = JSON.parse(rawOpen)
      } catch {
        ids = []
      }
    }
    const valid = ids.filter((id) => useStore.getState().workspaces.some((w) => w.id === id))
    if (valid.length > 0) {
      set((s) => ({ openSessions: [...new Set([...s.openSessions, ...valid])] }))
    }
    // Only a tab that actually has a terminal restored (or Mission Control)
    // qualifies — a workspace outside openSessions would show a header over a
    // dead pane.
    if (rawActive && (rawActive === MC || useStore.getState().openSessions.includes(rawActive))) {
      set({ activeId: rawActive })
    }
  },

  setActive: (id) =>
    set((s) => {
      const openSessions =
        id && id !== MC && !s.openSessions.includes(id)
          ? [...s.openSessions, id]
          : s.openSessions
      if (openSessions !== s.openSessions) persistOpenSessions(openSessions)
      persistActive(id)
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

  createParallelSession: async (projectId, name, model = null, effort = null, agent = 'claude') => {
    const workspace = await window.orcha.workspaces.create(projectId, name, model, effort, agent)
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
  setShowSettings: (show) => set({ showSettings: show }),
  setLinkModal: (modal) => set({ linkModal: modal }),
  setUsage: (workspaceId, usage) => set((s) => ({ usage: { ...s.usage, [workspaceId]: usage } })),
  setShowUsageDashboard: (show) => set({ showUsageDashboard: show }),
  loadUsageSummary: async (force) => {
    const usageSummary = await window.orcha.usage.summary(force)
    set({ usageSummary, usageSummaryFetchedAt: Date.now() })
  },
  loadGuest: async () => {
    const guest = await window.orcha.guest.status()
    set({ guest })
    return guest
  },
  loadGuestBalance: async (force) => {
    const guestBalance = await window.orcha.guest.balance(force)
    set({ guestBalance })
  },
  loadGuestUsage: async () => {
    const guestUsage = await window.orcha.guest.usage()
    set({ guestUsage, guestUsageAt: Date.now() })
  },
  setShowCredits: (show) => set({ showCredits: show }),
  checkTools: async () => {
    const tools = await window.orcha.tools.status()
    set({ tools })
    return tools
  },
  pushNotice: (notice) =>
    set((s) => ({ notices: [...s.notices.filter((n) => n.id !== notice.id), notice] })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}))

// Whether this app is running on a host's credits.
export function useIsGuest(): boolean {
  return useStore((s) => s.guest?.paired ?? false)
}

export function useActiveWorkspace(): Workspace | undefined {
  const id = useStore((s) => s.activeId)
  const workspaces = useStore((s) => s.workspaces)
  return workspaces.find((w) => w.id === id)
}
