import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IPC } from '../../../shared/ipc'
import { useStore } from '../store'
import '@xterm/xterm/css/xterm.css'

// One live terminal per workspace. Stays mounted (hidden) across tab and
// workspace switches so shells and dev servers keep running.
function TerminalView({
  workspaceId,
  visible
}: {
  workspaceId: string
  visible: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: {
        background: '#09090b',
        foreground: '#d4d4d8',
        cursor: '#d4d4d8',
        selectionBackground: '#3f3f46'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    fitRef.current = fit

    window.orcha.pty.create(workspaceId, term.cols, term.rows)
    const dataDisposable = term.onData((data) => window.orcha.pty.input(workspaceId, data))
    const unsubData = window.orcha.on(IPC.EvPtyData, (payload) => {
      const p = payload as { workspaceId: string; data: string }
      if (p.workspaceId === workspaceId) term.write(p.data)
    })
    const unsubExit = window.orcha.on(IPC.EvPtyExit, (payload) => {
      const p = payload as { workspaceId: string }
      if (p.workspaceId === workspaceId) term.write('\r\n[process exited]\r\n')
    })

    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth > 0) {
        fit.fit()
        window.orcha.pty.resize(workspaceId, term.cols, term.rows)
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      unsubData()
      unsubExit()
      term.dispose()
    }
  }, [workspaceId])

  // Refit when shown (size was 0 while hidden).
  useEffect(() => {
    if (visible) fitRef.current?.fit()
  }, [visible])

  const sessionId = useStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sessionId ?? null
  )

  // Drops into the real Claude Code TUI, resuming this workspace's session —
  // full native slash commands, model picker, everything.
  const launchClaudeCli = (): void => {
    const cmd = sessionId ? `claude --resume ${sessionId}\r` : 'claude\r'
    window.orcha.pty.input(workspaceId, cmd)
  }

  return (
    <div className="relative h-full w-full" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} className="h-full w-full bg-[#09090b] p-2" />
      <button
        onClick={launchClaudeCli}
        title="Launch the native Claude Code CLI here, resuming this workspace's session"
        className="absolute right-3 top-2 rounded border border-edge bg-surface-1 px-2 py-0.5 font-mono text-[11px] text-zinc-500 transition-colors duration-100 hover:border-accent-dim hover:text-accent"
      >
        open claude cli
      </button>
    </div>
  )
}

export default TerminalView
