import { useStore, useActiveWorkspace } from '../store'
import ChatView from './ChatView'

function MainPane(): React.JSX.Element {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspace = useActiveWorkspace()
  const archiveWorkspace = useStore((s) => s.archiveWorkspace)

  if (activeWorkspaceId === 'orchestrator') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="text-center text-zinc-600">Mission Control — coming soon</div>
      </main>
    )
  }

  if (!workspace) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="text-lg font-medium text-zinc-500">No workspace selected</div>
          <div className="mt-1 text-zinc-600">
            Add a project, then create a workspace to start a session
          </div>
        </div>
      </main>
    )
  }

  const handleArchive = async (): Promise<void> => {
    if (!confirm(`Archive "${workspace.name}"? The worktree folder is removed; the branch is kept.`))
      return
    try {
      await archiveWorkspace(workspace.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex h-11 items-center gap-3 border-b border-zinc-800 px-4">
        <span className="font-medium text-zinc-100">{workspace.name}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
          {workspace.branch}
        </span>
        <div className="flex-1" />
        <button
          onClick={handleArchive}
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Archive
        </button>
      </header>
      <ChatView workspaceId={workspace.id} />
    </main>
  )
}

export default MainPane
