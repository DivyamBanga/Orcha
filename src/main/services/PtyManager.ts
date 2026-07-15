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
  cols: number
  rows: number
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
  // Rolling ANSI-stripped tail of output for spotting the Remote Control
  // session URL. Stripped, because during heavy repaints ConPTY interleaves
  // cursor moves inside the URL text and a raw-tail regex misses it.
  urlTail: string
  // Latest claude.ai/code session URL seen, and when. dispatch time is
  // compared against this so a stale URL from a --continue recap never wins.
  remoteUrl: string | null
  remoteUrlAt: number
}

// The TUI repaints this constantly while Claude is running a turn.
const BUSY_MARKER = /esc to interrupt/i
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Remote Control session link shown by /remote-control.
const REMOTE_URL = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]{8,}/g

function claudeLaunchCommand(workspace: Workspace): string {
  const parts = ['claude', '--dangerously-skip-permissions']
  if (hasSessionHistory(workspace.worktreePath)) parts.push('--continue')
  if (workspace.model) parts.push('--model', workspace.model)
  if (workspace.effort) parts.push('--effort', workspace.effort)
  return parts.join(' ')
}

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  // Taps for the live-share server: mirror output/resize/exit to viewers.
  onData: ((workspaceId: string, data: string) => void) | null = null
  onResize: ((workspaceId: string, cols: number, rows: number) => void) | null = null
  onExit: ((workspaceId: string) => void) | null = null

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
      cols,
      rows,
      lastBusyMarkerAt: 0,
      lastOutputAt: 0,
      hadInput: false,
      lastInputAt: 0,
      markerTail: '',
      urlTail: '',
      remoteUrl: null,
      remoteUrlAt: 0
    }
    this.ptys.set(workspaceId, entry)

    proc.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_LIMIT)
      entry.lastOutputAt = Date.now()
      entry.markerTail = (entry.markerTail + data.replace(ANSI, '')).slice(-64)
      if (BUSY_MARKER.test(entry.markerTail)) {
        entry.lastBusyMarkerAt = Date.now()
      }
      entry.urlTail = (entry.urlTail + data.replace(ANSI, '')).slice(-512)
      const urls = entry.urlTail.match(REMOTE_URL)
      if (urls) {
        const last = urls[urls.length - 1]
        entry.remoteUrl = last
        entry.remoteUrlAt = Date.now()
        // Consume the tail through this match so an already-seen URL can't
        // re-match on later chunks and masquerade as freshly printed.
        entry.urlTail = entry.urlTail.slice(entry.urlTail.lastIndexOf(last) + last.length)
      }
      this.send(IPC.EvPtyData, { workspaceId, data })
      this.onData?.(workspaceId, data)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(workspaceId)
      this.send(IPC.EvPtyExit, { workspaceId, exitCode })
      this.onExit?.(workspaceId)
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
      // A booting TUI (--continue repaints history) silently eats input typed
      // while it's still painting. An idle TUI emits nothing over ConPTY, so
      // quiet output means the prompt is ready — but only after real output:
      // the shell prompt paints in <1s and claude's node startup then emits
      // NOTHING for a few seconds, so quiet alone fires inside that gap.
      // The TUI's welcome/recap is always well over 800 chars; a bare shell
      // prompt is far under it.
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        const age = this.outputAgeMs(workspaceId)
        const booted = this.buffer(workspaceId).length > 800
        if (booted && age !== null && age > 2500) break
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    const text = prompt.replace(/\r?\n/g, ' ').trim()
    this.write(workspaceId, text)
    // Small pause so the TUI ingests the paste before Enter.
    await new Promise((r) => setTimeout(r, 300))
    this.write(workspaceId, '\r')
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return
    entry.cols = cols
    entry.rows = rows
    entry.proc.resize(cols, rows)
    this.onResize?.(workspaceId, cols, rows)
  }

  buffer(workspaceId: string): string {
    return this.ptys.get(workspaceId)?.buffer ?? ''
  }

  size(workspaceId: string): { cols: number; rows: number } | null {
    const entry = this.ptys.get(workspaceId)
    return entry ? { cols: entry.cols, rows: entry.rows } : null
  }

  // ConPTY transmits only screen diffs, so a viewer attaching mid-session gets
  // a stale replay. A momentary 1-column shrink forces ConPTY to repaint the
  // whole true screen for everyone.
  forceRepaint(workspaceId: string): void {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return
    entry.proc.resize(entry.cols - 1, entry.rows)
    setTimeout(() => {
      const still = this.ptys.get(workspaceId)
      if (still === entry) entry.proc.resize(entry.cols, entry.rows)
    }, 60)
  }

  // Latest claude.ai/code link the TUI printed, if seen at/after `since`.
  remoteUrlSince(workspaceId: string, since: number): string | null {
    const entry = this.ptys.get(workspaceId)
    if (!entry || !entry.remoteUrl || entry.remoteUrlAt < since) return null
    return entry.remoteUrl
  }

  // Fallback: last claude.ai/code link anywhere in the replay buffer. The
  // Remote Control session is recorded per conversation and auto-reconnects
  // on --continue, so an earlier print of the link is still the live one.
  lastRemoteUrlInBuffer(workspaceId: string): string | null {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return null
    const urls = entry.buffer.replace(ANSI, '').match(REMOTE_URL)
    return urls ? urls[urls.length - 1] : null
  }

  // Forget any previously seen link (a stale URL sitting in the tail would
  // otherwise re-match on every chunk and look freshly printed).
  clearRemoteUrl(workspaceId: string): void {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return
    entry.urlTail = ''
    entry.remoteUrl = null
    entry.remoteUrlAt = 0
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
