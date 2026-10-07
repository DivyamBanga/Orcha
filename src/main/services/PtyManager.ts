import * as pty from 'node-pty'
import { homedir } from 'os'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import { hasSessionHistory } from '../claudeSessions'
import { claudeRelayEnv, isGuest } from '../guest'
import { codexArgv, codexEnv, codexLaunchCommand } from '../codex'
import { isWin, loginShell } from '../platform'
import { findExecutable } from '../platform-core'
import { firstRunKeys, type FirstRunState } from '../firstRun'
import { sshArgs, shQuote, remoteHasSessionHistory, type SshTarget } from '../ssh'
import type { Workspace, Project } from '../../shared/types'

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
  // Which busy marker this session's TUI draws (Claude and Codex differ).
  busyMarker: RegExp
  // Latest terminal title the TUI set, plus a raw tail for sequences split
  // across chunks. Codex puts "Action Required" there when it needs you.
  title: string
  titleTail: string
  // A guest's Claude session answers Claude Code's one-time first-run screens
  // itself (see firstRun.ts): which it has answered, and a tail of what's drawn
  // since. Null = not watching (any more).
  firstRun: FirstRunState | null
  // Mac/Linux: the agent printed EXIT_MARK on its way out and the tab is now
  // a plain shell (Windows reads PowerShell's prompt off the screen instead).
  agentExited: boolean
  exitTail: string
}

// The TUI repaints this constantly while Claude is running a turn. Matched
// whitespace-free: ConPTY diffs skip cells that are already painted, so the
// phrase's spaces often arrive as cursor jumps and strip away with the ANSI
// ("esctointerrupt" — observed live).
const BUSY_MARKER = /esctointerrupt/i
// Codex's status row, "Working (12s • esc to interrupt)", whitespace-free. The
// elapsed time keeps it apart from the bare phrase Codex's question view also
// shows.
const CODEX_BUSY_MARKER = /\ds•esctointerrupt/i
// OSC 0/2: set window title.
// eslint-disable-next-line no-control-regex
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Remote Control session link shown by /remote-control.
const REMOTE_URL = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]{8,}/g
// Printed by a Mac tab's launch script once the agent exits (an OSC sequence,
// which xterm.js silently drops, so the user never sees it).
const EXIT_MARK = '\x1b]7701;orcha-exit\x07'

function claudeArgv(workspace: Workspace): string[] {
  const parts = ['claude', '--dangerously-skip-permissions']
  if (hasSessionHistory(workspace.worktreePath)) parts.push('--continue')
  // Guests default to Sonnet: it's the best value on a fixed budget, and their
  // own Claude Code settings may default to Opus.
  const model = workspace.model ?? (isGuest() ? 'sonnet' : null)
  if (model) parts.push('--model', model)
  if (workspace.effort) parts.push('--effort', workspace.effort)
  return parts
}

// A Mac tab runs the agent directly under /bin/sh with the relay settings in
// its environment: no rc file runs first, so nothing prints ahead of the agent
// (the dispatch boot gate counts on that) and no .zshrc export can redirect a
// guest's billing. When the agent exits, the tab says so in plain words and
// becomes the user's login shell in the same folder (Windows: -NoExit).
function macLaunchScript(argv: string[], agentName: string): string {
  const file = findExecutable(argv[0])
  const shell = `exec ${shQuote(loginShell())} -l`
  if (!file) {
    const missing = `${agentName} isn't installed yet. Install it from Orcha's setup, then reopen this tab.`
    return `printf '%s\\r\\n' ${shQuote(missing)}; ${shell}`
  }
  const run = [file, ...argv.slice(1)].map(shQuote).join(' ')
  const exited = `${agentName} exited. Restart the tab to start it again.`
  return `${run}; printf '\\033]7701;orcha-exit\\007\\r\\n%s\\r\\n' ${shQuote(exited)}; ${shell}`
}

