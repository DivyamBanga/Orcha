import { useEffect } from 'react'
import { useStore } from '../store'
import type { Workspace } from '../../../shared/types'

function WorkspaceRow({ workspace, index }: { workspace: Workspace; index: number }): React.JSX.Element {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const busy = useStore((s) => s.sessionStatus[workspace.id]) === 'busy'
  const unread = useStore((s) => s.unread[workspace.id]) ?? false
  const git = useStore((s) => s.gitStatus[workspace.id])
  const active = activeWorkspaceId === workspace.id

  return (
    <button
      onClick={() => setActiveWorkspace(workspace.id)}
      className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors duration-100 ${
        active ? 'bg-surface-2 text-zinc-100' : 'text-zinc-400 hover:bg-surface-1 hover:text-zinc-200'
      }`}
    >
      <span className="flex w-3 shrink-0 items-center justify-center">
        {busy ? (
          <span className="busy-ring" />
        ) : unread ? (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        ) : (
          <span className="h-1 w-1 rounded-full bg-zinc-700" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      {git?.dirty && (
        <span className="font-mono text-[10px] text-amber-500/80" title="Uncommitted changes">
          M
        </span>
      )}
      {index < 9 && (
        <kbd className="hidden font-mono text-[10px] text-zinc-600 group-hover:inline">
          ^{index + 1}
        </kbd>
      )}
    </button>
  )
}

function Sidebar(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sessionStatus = useStore((s) => s.sessionStatus)
  const orchestratorBusy = useStore((s) => s.sessionStatus['orchestrator']) === 'busy'
  const load = useStore((s) => s.load)
  const addProject = useStore((s) => s.addProject)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setShowNewWorkspace = useStore((s) => s.setShowNewWorkspace)

  useEffect(() => {
    load()
  }, [load])

  const runningCount = workspaces.filter((w) => sessionStatus[w.id] === 'busy').length

  const handleAddProject = async (): Promise<void> => {
    try {
      await addProject()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex h-11 items-center gap-2 border-b border-edge px-4">
        <span className="font-mono text-sm font-semibold tracking-tight text-zinc-100">
          orcha
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
            {runningCount} running
          </span>
        )}
      </div>

      {/* Mission Control — pinned */}
      <button
        onClick={() => setActiveWorkspace('orchestrator')}
        className={`mx-2 mt-2 flex items-center gap-2 rounded border px-3 py-2 text-left transition-colors duration-100 ${
          activeWorkspaceId === 'orchestrator'
            ? 'border-accent-dim bg-surface-2 text-zinc-100'
            : 'border-edge bg-surface-1 text-zinc-300 hover:border-edge-bright hover:bg-surface-2'
        }`}
      >
        {orchestratorBusy ? (
          <span className="busy-ring" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-accent" />
        )}
        <span className="font-medium">Mission Control</span>
        <kbd className="ml-auto font-mono text-[10px] text-zinc-600">^0</kbd>
      </button>

      <div className="console-bg mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <div className="px-2 py-8 text-center leading-relaxed text-zinc-600">
            No projects yet.
            <br />
            Add a git repo to get started.
          </div>
        ) : (
          projects.map((project) => {
            const projectWorkspaces = workspaces.filter((w) => w.projectId === project.id)
            return (
              <div key={project.id} className="mb-3">
                <div className="px-2 pb-1 pt-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-600">
                  {project.name}
                </div>
                {projectWorkspaces.length === 0 ? (
                  <div className="px-2 py-1 text-zinc-600">No workspaces</div>
                ) : (
                  projectWorkspaces.map((ws) => (
                    <WorkspaceRow
                      key={ws.id}
                      workspace={ws}
                      index={workspaces.findIndex((w) => w.id === ws.id)}
                    />
                  ))
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-edge p-2">
        <button
          onClick={handleAddProject}
          className="w-full rounded px-3 py-1.5 text-left text-zinc-500 transition-colors duration-100 hover:bg-surface-2 hover:text-zinc-200"
        >
          + Add project
        </button>
        <button
          onClick={() => setShowNewWorkspace(true)}
          disabled={projects.length === 0}
          className="w-full rounded px-3 py-1.5 text-left text-zinc-500 transition-colors duration-100 hover:bg-surface-2 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + New workspace
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
