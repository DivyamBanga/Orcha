import { useState } from 'react'
import { useStore } from '../store'
import ContextMenu, { type MenuItem } from './ContextMenu'
import UsageGlance from './UsageGlance'
import { Branch, Diamond, Mark, More, Plus, SessionState, Settings } from './Icon'
import type { Project, Workspace } from '../../../shared/types'

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
      {
        label: 'Connect phone',
        onClick: () => s.setLinkModal({ kind: 'phone', workspaceId: workspace.id })
      },
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
      className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition-opacity duration-100 hover:bg-edge hover:text-zinc-200 group-hover:opacity-100"
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
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const open = useStore((s) => s.openSessions.includes(workspace.id))
  const activity = useStore((s) => s.activity[workspace.id]) ?? 'off'
  const git = useStore((s) => s.gitStatus[workspace.id])
  const active = activeId === workspace.id
  const isParallel = workspace.kind === 'worktree'

  return (
    <div
      onContextMenu={(e) => onMenu(e, workspace)}
      className={`group flex w-full items-center gap-1 rounded px-1.5 py-1.5 transition-colors duration-100 ${
        active
          ? 'bg-surface-3 text-zinc-100'
          : 'text-zinc-400 hover:bg-surface-2 hover:text-zinc-200'
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
          <kbd className="font-mono text-[10px] text-zinc-600 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
            ^{index + 1}
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
  const { menu, closeMenu, openSessionMenu, openProjectMenu } = useSessionMenu()

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-surface-1">
      {/* One line, five items, 240px to play with — everything is shrink-0 and
          nowrap so nothing collapses into a second row when the counts grow.
          Contents sit in a boot-item wrapper (not the bar itself) so the rise
          moves the text while the bar and its border stay put. */}
      <div className="flex h-11 items-center border-b border-edge px-3">
        <div className="boot-item boot-d2 flex min-w-0 flex-1 items-center gap-1.5">
          <Mark size={13} className="shrink-0 text-zinc-100" />
          <span className="shrink-0 font-mono text-sm font-semibold tracking-tight text-zinc-100">
            orcha
          </span>
          {openCount > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] text-zinc-400"
              title={`${openCount} session${openCount === 1 ? '' : 's'} running`}
            >
              <span className="state-ring shrink-0" />
              {openCount}
            </span>
          )}
          <div className="flex-1" />
          <UsageGlance />
          <button
            onClick={() => setShowSettings(true)}
            className="shrink-0 rounded p-1 text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Mission Control — pinned */}
      <button
        onClick={() => setActive('orchestrator')}
        className={`boot-item boot-d3 mx-2 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors duration-100 ${
          activeId === 'orchestrator'
            ? 'border-edge-bright bg-surface-3 text-zinc-100'
            : 'border-edge bg-surface-1 text-zinc-300 hover:border-edge-bright hover:bg-surface-2'
        }`}
      >
        {orchestratorBusy ? (
          <span className="busy-ring" />
        ) : mcUnread ? (
          // Unread is Claude waiting on you, so it borrows the same amber a
          // session uses for exactly that.
          <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-wait bg-wait/25" />
        ) : (
          <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-zinc-600" />
        )}
        <span className="font-medium">Mission Control</span>
        <kbd className="ml-auto font-mono text-[10px] text-zinc-600">^0</kbd>
      </button>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <div className="boot-item boot-d4 px-2 py-8 text-center leading-relaxed text-zinc-600">
            No projects yet.
            <br />
            Create or open one below.
          </div>
        ) : (
          projects.map((project, i) => {
            const sessions = workspaces.filter((w) => w.projectId === project.id)
            const mainSession = sessions.find((w) => w.kind === 'main')
            // Cards follow the wipe top-to-bottom; beyond the third the step
            // stops growing so a long list doesn't drag the cascade out.
            const cascade = ['boot-d4', 'boot-d5', 'boot-d6'][i] ?? 'boot-d7'
            return (
              <div
                key={project.id}
                className={`${cascade} boot-item mb-2 overflow-hidden rounded-md border border-edge`}
              >
                <div
                  onContextMenu={(e) => openProjectMenu(e, project)}
                  className="group flex items-center gap-1 border-b border-edge bg-white/[0.014] px-2.5 py-2"
                >
                  <button
                    onClick={() => mainSession && setActive(mainSession.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[12px] font-semibold tracking-tight text-zinc-200 hover:text-white"
                    title="Open the main session"
                  >
                    <span className="truncate">{project.name}</span>
                    {project.sshHost && (
                      <span
                        className="shrink-0 rounded bg-surface-2 px-1 font-mono text-[9px] font-normal text-zinc-500"
                        title={`Remote: ${project.sshUser}@${project.sshHost}`}
                      >
                        ssh
                      </span>
                    )}
                  </button>
                  <DotsButton onClick={(e) => openProjectMenu(e, project)} />
                </div>
                <div className="p-1">
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
        <button
          onClick={() => setShowNewProject(true)}
          className="boot-item boot-d7 flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-zinc-500 transition-colors duration-100 hover:bg-surface-2 hover:text-zinc-200"
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