// Remote counterpart of claudeLaunchCommand: cd into the folder on the
// server, then land in an interactive login shell when Claude exits/crashes
// (the ssh analog of the local spawn's -NoExit) instead of dropping the
// connection.
function remoteClaudeCommand(workspace: Workspace, hasHistory: boolean): string {
  const parts = ['claude', '--dangerously-skip-permissions']
  if (hasHistory) parts.push('--continue')
  if (workspace.model) parts.push('--model', workspace.model)
  if (workspace.effort) parts.push('--effort', workspace.effort)
  return `cd ${shQuote(workspace.worktreePath)} && ${parts.join(' ')}; exec $SHELL -l`
}

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()
  // workspaceId -> in-flight create() spawn, so concurrent callers dedupe
  // onto one spawn instead of racing (create() now awaits a remote preflight
  // check before spawning, so it's no longer atomic per call).
  private creating = new Map<string, Promise<void>>()

  // Taps mirroring output/resize/exit to interested services (live share,
  // the phone companion). Multiple subscribers, so services never clobber
  // each other's callback.
  private dataTaps: ((workspaceId: string, data: string) => void)[] = []
  private resizeTaps: ((workspaceId: string, cols: number, rows: number) => void)[] = []
  private exitTaps: ((workspaceId: string) => void)[] = []
  // Fires only when the process died on its own — deliberate kills (Close,
  // Restart, quit, archive) remove the entry before killing and never land here.
  onUnexpectedExit: ((workspaceId: string, hadInput: boolean) => void) | null = null

  tapData(fn: (workspaceId: string, data: string) => void): void {
    this.dataTaps.push(fn)
  }

  tapResize(fn: (workspaceId: string, cols: number, rows: number) => void): void {
    this.resizeTaps.push(fn)
  }

  tapExit(fn: (workspaceId: string) => void): void {
    this.exitTaps.push(fn)
  }

  constructor(private send: SendFn) {}

  has(workspaceId: string): boolean {
    return this.ptys.has(workspaceId)
  }

  // Spawns the session shell (auto-running the Claude TUI) on first call; on
  // later calls replays recent output so a re-attached xterm isn't blank.
  // Remote spawns await a preflight ssh check before spawning, so concurrent
  // calls (e.g. a tab mounting its terminal while Share also asks for one)
  // are deduped onto a single in-flight spawn instead of double-spawning.
  create(workspaceId: string, cols: number, rows: number): Promise<void> {
    const existing = this.ptys.get(workspaceId)
    if (existing) {
      if (existing.buffer) {
        this.send(IPC.EvPtyData, { workspaceId, data: existing.buffer })
      }
      return Promise.resolve()
    }
    const inFlight = this.creating.get(workspaceId)
    if (inFlight) return inFlight

    const promise = this.doCreate(workspaceId, cols, rows).finally(() =>
      this.creating.delete(workspaceId)
    )
    this.creating.set(workspaceId, promise)
    return promise
  }

  // Copies process.env, applying the workspace's stored auth-mode override.
  // 'apiKey' sets ANTHROPIC_API_KEY; 'subscription' (including default/unset)
  // strips it, since Claude Code's own precedence lets a global env var
  // silently beat an OAuth login otherwise. A guest's sessions skip all that:
  // they always go through their host's relay.
  private authEnv(workspace: Workspace, project: Project | undefined): Record<string, string> {
    const env = { ...process.env } as Record<string, string>
    if (workspace.agent === 'codex') return codexEnv(env)
    if (isGuest()) return claudeRelayEnv(env, project?.name ?? workspace.name, workspace.id)
    const auth = db.workspaceAuth.get(workspace.id)
    if (auth.mode === 'apiKey' && auth.apiKey) {
      env.ANTHROPIC_API_KEY = auth.apiKey
    } else {
      delete env.ANTHROPIC_API_KEY
    }
    return env
  }

  private async doCreate(workspaceId: string, cols: number, rows: number): Promise<void> {
    // 'setup' is the onboarding terminal: plain shell in the home folder for
    // running `gh auth login` / `claude` login flows.
    const workspace = workspaceId === 'setup' ? null : db.workspaces.get(workspaceId)
    if (workspaceId !== 'setup' && !workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`)
    }
    const project: Project | undefined = workspace
      ? db.projects.get(workspace.projectId)
      : undefined

    let proc: pty.IPty
    if (workspace && project?.sshHost) {
      const target: SshTarget = {
        host: project.sshHost,
        user: project.sshUser!,
        port: project.sshPort
      }
      const hasHistory = await remoteHasSessionHistory(target, workspace.worktreePath)
      const remoteCommand = remoteClaudeCommand(workspace, hasHistory)
      // -tt forces pty allocation: ssh only auto-allocates one when no
      // command is given, and without it the remote Claude TUI gets no tty.
      const args = [...sshArgs(target, { batch: false }), '-tt', remoteCommand]
      proc = isWin
        ? pty.spawn('ssh.exe', args, {
            name: 'xterm-color',
            cwd: process.env.USERPROFILE,
            env: process.env as Record<string, string>,
            cols,
            rows,
            useConpty: true
          })
        : pty.spawn('ssh', args, {
            name: 'xterm-256color',
            cwd: homedir(),
            env: { ...process.env, COLORTERM: 'truecolor' } as Record<string, string>,
            cols,
            rows
          })
    } else if (!isWin) {
      let script: string | null = null
      if (workspace?.agent === 'codex') {
        const { file, args } = codexArgv(workspace, project)
        script = macLaunchScript([file, ...args], 'Codex')
      } else if (workspace) {
        script = macLaunchScript(claudeArgv(workspace), 'Claude')
      }
      const env = workspace
        ? this.authEnv(workspace, project)
        : (process.env as Record<string, string>)
      proc = pty.spawn(script ? '/bin/sh' : loginShell(), script ? ['-c', script] : ['-l'], {
        name: 'xterm-256color',
        cwd: workspace ? workspace.worktreePath : homedir(),
        env: { ...env, COLORTERM: 'truecolor' },
        cols,
        rows
      })
    } else {
      // -NoExit: when the agent exits (/exit, crash), you land in a shell in
      // the same folder instead of a dead tab.
      const launch = workspace
        ? workspace.agent === 'codex'
          ? codexLaunchCommand(workspace, project)
          : claudeArgv(workspace).join(' ')
        : null
      const args = launch ? ['-NoLogo', '-NoExit', '-Command', launch] : ['-NoLogo']
      proc = pty.spawn('powershell.exe', args, {
        name: 'xterm-color',
        cwd: workspace ? workspace.worktreePath : process.env.USERPROFILE,
        env: workspace ? this.authEnv(workspace, project) : (process.env as Record<string, string>),
        cols,
        rows,
        useConpty: true
      })
    }
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
      remoteUrlAt: 0,
      busyMarker: workspace?.agent === 'codex' ? CODEX_BUSY_MARKER : BUSY_MARKER,
      title: '',
      titleTail: '',
      firstRun:
        workspace?.agent === 'claude' && isGuest()
          ? { tail: '', done: new Set() }
          : null,
      agentExited: false,
      exitTail: ''
    }
    this.ptys.set(workspaceId, entry)
    // These screens only ever show at startup.
    if (entry.firstRun) setTimeout(() => (entry.firstRun = null), 120_000)

    proc.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_LIMIT)
      entry.lastOutputAt = Date.now()
      // The whole chunk is scanned, not just the kept tail: Claude Code can draw
      // a long status line right after the marker (a guest's sessions show a
      // "connectors are disabled" warning there), which would push it out.
      const markerScan = entry.markerTail + data.replace(ANSI, '').replace(/\s+/g, '')
      if (entry.busyMarker.test(markerScan)) {
        entry.lastBusyMarkerAt = Date.now()
      }
      entry.markerTail = markerScan.slice(-64)
      if (!isWin && !entry.agentExited) {
        const scan = entry.exitTail + data
        if (scan.includes(EXIT_MARK)) entry.agentExited = true
        entry.exitTail = scan.slice(-EXIT_MARK.length)
      }
      if (data.includes('\x1b]') || entry.titleTail) {
        const scan = entry.titleTail + data
        const titles = [...scan.matchAll(TITLE)]
        if (titles.length > 0) entry.title = titles[titles.length - 1][1]
        // Keep an unterminated sequence around for the next chunk.
        const open = scan.lastIndexOf('\x1b]')
        const closed = titles.length > 0 ? titles[titles.length - 1].index! : -1
        entry.titleTail = open > closed ? scan.slice(open).slice(0, 512) : ''
      }
      const firstRun = entry.firstRun
      const keys = firstRun ? firstRunKeys(firstRun, data.replace(ANSI, '')) : null
      if (firstRun && keys) {
        // Answered once the screen has finished drawing; the tail clears with
        // the last key, so the next screen is matched on its own text only.
        keys.forEach((key, i) =>
          setTimeout(
            () => {
              if (this.ptys.get(workspaceId) !== entry) return
              entry.proc.write(key)
              if (i === keys.length - 1) firstRun.tail = ''
            },
            500 + i * 200
          )
        )
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
      for (const tap of this.dataTaps) tap(workspaceId, data)
    })
    proc.onExit(({ exitCode }) => {
      // Identity check: kill()/restart() removed (or replaced) the entry
      // before this event, so the entry still being current means the process
      // died on its own. Guarding the delete also keeps a late exit event
      // from a restart's old process from clobbering the fresh entry.
      const unexpected = this.ptys.get(workspaceId) === entry
      if (unexpected) this.ptys.delete(workspaceId)
      this.send(IPC.EvPtyExit, { workspaceId, exitCode })
      for (const tap of this.exitTaps) tap(workspaceId)
      if (unexpected) this.onUnexpectedExit?.(workspaceId, entry.hadInput)
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

  // Mac/Linux: the agent has exited and the tab is a plain shell.
  agentExited(workspaceId: string): boolean {
    return this.ptys.get(workspaceId)?.agentExited ?? false
  }

  // The terminal title the TUI last set ('' if none or not open).
  title(workspaceId: string): string {
    return this.ptys.get(workspaceId)?.title ?? ''
  }

  // Milliseconds since any output arrived; null if the terminal isn't open.
  outputAgeMs(workspaceId: string): number | null {
    const at = this.ptys.get(workspaceId)?.lastOutputAt
    return at ? Date.now() - at : null
  }

  // Type a prompt into the session's Claude TUI. Boots the session first if
  // its terminal was never opened (TUI needs a few seconds before input).
  async dispatchPrompt(workspaceId: string, prompt: string): Promise<void> {
    // A prompt for an agent that has exited would land in the shell and run as
    // a command, so the agent comes back first.
    if (this.agentExited(workspaceId)) {
      const size = this.size(workspaceId) ?? { cols: 120, rows: 30 }
      await this.restart(workspaceId, size.cols, size.rows)
      await this.waitForBoot(workspaceId)
    } else if (!this.ptys.has(workspaceId)) {
      await this.create(workspaceId, 120, 30)
      await this.waitForBoot(workspaceId)
    }
    const text = prompt.replace(/\r?\n/g, ' ').trim()
    this.write(workspaceId, text)
    // Small pause so the TUI ingests the paste before Enter.
    await new Promise((r) => setTimeout(r, 300))
    this.write(workspaceId, '\r')
  }

  private async waitForBoot(workspaceId: string): Promise<void> {
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

  resize(workspaceId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(workspaceId)
    if (!entry) return
    entry.cols = cols
    entry.rows = rows
    entry.proc.resize(cols, rows)
    for (const tap of this.resizeTaps) tap(workspaceId, cols, rows)
  }

  buffer(workspaceId: string): string {
    return this.ptys.get(workspaceId)?.buffer ?? ''
  }

  // The tail of the session's screen with CSI sequences stripped — enough to
  // read what the TUI settled on (a question, a picker, a shell prompt after
  // claude exits). ConPTY repaints are cursor-addressed fragments, so callers
  // should treat this as text soup, not lines.
  screenText(workspaceId: string): string {
    const entry = this.ptys.get(workspaceId)
    return entry ? entry.buffer.slice(-8000).replace(ANSI, '') : ''
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
  async restart(workspaceId: string, cols: number, rows: number): Promise<void> {
    this.kill(workspaceId)
    await this.create(workspaceId, cols, rows)
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
