import { useLayoutEffect, useRef, useState } from 'react'
import { useStore, useIsGuest } from '../store'
import { codexModel as codexModelOf } from '../money'
import ContextMenu, { type MenuItem } from './ContextMenu'
import UsageGlance from './UsageGlance'
import CreditsPanel from './CreditsPanel'
import { Branch, Diamond, Mark, More, Plus, SessionState, Settings } from './Icon'
import type { Project, Workspace } from '../../../shared/types'

// The session-jump shortcut's modifier, as each platform writes it.
const MOD = window.orcha.platform === 'darwin' ? '⌘' : '^'

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

function useSessionMenu(): {
  menu: MenuState | null
  closeMenu: () => void
  openSessionMenu: (e: React.MouseEvent, workspace: Workspace) => void
  openProjectMenu: (e: React.MouseEvent, project: Project) => void
} {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const openSessionMenu = (e: React.MouseEvent, workspace: Workspace): void => {
    e.preventDefault()
    e.stopPropagation()
    const s = useStore.getState()
    const project = s.projects.find((p) => p.id === workspace.projectId)
    const isRemote = Boolean(project?.sshHost)
    // Remote Control needs a claude.ai login, which a guest's sessions don't use.
    const guest = s.guest?.paired ?? false
    const items: MenuItem[] = [
      {
        label: 'Restart session',
        onClick: () => window.orcha.pty.restart(workspace.id, 120, 30)
      },
      ...(isRemote
        ? []
        : [
            {
              label: 'Open folder',
              onClick: () => window.orcha.shell.openPath(workspace.worktreePath)
            },
            {
              label: 'Open on GitHub',
              onClick: () => window.orcha.git.openGithub(workspace.id).catch(() => {})
            }
          ]),
      {
        label: 'Share live view',
        onClick: () => s.setLinkModal({ kind: 'share', workspaceId: workspace.id })
      },
      ...(guest
        ? []
        : [
            {
              label: 'Connect phone',
              onClick: () => s.setLinkModal({ kind: 'phone', workspaceId: workspace.id })
            }
          ]),
      {
        label: 'Copy path',
        onClick: () => navigator.clipboard.writeText(workspace.worktreePath)
      },
      {
        label: workspace.kind === 'main' ? 'Close session' : 'Close (remove worktree)',
        danger: true,
        separatorAbove: true,
        onClick: () => {
          const message =
            workspace.kind === 'main'
              ? `Close "${workspace.name}"? The repo stays on disk; reopen it anytime.`
              : `Close "${workspace.name}"? Its worktree folder is removed; the branch is kept.`
          if (confirm(message)) {
            s.archiveSession(workspace.id).catch((err) => alert(String(err)))
          }
        }
      }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const openProjectMenu = (e: React.MouseEvent, project: Project): void => {
    e.preventDefault()
    e.stopPropagation()
    const s = useStore.getState()
    const items: MenuItem[] = [
      ...(project.sshHost
        ? []
        : [
            {
              label: 'New parallel session',
              onClick: () => s.setShowNewSession(project.id)
            },
            {
              label: 'Open folder',
              onClick: () => window.orcha.shell.openPath(project.repoPath)
            }
          ]),
      {
        label: 'Copy path',
        onClick: () => navigator.clipboard.writeText(project.remotePath ?? project.repoPath)
      },
      {
        label: 'Remove from Orcha',
        danger: true,
        separatorAbove: true,
        onClick: () => {
          if (
            confirm(
              `Remove "${project.name}" from Orcha? All its sessions close (parallel worktrees are deleted); the repo folder itself stays on disk.`
            )
          ) {
            s.removeProject(project.id).catch((err) => alert(String(err)))
          }
        }
      }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  return { menu, closeMenu: () => setMenu(null), openSessionMenu, openProjectMenu }
}

// Space is always reserved (opacity, not display) so rows never reflow on hover.
function DotsButton({ onClick }: { onClick: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="btn btn-ghost btn-icon h-6 w-6 shrink-0 text-zinc-500 opacity-0 group-hover:opacity-100"
      title="Options"
    >
      <More size={14} />
    </button>
  )
}

function SessionRow({
  workspace,
  index,
  onMenu
}: {
  workspace: Workspace
  index: number
  onMenu: (e: React.MouseEvent, workspace: Workspace) => void
}): React.JSX.Element {
  const active = useStore((s) => s.activeId === workspace.id)
  const setActive = useStore((s) => s.setActive)
  const open = useStore((s) => s.openSessions.includes(workspace.id))
  const activity = useStore((s) => s.activity[workspace.id]) ?? 'off'
  const git = useStore((s) => s.gitStatus[workspace.id])
  const isParallel = workspace.kind === 'worktree'
  // Codex tabs say which model (and so which budget) they run on; Claude is
  // the default and goes unmarked.
  const codexModel = useStore((s) =>
    workspace.agent === 'codex' ? codexModelOf(workspace.model, s.catalog) : null
  )

  return (
    <div
      data-row={workspace.id}
      onContextMenu={(e) => onMenu(e, workspace)}
      className={`group relative flex h-8 w-full items-center gap-1 rounded-[7px] pl-2 pr-1 transition-colors duration-150 ${
        active ? 'text-zinc-50' : 'text-zinc-400 hover:bg-overlay/[0.035] hover:text-zinc-200'
      }`}
    >
      <button
        onClick={() => setActive(workspace.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="flex w-3 shrink-0 items-center justify-center">
          <SessionState state={activity} open={open} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {workspace.kind === 'main' ? 'main' : workspace.name}
        </span>
        {codexModel && (
          <span
            className="shrink-0 rounded-[4px] border border-edge px-1 font-mono text-[9.5px] leading-[14px] text-zinc-500"
            title={`Codex on ${codexModel.label}`}
          >
            {codexModel.pool}
          </span>
        )}
        {isParallel && (
          <span className="shrink-0 text-zinc-600" title={workspace.branch}>
            <Branch size={12} />
          </span>
        )}
        {git?.dirty && (
          <span className="shrink-0 text-zinc-500" title="Uncommitted changes">
            <Diamond size={9} />
          </span>
        )}
        {index < 9 && (
          <kbd className="font-mono text-[10px] text-zinc-600 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {MOD}
            {index + 1}
          </kbd>
        )}
      </button>
      <DotsButton onClick={(e) => onMenu(e, workspace)} />
    </div>
  )
}

function Sidebar(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeId)
  const orchestratorBusy = useStore((s) => s.sessionStatus['orchestrator']) === 'busy'
  const mcUnread = useStore((s) => s.unread['orchestrator']) ?? false
  const openCount = useStore((s) => s.openSessions.length)
  const setActive = useStore((s) => s.setActive)
  const setShowNewProject = useStore((s) => s.setShowNewProject)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const isGuest = useIsGuest()
  const { menu, closeMenu, openSessionMenu, openProjectMenu } = useSessionMenu()

  // The selection highlight is one element that glides to the active row.
  // It's positioned straight on the DOM (no React state, so no re-render per
  // move) and only transform/height/opacity change, which stay composited.
  const listRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const indicator = indicatorRef.current
    if (!list || !indicator) return
    const place = (): void => {
      const row = activeId
        ? list.querySelector<HTMLElement>(`[data-row="${CSS.escape(activeId)}"]`)
        : null
      if (!row) {
        indicator.style.opacity = '0'
        return
      }
      const top =
        row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      indicator.style.opacity = '1'
      indicator.style.transform = `translateY(${top}px)`
      indicator.style.height = `${row.offsetHeight}px`
    }
    // The very first placement snaps into position instead of sliding in
    // from the top of the list.
    if (!indicator.dataset.placed) {
      indicator.style.transition = 'none'
      place()
      void indicator.offsetHeight
      indicator.style.transition = ''
      indicator.dataset.placed = '1'
    } else {
      place()
    }
    const observer = new ResizeObserver(place)
    observer.observe(list)
    return () => observer.disconnect()
  }, [activeId, projects, workspaces])

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-edge bg-surface-1">
      {/* One line, five items, 248px to play with — everything is shrink-0 and
          nowrap so nothing collapses into a second row when the counts grow.
          Contents sit in a boot-item wrapper (not the bar itself) so the rise
          moves the text while the bar and its border stay put. */}
      <div className="titlebar titlebar-lead flex h-12 items-center px-3">
        <div className="boot-item boot-d2 flex min-w-0 flex-1 items-center gap-2">
          <Mark size={14} className="shrink-0 text-zinc-100" />
          <span className="shrink-0 font-mono text-[14px] font-semibold tracking-tight text-zinc-100">
            orcha
          </span>
          {openCount > 0 && (
            <span
              className="tnum flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge px-1.5 py-px font-mono text-[10.5px] text-zinc-400"
              title={`${openCount} session${openCount === 1 ? '' : 's'} running`}
            >
              <span className="state-ring shrink-0 scale-[0.8]" />
              {openCount}
            </span>
          )}
          <div className="flex-1" />
          {!isGuest && <UsageGlance />}
          <button
            onClick={() => setShowSettings(true)}
            className="btn btn-ghost btn-icon shrink-0 text-zinc-500"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Mission Control — pinned */}
      <div className="px-2">
        <button
          onClick={() => setActive('orchestrator')}
          className={`boot-item boot-d3 flex h-9 w-full items-center gap-2.5 rounded-lg border px-3 text-left transition-colors duration-150 ${
            activeId === 'orchestrator'
              ? 'border-edge-bright bg-surface-3 text-zinc-50'
              : 'border-edge bg-surface-0/40 text-zinc-300 hover:border-edge-bright hover:bg-surface-2'
          }`}
        >
          {orchestratorBusy ? (
            <span className="busy-ring" />
          ) : mcUnread ? (
            // Unread is the assistant waiting on you, so it borrows the same
            // amber a session uses for exactly that.
            <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-wait bg-wait/25" />
          ) : (
            <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-zinc-600" />
          )}
          <span className="font-medium">Mission Control</span>
          <kbd className="ml-auto font-mono text-[10px] text-zinc-600">{MOD}0</kbd>
        </button>
      </div>

      <div className="boot-item boot-d4 mt-4 mb-1 flex items-center justify-between px-4">
        <span className="eyebrow">Projects</span>
        <button
          onClick={() => setShowNewProject(true)}
          className="btn btn-ghost btn-icon h-5 w-5 text-zinc-500"
          title="New project"
        >
          <Plus size={13} />
        </button>
      </div>

      <div ref={listRef} className="relative flex-1 overflow-y-auto px-2 pb-2">
        <div ref={indicatorRef} className="nav-indicator" style={{ opacity: 0 }} />
        {projects.length === 0 ? (
          <div className="boot-item boot-d4 relative px-2 py-8 text-center leading-relaxed text-zinc-600">
            No projects yet.
            <br />
            Create or open one below.
          </div>
        ) : (
          projects.map((project, i) => {
            const sessions = workspaces.filter((w) => w.projectId === project.id)
            const mainSession = sessions.find((w) => w.kind === 'main')
            // Groups follow the wipe top-to-bottom; beyond the third the step
            // stops growing so a long list doesn't drag the cascade out.
            const cascade = ['boot-d4', 'boot-d5', 'boot-d6'][i] ?? 'boot-d7'
            return (
              <div key={project.id} className={`${cascade} boot-item mb-3`}>
                <div
                  onContextMenu={(e) => openProjectMenu(e, project)}
                  className="group relative flex h-7 items-center gap-1 pl-2 pr-1"
                >
                  <button
                    onClick={() => mainSession && setActive(mainSession.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[12px] font-semibold tracking-tight text-zinc-300 transition-colors duration-150 hover:text-zinc-50"
                    title="Open the main session"
                  >
                    <span className="truncate">{project.name}</span>
                    {project.sshHost && (
                      <span
                        className="shrink-0 rounded-[4px] border border-edge px-1 font-mono text-[9.5px] font-normal leading-[14px] text-zinc-500"
                        title={`Remote: ${project.sshUser}@${project.sshHost}`}
                      >
                        ssh
                      </span>
                    )}
                  </button>
                  <DotsButton onClick={(e) => openProjectMenu(e, project)} />
                </div>
                <div className="flex flex-col gap-px">
                  {sessions.map((ws) => (
                    <SessionRow
                      key={ws.id}
                      workspace={ws}
                      index={workspaces.findIndex((w) => w.id === ws.id)}
                      onMenu={openSessionMenu}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-edge p-2">
        {isGuest && <CreditsPanel />}
        <button
          onClick={() => setShowNewProject(true)}
          className="boot-item boot-d7 btn btn-ghost h-8 w-full justify-start gap-2 px-2.5 font-normal text-zinc-500"
        >
          <Plus size={14} />
          New project
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </aside>
  )
}

export default Sidebar
