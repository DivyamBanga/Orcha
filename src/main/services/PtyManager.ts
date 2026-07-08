import * as pty from 'node-pty'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import { hasSessionHistory } from '../claudeSessions'
import type { Workspace } from '../../shared/types'

type SendFn = (channel: string, payload: unknown) => void

const REPLAY_LIMIT = 100_000

interface PtyEntry {
  proc: pty.IPty
  buffer: string
  // Last time the Claude TUI's busy indicator appeared in the output stream.
  // ConPTY only retransmits the text when that screen line redraws, so this
  // marks the START of a turn, not its whole duration.
  lastBusyMarkerAt: number
  // Last time ANY output arrived. While a turn runs the TUI repaints its
  // elapsed counter about once a second, so output flowing = still working.
  lastOutputAt: number
  // Whether anything was ever typed/dispatched into this pty. Claude never
  // starts a turn on its own, so without input there is nothing to notify
  // about; this kills false "done" pings from startup spinner flashes.
  hadInput: boolean
  // Last time anything was typed/dispatched, so keystroke echo is not
  // mistaken for Claude starting to work.
  lastInputAt: number
  // Small rolling tail of recent (ANSI-stripped) output. The busy marker can
  // arrive split across two pty chunks; scanning a stitched tail instead of a
  // single chunk keeps us from missing spinner repaints and false-reporting idle.
  markerTail: string
}

// The TUI repaints this constantly while Claude is running a turn.
const BUSY_MARKER = /esc to interrupt/i
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

function claudeLaunchCommand(workspace: Workspace): string {
  const parts = ['claude', '--dangerously-skip-permissions']
  if (hasSessionHistory(workspace.worktreePath)) parts.push('--continue')
  if (workspace.model) parts.push('--model', workspace.model)
  if (workspace.effort) parts.push('--effort', workspace.effort)
  return parts.join(' ')
}

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  constructor(private send: SendFn) {}

  has(workspaceId: string): boolean {
    return this.ptys.has(workspaceId)
  }

  // Spawns the session shell (auto-running the Claude TUI) on first call; on
  // later calls replays recent output so a re-attached xterm isn't blank.
  create(workspaceId: string, cols: number, rows: number): void {
    const existing = this.ptys.get(workspaceId)
    if (existing) {
      if (existing.buffer) {
        this.send(IPC.EvPtyData, { workspaceId, data: existing.buffer })
      }
      return
    }

    // 'setup' is the onboarding terminal: plain shell in the home folder for
    // running `gh auth login` / `claude` login flows.
    const workspace = workspaceId === 'setup' ? null : db.workspaces.get(workspaceId)
    if (workspaceId !== 'setup' && !workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`)
    }

    // -NoExit: when Claude exits (/exit, crash), you land in a shell in the
    // same folder instead of a dead tab.
    const args = workspace
      ? ['-NoLogo', '-NoExit', '-Command', claudeLaunchCommand(workspace)]
      : ['-NoLogo']
    const proc = pty.spawn('powershell.exe', args, {
      name: 'xterm-color',
      cwd: workspace ? workspace.worktreePath : process.env.USERPROFILE,
      env: process.env as Record<string, string>,
      cols,
      rows,
      useConpty: true
    })
    const entry: PtyEntry = {
      proc,
      buffer: '',
      lastBusyMarkerAt: 0,
      lastOutputAt: 0,
      hadInput: false,
      lastInputAt: 0,
      markerTail: ''
    }
    this.ptys.set(workspaceId, entry)

    proc.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_LIMIT)
      entry.lastOutputAt = Date.now()
      entry.markerTail = (entry.markerTail + data.replace(ANSI, '')).slice(-64)
      if (BUSY_MARKER.test(entry.markerTail)) {
        entry.lastBusyMarkerAt = Date.now()
      }
      this.send(IPC.EvPtyData, { workspaceId, data })
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(workspaceId)
      this.send(IPC.EvPtyExit, { workspaceId, exitCode })
    })
  }

  write(workspaceId: string, data: string): void {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return
    entry.hadInput = true
    entry.lastInputAt = Date.now()
    entry.proc.write(data)
  }

  // True once anything was typed/dispatched into the session since it spawned.
  hadInput(workspaceId: string): boolean {
    return this.ptys.get(workspaceId)?.hadInput ?? false
  }

  // Milliseconds since something was typed/dispatched; null if never or closed.
  inputAgeMs(workspaceId: string): number | null {
    const at = this.ptys.get(workspaceId)?.lastInputAt
    return at ? Date.now() - at : null
  }

  // Milliseconds since the TUI last showed its busy indicator; null if the
  // terminal isn't open or Claude has never run in it.
  busyMarkerAgeMs(workspaceId: string): number | null {
    const at = this.ptys.get(workspaceId)?.lastBusyMarkerAt
    return at ? Date.now() - at : null
  }

  // Milliseconds since any output arrived; null if the terminal isn't open.
  outputAgeMs(workspaceId: string): number | null {
    const at = this.ptys.get(workspaceId)?.lastOutputAt
    return at ? Date.now() - at : null
  }

  // Type a prompt into the session's Claude TUI. Boots the session first if
  // its terminal was never opened (TUI needs a few seconds before input).
  async dispatchPrompt(workspaceId: string, prompt: string): Promise<void> {
    if (!this.ptys.has(workspaceId)) {
      this.create(workspaceId, 120, 30)
      await new Promise((r) => setTimeout(r, 8000))
    }
    const text = prompt.replace(/\r?\n/g, ' ').trim()
    this.write(workspaceId, text)
    // Small pause so the TUI ingests the paste before Enter.
    await new Promise((r) => setTimeout(r, 300))
    this.write(workspaceId, '\r')
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    this.ptys.get(workspaceId)?.proc.resize(cols, rows)
  }

  kill(workspaceId: string): void {
    const entry = this.ptys.get(workspaceId)
    if (entry) {
      this.ptys.delete(workspaceId)
      entry.proc.kill()
    }
  }

  // Kill and respawn (picks up model/effort changes; resumes conversation).
  restart(workspaceId: string, cols: number, rows: number): void {
    this.kill(workspaceId)
    this.create(workspaceId, cols, rows)
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
