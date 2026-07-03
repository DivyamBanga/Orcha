import { useStore, useActiveWorkspace } from '../store'
import ChatView from './ChatView'
import TerminalView from './TerminalView'

function MainPane(): React.JSX.Element {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspace = useActiveWorkspace()
  const archiveWorkspace = useStore((s) => s.archiveWorkspace)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const openTerminals = useStore((s) => s.openTerminals)

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

  const showTerminal = activeTab === 'terminal'

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <span className="font-medium text-zinc-100">{workspace.name}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
          {workspace.branch}
        </span>
        <div className="ml-2 flex rounded-md border border-zinc-800">
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-2.5 py-1 ${!showTerminal ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Chat
          </button>
          <button
            onClick={() => setActiveTab('terminal')}
            className={`px-2.5 py-1 ${showTerminal ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Terminal
          </button>
        </div>
        <div className="flex-1" />
        <button
          onClick={handleArchive}
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Archive
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          className="flex h-full flex-col"
          style={{ display: showTerminal ? 'none' : 'flex' }}
        >
          <ChatView workspaceId={workspace.id} />
        </div>
        {openTerminals.map((id) => (
          <div key={id} className="absolute inset-0" style={{ display: showTerminal && id === workspace.id ? 'block' : 'none' }}>
            <TerminalView workspaceId={id} visible={showTerminal && id === workspace.id} />
          </div>
        ))}
      </div>
    </main>
  )
}

export default MainPane
