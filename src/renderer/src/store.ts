import { create } from 'zustand'
import type { Project, Workspace, SessionStatus, GitStatus } from '../../shared/types'

interface OrchaStore {
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null // workspace id or 'orchestrator'
  sessionStatus: Record<string, SessionStatus>
  gitStatus: Record<string, GitStatus>

  loadProjects: () => Promise<void>
  addProject: () => Promise<void>
  setActiveWorkspace: (id: string | null) => void
}

export const useStore = create<OrchaStore>((set) => ({
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  sessionStatus: {},
  gitStatus: {},

  loadProjects: async () => {
    const projects = await window.orcha.projects.list()
    set({ projects })
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

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id })
}))
