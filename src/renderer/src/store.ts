import { create } from 'zustand'
import type { Project, Workspace, SessionStatus, GitStatus } from '../../shared/types'

interface OrchaStore {
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null // workspace id or 'orchestrator'
  sessionStatus: Record<string, SessionStatus>
  gitStatus: Record<string, GitStatus>
  showNewWorkspace: boolean

  load: () => Promise<void>
  addProject: () => Promise<void>
  createWorkspace: (projectId: string, name: string) => Promise<void>
  archiveWorkspace: (workspaceId: string) => Promise<void>
  setActiveWorkspace: (id: string | null) => void
  setShowNewWorkspace: (show: boolean) => void
}

export const useStore = create<OrchaStore>((set) => ({
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  sessionStatus: {},
  gitStatus: {},
  showNewWorkspace: false,

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
      activeWorkspaceId: s.activeWorkspaceId === workspaceId ? null : s.activeWorkspaceId
    }))
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setShowNewWorkspace: (show) => set({ showNewWorkspace: show })
}))

export function useActiveWorkspace(): Workspace | undefined {
  const id = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  return workspaces.find((w) => w.id === id)
}
