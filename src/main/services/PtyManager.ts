import * as pty from 'node-pty'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import { hasSessionHistory } from '../claudeSessions'
import { claudeRelayEnv, isGuest } from '../guest'
import { codexEnv, codexLaunchCommand } from '../codex'
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
  // A guest's Claude session answers Claude Code's one-time "Do you trust this
  // folder?" dialog itself — it pre-selects "No, exit", which would throw a
  // newcomer straight out of the folder they just chose. Null = not watching.
  trustTail: string | null
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

function claudeLaunchCommand(workspace: Workspace): string {
  const parts = ['claude', '--dangerously-skip-permissions']
  if (hasSessionHistory(workspace.worktreePath)) parts.push('--continue')
  // Guests default to Sonnet: it's the best value on a fixed budget, and their
  // own Claude Code settings may default to Opus.
  const model = workspace.model ?? (isGuest() ? 'sonnet' : null)
  if (model) parts.push('--model', model)
  if (workspace.effort) parts.push('--effort', workspace.effort)
  return parts.join(' ')
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
      proc = pty.spawn('ssh.exe', [...sshArgs(target, { batch: false }), '-tt', remoteCommand], {
        name: 'xterm-color',
        cwd: process.env.USERPROFILE,
        env: process.env as Record<string, string>,
        cols,
        rows,
        useConpty: true
      })
    } else {
      // -NoExit: when the agent exits (/exit, crash), you land in a shell in
      // the same folder instead of a dead tab.
      const launch = workspace
        ? workspace.agent === 'codex'
          ? codexLaunchCommand(workspace, project)
          : claudeLaunchCommand(workspace)
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
      trustTail: workspace?.agent === 'claude' && isGuest() ? '' : null
    }
    this.ptys.set(workspaceId, entry)
    // The trust dialog only ever shows at startup.
    if (entry.trustTail !== null) setTimeout(() => (entry.trustTail = null), 90_000)

    proc.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_LIMIT)
      entry.lastOutputAt = Date.now()
      entry.markerTail = (entry.markerTail + data.replace(ANSI, '').replace(/\s+/g, '')).slice(-64)
      if (entry.busyMarker.test(entry.markerTail)) {
        entry.lastBusyMarkerAt = Date.now()
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
      if (entry.trustTail !== null) {
        // Matched whitespace-free and loosely: ConPTY glues and even drops
        // letters in chrome text ("Enter to elect" has been seen live).
        entry.trustTail = (entry.trustTail + data.replace(ANSI, '').replace(/\s+/g, '')).slice(-400)
        if (
          /trustthisfolder/i.test(entry.trustTail) &&
          /Entertoc|Esctocancel/i.test(entry.trustTail)
        ) {
          // "No, exit" is the pre-selected answer; step down to "Yes" first.
          const yesSelected = /❯Yes/.test(entry.trustTail)
          entry.trustTail = null
          setTimeout(() => {
            if (this.ptys.get(workspaceId) !== entry) return
            if (!yesSelected) entry.proc.write('\x1b[B')
            setTimeout(() => {
              if (this.ptys.get(workspaceId) === entry) entry.proc.write('\r')
            }, 200)
          }, 400)
        }
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
    if (!this.ptys.has(workspaceId)) {
      await this.create(workspaceId, 120, 30)
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
