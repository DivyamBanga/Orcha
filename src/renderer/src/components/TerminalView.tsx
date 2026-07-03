import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IPC } from '../../../shared/ipc'
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

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#09090b] p-2"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}

export default TerminalView
