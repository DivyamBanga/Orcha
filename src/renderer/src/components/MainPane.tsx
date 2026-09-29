import { useEffect, useState } from 'react'
import { useStore, useActiveWorkspace, useIsGuest } from '../store'
import { useAnimatedNumber } from '../motion'
import { modelName, poolFor, poolState, sessionCost, usd } from '../money'
import ChatView from './ChatView'
import TerminalView from './TerminalView'
import SessionPopover from './SessionPopover'
import { ArrowDown, ArrowUp, ChevronDown, Diamond } from './Icon'
import type { Workspace } from '../../../shared/types'

function GitChip({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const status = useStore((s) => s.gitStatus[workspaceId])
  if (!status) return null
  return (
    <span className="fade-late tnum flex h-6 items-center gap-1.5 rounded-md border border-edge px-2 text-[11.5px] text-zinc-400">
      {/* Clean vs dirty is carried by shape, not colour — a working tree is a
          git fact, and colour in this app is reserved for session state. */}
      {status.dirty ? (
        <span className="text-zinc-400" title="Uncommitted changes">
          <Diamond size={9} />
        </span>
      ) : (
        <span className="h-[7px] w-[7px] rounded-full border border-zinc-600" title="Clean" />
      )}
      {status.branch && <span className="font-mono text-[11px]">{status.branch}</span>}
      {status.ahead > 0 && (
        <span className="flex items-center gap-0.5">
          <ArrowUp size={10} />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="flex items-center gap-0.5">
          <ArrowDown size={10} />
          {status.behind}
        </span>
      )}
    </span>
  )
}

// What this tab runs, for a guest: "Claude · Sonnet 5" / "Codex · GPT-6 Sol".
function agentLabel(workspace: Workspace): string {
  if (workspace.agent === 'codex') return `Codex · ${modelName(workspace.model ?? 'gpt-6-sol')}`
  const model = workspace.model ?? 'sonnet'
  return `Claude · ${model[0].toUpperCase()}${model.slice(1)}`
}

// A guest tab's running cost, ticking up as the relay records each reply.
function TabCost({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const cost = useStore((s) => sessionCost(s.guestBalance, workspaceId))
  const shown = useAnimatedNumber(cost ?? 0)
  if (cost === null) return null
  return (
    <span
      className="tnum fade-late font-mono text-[11.5px] text-zinc-400"
      title="What this tab has cost so far"
    >
      {usd(shown)}
    </span>
  )
}

// Shown across the top of a guest tab whose budget has run out: why nothing
// will run, and the quickest way to keep going.
function BudgetBanner({ workspace }: { workspace: Workspace }): React.JSX.Element | null {
  const balance = useStore((s) => s.guestBalance)
  const pool = poolFor(workspace.agent, workspace.model)
  const state = poolState(balance, pool)
  if (!balance || !state || state.spent < state.cap) return null
  const open = (p: 'claude' | 'sol' | 'astra'): boolean => {
    const b = poolState(balance, p)
    return b !== null && b.spent < b.cap
  }
  const alternative =
    pool === 'astra' && open('sol')
      ? { label: 'Switch this tab to Sol', agent: 'codex' as const, model: 'gpt-6-sol' }
      : pool === 'sol' && open('astra')
        ? { label: 'Switch this tab to Astra', agent: 'codex' as const, model: 'gpt-6-astra' }
        : pool === 'claude' && open('sol')
          ? { label: 'Switch this tab to Codex', agent: 'codex' as const, model: 'gpt-6-sol' }
          : pool !== 'claude' && open('claude')
            ? { label: 'Switch this tab to Claude', agent: 'claude' as const, model: null }
            : null
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-red-400/15 bg-red-400/[0.05] px-4 text-[12.5px]">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      <span className="text-zinc-300">
        Your {state.label} budget is used up. Ask {balance.hostName} to top it up
        {alternative ? ', or keep going on another model.' : '.'}
      </span>
      {alternative && (
        <button
          onClick={() => {
            window.orcha.session
              .setAgent(workspace.id, alternative.agent, alternative.model)
              .then(() => useStore.getState().load())
              .catch(() => {})
          }}
          className="btn btn-secondary btn-sm ml-auto"
        >
          {alternative.label}
        </button>
      )}
    </div>
  )
}

function MainPane(): React.JSX.Element {
  const activeId = useStore((s) => s.activeId)
  const workspace = useActiveWorkspace()
  const project = useStore((s) =>
    workspace ? s.projects.find((p) => p.id === workspace.projectId) : undefined
  )
  const openSessions = useStore((s) => s.openSessions)
  const archiveSession = useStore((s) => s.archiveSession)
  const gitStatus = useStore((s) => (workspace ? s.gitStatus[workspace.id] : undefined))
  const setLinkModal = useStore((s) => s.setLinkModal)
  const sharing = useStore((s) => (workspace ? Boolean(s.shareStatus[workspace.id]?.url) : false))
  const setUsage = useStore((s) => s.setUsage)
  const isGuest = useIsGuest()
  const [gitBusy, setGitBusy] = useState(false)
  const [showSession, setShowSession] = useState(false)
  const workspaceId = workspace?.id

  // Close the popover when switching tabs so it doesn't linger open showing
  // stale data for the newly active session — adjusted during render (React's
  // recommended pattern for resetting state on prop change) rather than in an
  // effect, since setState-in-effect would cause an extra render every time.
  const [lastWorkspaceId, setLastWorkspaceId] = useState(workspaceId)
  if (workspaceId !== lastWorkspaceId) {
    setLastWorkspaceId(workspaceId)
    setShowSession(false)
  }

  // Refresh the git chip and token usage when switching sessions and every
  // 30s while focused. Skipped for remote (SSH) workspaces — no local repo
  // or transcript to read either way.
  useEffect(() => {
    if (!workspaceId || project?.sshHost) return
    const refresh = (): void => {
      window.orcha.git.status(workspaceId).catch(() => {})
      window.orcha.session
        .usage(workspaceId)
        .then((u) => setUsage(workspaceId, u))
        .catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [workspaceId, project?.sshHost, setUsage])

  // Terminals for every open session stay mounted below regardless of which
  // view is showing, so restored sessions boot and keep running unattended.
  // The veil above them (re-keyed per tab) is what fades on a switch — the
  // terminals themselves never animate.
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
      <div key={activeId ?? 'none'} className="switch-veil" />
    </>
  )

  if (activeId === 'orchestrator' || !workspace) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        {activeId === 'orchestrator' ? (
          <header className="flex h-12 shrink-0 items-center border-b border-edge px-4">
            {/* Contents in a boot-item wrapper so the rise moves the words,
                not the bar or its border. */}
            <div className="boot-item boot-d1 flex items-center gap-3">
              <span className="font-medium text-zinc-50">Mission Control</span>
              <span className="text-[12px] text-zinc-500">commands every session</span>
            </div>
          </header>
        ) : (
          <header className="h-12 shrink-0 border-b border-edge" />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {activeId === 'orchestrator' ? (
            <ChatView workspaceId="orchestrator" />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="boot-item text-center">
                <div className="text-[15px] font-medium text-zinc-400">No session selected</div>
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

  const agentName = workspace.agent === 'codex' ? 'Codex' : 'Claude'

  const handleCommitPush = (): Promise<void> =>
    runGit(() => window.orcha.git.commitPush(workspace.id, `Update from ${workspace.name}`))

  const handleAskAgent = (): void => {
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
    if (confirm(`Restart this ${agentName} session? The conversation resumes automatically.`)) {
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
      <header className="relative flex h-12 shrink-0 items-center border-b border-edge px-4">
        {/* Contents in a boot-item wrapper so the rise moves the controls
            while the bar and its border stay put; the popover anchors to the
            header itself, outside the animated wrapper. */}
        <div className="boot-item boot-d1 flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium text-zinc-50">{workspace.name}</span>
          {isGuest && (
            <span className="shrink-0 whitespace-nowrap text-[12px] text-zinc-500">
              {agentLabel(workspace)}
            </span>
          )}
          {isGuest && <TabCost workspaceId={workspace.id} />}
          {!project?.sshHost && (
            <>
              <GitChip workspaceId={workspace.id} />
              {(gitStatus?.behind ?? 0) > 0 && (
                <button
                  onClick={() => runGit(() => window.orcha.git.pull(workspace.id))}
                  disabled={gitBusy}
                  className="btn btn-secondary btn-sm"
                  title="Remote has new commits — git pull --ff-only"
                >
                  Pull
                  <ArrowDown size={10} />
                  {gitStatus?.behind}
                </button>
              )}
            </>
          )}
          <div className="flex-1" />
          {!project?.sshHost && (
            <>
              <button
                onClick={handleCommitPush}
                disabled={gitBusy}
                className="btn btn-ghost btn-sm"
              >
                Commit + Push
              </button>
              <button
                onClick={handleAskAgent}
                className="btn btn-ghost btn-sm"
                title="Types a commit-and-push instruction into this session"
              >
                Ask {agentName}
              </button>
              {workspace.kind === 'worktree' && (
                <button
                  onClick={handlePr}
                  disabled={gitBusy}
                  className="btn btn-ghost btn-sm"
                  title="Push this branch and open a pull request"
                >
                  PR
                </button>
              )}
              <button
                onClick={() => window.orcha.git.openGithub(workspace.id).catch(() => {})}
                className="btn btn-ghost btn-sm"
                title="Open this repo on GitHub"
              >
                GitHub
              </button>
              <span className="mx-1 h-4 w-px bg-edge" />
            </>
          )}
          <button
            onClick={() => setLinkModal({ kind: 'share', workspaceId: workspace.id })}
            data-active={sharing}
            className="btn btn-ghost btn-sm"
            title="Share a live read-only view of this terminal — any browser, no install"
          >
            {/* Broadcasting is signalled by the pressed state and the label
                itself rather than colour, which stays reserved for sessions. */}
            {sharing && <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />}
            {sharing ? 'Sharing' : 'Share'}
          </button>
          {!isGuest && (
            <button
              onClick={() => setLinkModal({ kind: 'phone', workspaceId: workspace.id })}
              className="btn btn-ghost btn-sm"
              title="Continue this session from your phone (Claude Code Remote Control)"
            >
              Phone
            </button>
          )}
          <span className="mx-1 h-4 w-px bg-edge" />
          {!project?.sshHost && (
            <button
              onClick={() => setShowSession((v) => !v)}
              data-active={showSession}
              className="btn btn-ghost btn-sm"
              title={isGuest ? 'Agent, model and cost for this tab' : 'Session usage and auth mode'}
            >
              Session
              <ChevronDown size={11} />
            </button>
          )}
          <button
            onClick={handleRestart}
            className="btn btn-ghost btn-sm text-zinc-500"
            title={`Restart the ${agentName} session (resumes the conversation, applies model changes)`}
          >
            Restart
          </button>
          <button onClick={handleClose} className="btn btn-ghost btn-sm text-zinc-500">
            Close
          </button>
        </div>
        {showSession && (
          <SessionPopover workspace={workspace} onClose={() => setShowSession(false)} />
        )}
      </header>

      {isGuest && <BudgetBanner workspace={workspace} />}
      <div className="relative min-h-0 flex-1">{terminalHost}</div>
    </main>
  )
}

export default MainPane
