import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IPC } from '../../../shared/ipc'
import ContextMenu, { type MenuItem } from './ContextMenu'
import PasteHistory from './PasteHistory'
import type { PasteTarget } from '../../../shared/types'
import '@xterm/xterm/css/xterm.css'

// One live terminal per session (the Claude TUI runs inside it). Stays
// mounted (hidden) across switches so the session keeps running.
function TerminalView({
  workspaceId,
  visible
}: {
  workspaceId: string
  visible: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  // Text goes in as a real bracketed paste, so the TUI takes it as one chunk
  // (one [Pasted text] chip) instead of running every newline as a submit.
  // Images and files arrive as a path to reference with @ — far quicker and
  // more reliable than pushing bytes through the terminal, and it is the only
  // thing that works at all for a session running on a remote host.
  const insert = useCallback((target: PasteTarget): void => {
    const term = termRef.current
    if (!term || target.kind === 'empty') return
    term.paste(target.kind === 'text' ? target.text : `@${target.path} `)
  }, [])

  const pasteClipboard = useCallback((): void => {
    window.orcha.clipboard
      .paste(workspaceId)
      .then(insert)
      .catch(() => {})
  }, [workspaceId, insert])

  const copySelection = useCallback((): void => {
    const term = termRef.current
    const selection = term?.getSelection()
    if (!term || !selection) return
    window.orcha.clipboard.copy(selection).catch(() => {})
    // Dropped so a second Ctrl+C still reaches Claude as an interrupt.
    term.clearSelection()
  }, [])

  const closeHistory = useCallback((): void => {
    setHistoryOpen(false)
    termRef.current?.focus()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: {
        background: '#0a0a0c',
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
    termRef.current = term

    // xterm treats Ctrl+<letter> generically: Ctrl+V would send a bare ^V
    // (which Claude Code ignores on Windows — it leaves Ctrl+V to the
    // terminal) and cancel the browser's own paste, and Ctrl+C would always
    // interrupt even with text selected. Claim both keys here instead.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true
      const key = event.key.toLowerCase()
      if (key === 'v') {
        event.preventDefault()
        if (event.shiftKey) setHistoryOpen(true)
        else pasteClipboard()
        return false
      }
      if (key === 'c' && (event.shiftKey || term.hasSelection())) {
        event.preventDefault()
        copySelection()
        return false
      }
      return true
    })

    window.orcha.pty.create(workspaceId, term.cols, term.rows)
    const dataDisposable = term.onData((data) => window.orcha.pty.input(workspaceId, data))
    const unsubData = window.orcha.on(IPC.EvPtyData, (payload) => {
      const p = payload as { workspaceId: string; data: string }
      if (p.workspaceId === workspaceId) term.write(p.data)
    })
    const unsubExit = window.orcha.on(IPC.EvPtyExit, (payload) => {
      const p = payload as { workspaceId: string }
      if (p.workspaceId === workspaceId) term.write('\r\n[session ended]\r\n')
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
      termRef.current = null
    }
  }, [workspaceId, pasteClipboard, copySelection])

  // Refit when shown (size was 0 while hidden).
  useEffect(() => {
    if (visible) fitRef.current?.fit()
  }, [visible])

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDropActive(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    Promise.all(
      files.map((file) =>
        window.orcha.clipboard.pathFor(workspaceId, window.orcha.clipboard.pathForFile(file))
      )
    )
      .then((paths) => termRef.current?.paste(paths.map((p) => `@${p}`).join(' ') + ' '))
      .catch(() => {})
  }

  const menuItems: MenuItem[] = menu
    ? [
        ...(menu.hasSelection ? [{ label: 'Copy', onClick: copySelection }] : []),
        { label: 'Paste', onClick: pasteClipboard },
        { label: 'Paste from history…', onClick: () => setHistoryOpen(true) },
        {
          label: 'Select all',
          separatorAbove: true,
          onClick: () => termRef.current?.selectAll()
        }
      ]
    : []

  return (
    <div
      className={`relative h-full w-full bg-surface-0 p-2 ${
        dropActive ? 'ring-1 ring-inset ring-edge-bright' : ''
      }`}
      style={{ display: visible ? 'block' : 'none' }}
      onContextMenu={(event) => {
        // Cancels Electron's editing menu for xterm's hidden textarea, so the
        // terminal gets terminal actions instead of Cut/Paste on nothing.
        event.preventDefault()
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: termRef.current?.hasSelection() ?? false
        })
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropActive(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false)
      }}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="h-full w-full" />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {historyOpen && (
        <PasteHistory
          onPick={(id) => {
            closeHistory()
            window.orcha.clipboard
              .use(workspaceId, id)
              .then(insert)
              .catch(() => {})
          }}
          onClose={closeHistory}
        />
      )}
    </div>
  )
}

export default TerminalView
