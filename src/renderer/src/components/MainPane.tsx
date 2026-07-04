import { useEffect, useState } from 'react'
import { useStore, useActiveWorkspace } from '../store'
import ChatView from './ChatView'
import TerminalView from './TerminalView'

function GitChip({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const status = useStore((s) => s.gitStatus[workspaceId])
  if (!status) return null
  return (
    <span className="flex items-center gap-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-zinc-400">
      {status.dirty ? (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Uncommitted changes" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-accent-dim" title="Clean" />
      )}
      {status.branch && <span className="font-mono">{status.branch}</span>}
      {status.ahead > 0 && <span>↑{status.ahead}</span>}
      {status.behind > 0 && <span>↓{status.behind}</span>}
    </span>
  )
}

function MainPane(): React.JSX.Element {
  const activeId = useStore((s) => s.activeId)
  const workspace = useActiveWorkspace()
  const openSessions = useStore((s) => s.openSessions)
  const archiveSession = useStore((s) => s.archiveSession)
  const gitStatus = useStore((s) => (workspace ? s.gitStatus[workspace.id] : undefined))
  const [gitBusy, setGitBusy] = useState(false)

  // Refresh the git chip when switching sessions and every 30s while focused.
  const workspaceId = workspace?.id
  useEffect(() => {
    if (!workspaceId) return
    const refresh = (): void => {
      window.orcha.git.status(workspaceId).catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [workspaceId])

  // Terminals for every open session stay mounted below regardless of which
  // view is showing, so restored sessions boot and keep running unattended.
  const terminalHost = (
    <>
      {openSessions.map((id) => (
        <div
          key={id}
          className="absolute inset-0"
          style={{ display: id === activeId ? 'block' : 'none' }}
        >
          <TerminalView workspaceId={id} visible={id === activeId} />
        </div>
      ))}
    </>
  )

  if (activeId === 'orchestrator' || !workspace) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        {activeId === 'orchestrator' ? (
          <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge px-4">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="font-medium text-zinc-100">Mission Control</span>
            <span className="font-mono text-[11px] text-zinc-600">commands every session</span>
          </header>
        ) : (
          <header className="h-11 shrink-0 border-b border-edge" />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {activeId === 'orchestrator' ? (
            <ChatView workspaceId="orchestrator" />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <div className="text-lg font-medium text-zinc-500">No session selected</div>
                <div className="mt-1 text-zinc-600">
                  Pick a session on the left, or create a project to start one
                </div>
              </div>
            </div>
          )}
          {terminalHost}
        </div>
      </main>
    )
  }

  const runGit = async (fn: () => Promise<unknown>): Promise<void> => {
    setGitBusy(true)
    try {
      await fn()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setGitBusy(false)
    }
  }

  const handleCommitPush = (): Promise<void> =>
    runGit(() => window.orcha.git.commitPush(workspace.id, `Update from ${workspace.name}`))

  const handleAskClaude = (): void => {
    window.orcha.session.send(
      workspace.id,
      'Commit the current changes with a good descriptive message and push to origin.'
    )
  }

  const handlePr = (): Promise<void> =>
    runGit(async () => {
      const { url } = await window.orcha.git.createPr(workspace.id)
      if (url) window.open(url)
    })

  const handleRestart = (): void => {
    if (confirm('Restart this Claude session? The conversation resumes automatically.')) {
      window.orcha.pty.restart(workspace.id, 120, 30)
    }
  }

  const handleClose = async (): Promise<void> => {
    const message =
      workspace.kind === 'main'
        ? `Close "${workspace.name}"? The repo stays on disk; reopen it anytime.`
        : `Close parallel session "${workspace.name}"? Its worktree folder is removed; the branch is kept.`
    if (!confirm(message)) return
    try {
      await archiveSession(workspace.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-4">
        <span className="font-medium text-zinc-100">{workspace.name}</span>
        <GitChip workspaceId={workspace.id} />
        {(gitStatus?.behind ?? 0) > 0 && (
          <button
            onClick={() => runGit(() => window.orcha.git.pull(workspace.id))}
            disabled={gitBusy}
            className="rounded-md border border-amber-700/60 px-2 py-0.5 text-[11px] text-amber-500 hover:bg-amber-950/40 disabled:opacity-40"
            title="Remote has new commits — git pull --ff-only"
          >
            Pull ↓{gitStatus?.behind}
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCommitPush}
          disabled={gitBusy}
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-surface-2 hover:text-zinc-200 disabled:opacity-40"
        >
          Commit + Push
        </button>
        <button
          onClick={handleAskClaude}
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-surface-2 hover:text-zinc-200"
          title="Types a commit-and-push instruction into this session"
        >
          Ask Claude
        </button>
        {workspace.kind === 'worktree' && (
          <button
            onClick={handlePr}
            disabled={gitBusy}
            className="rounded-md px-2 py-1 text-zinc-400 hover:bg-surface-2 hover:text-zinc-200 disabled:opacity-40"
            title="Push this branch and open a pull request"
          >
            PR
          </button>
        )}
        <button
          onClick={() => window.orcha.git.openGithub(workspace.id).catch(() => {})}
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-surface-2 hover:text-zinc-200"
          title="Open this repo on GitHub"
        >
          GitHub
        </button>
        <button
          onClick={handleRestart}
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
          title="Restart the Claude session (resumes conversation, applies model/effort)"
        >
          Restart
        </button>
        <button
          onClick={handleClose}
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
        >
          Close
        </button>
      </header>

      <div className="relative min-h-0 flex-1">{terminalHost}</div>
    </main>
  )
}

export default MainPane
