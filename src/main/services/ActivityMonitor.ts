import { Notification } from 'electron'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import { pendingQuestion } from '../claudeSessions'
import { codexPendingQuestion } from '../codex'
import type { PtyManager } from './PtyManager'

type SendFn = (channel: string, payload: unknown) => void

export type ActivityState = 'working' | 'waiting' | 'off'

const POLL_MS = 2000
// How "working" is detected (verified empirically on Windows/ConPTY):
// an idle Claude TUI screen is static and ConPTY, which only transmits screen
// diffs, emits literally zero bytes. A mid-turn TUI animates its spinner and
// elapsed counter continuously. So sustained output = working, silence = done.
// The "esc to interrupt" text is NOT reliable: ConPTY resends it only when
// that line first draws, and some TUI states never show it at all.
//
// Output within this age counts as "flowing" for the current poll.
const OUTPUT_FLOWING_MS = 2500
// Consecutive flowing polls needed to call the session working, so a one-off
// repaint (a window resize, a stray redraw) does not register as work.
const ENTER_STREAK = 2
// Keystroke echo also produces output; ignore output this soon after input so
// the user typing a prompt does not read as Claude working.
const TYPING_GUARD_MS = 3000
// A fresh busy marker still enters "working" instantly when it does appear.
const MARKER_FRESH_MS = 5000
// While a turn runs the spinner repaints about once a second, so output never
// stays quiet mid-turn. Output silent this long = the turn is over.
const OUTPUT_IDLE_MS = 8000
// Only notify a finish when the work actually lasted a bit, so quick replies
// stay quiet. Being blocked on an answer is exempt: a question needs you no
// matter how early in the turn it appeared.
const MIN_WORK_BURST_MS = 8000
// After the turn looks finished, wait this long and make sure it stayed idle
// before pinging. If the spinner comes back (the turn only paused on a slow
// command), the pending ping is cancelled and you never get a false "done".
const CONFIRM_STILL_IDLE_MS = 6000

// What kind of ping a settled screen earns. 'blocked' is Claude waiting on an
// answer (chimes), 'finished' is a completed turn (silent), 'exited' is the
// claude process dying under the session (silent).
export type PingKind = 'blocked' | 'finished' | 'exited'

// Signs the TUI stopped to ask something. ConPTY diffs skip cells that are
// already painted, so chrome phrases can arrive glued ("esctocancel") or even
// missing a letter ("Enter to elect" — observed live); phrases are therefore
// matched against a whitespace-free copy, and the primary signal is content
// the TUI paints fresh: two or more numbered options plus a question mark.
// The prose variants also catch a turn that ends by asking you a question in
// words, which equally needs an answer. Deliberately absent: "tabtocycle",
// which the idle composer's footer contains.
const FLAT_ASK_HINTS = [
  /doyouwant/i,
  /wouldyoulike/i,
  /\(y\/n\)/i,
  /esctocancel/i,
  /enterto(?:select|confirm|continue)/i
]
// A picker option: "1. Semantic", "❯ 2. Calendar" — digit, dot, then a fresh
// capital or paren (which keeps version numbers like "1.4.2" from counting).
const OPTION_DIGIT = /(?:^|[\s❯>])([1-9])\.\s?[A-Z(]/g
// The pty wraps claude in `powershell -NoExit`, so claude dying leaves a
// PowerShell prompt as the last thing drawn (spaced and glued variants).
const SHELL_PROMPT = /PS [A-Za-z]:[^>\n]{0,200}>\s*$/
const FLAT_SHELL_PROMPT = /PS[A-Za-z]:[^>]{0,200}>$/
// The CSI strip in PtyManager leaves OSC title sets, box drawing and stray
// control bytes behind; clear those before matching text.
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b-\x1f]/g
const BOX = /[─-▟]/g
// A question sentence, for showing the actual ask in the toast body.
const QUESTION = /[A-Za-z][^.?!\n]{8,140}\?/g

// Decide what a settled screen means from its visible tail. ConPTY repaints
// are cursor-addressed fragments, so this reads the tail as text soup rather
// than trusting line structure.
export function classifyScreen(raw: string): { kind: PingKind; question: string | null } {
  const tail = raw.replace(OSC, '').replace(BOX, ' ').replace(CTRL, ' ').slice(-1200)
  const flat = tail.replace(/\s+/g, '')
  if (SHELL_PROMPT.test(tail.trimEnd()) || FLAT_SHELL_PROMPT.test(flat)) {
    return { kind: 'exited', question: null }
  }
  const digits = new Set<string>()
  for (const m of tail.matchAll(OPTION_DIGIT)) digits.add(m[1])
  const picker = digits.size >= 2 && tail.includes('?')
  if (picker || FLAT_ASK_HINTS.some((h) => h.test(flat))) {
    // Search the whole tail: verbose picker options easily push the question
    // itself several hundred characters back from the end of the screen.
    const asks = tail.match(QUESTION)
    // Long space runs are screen-layout gaps; keep only the segment after the
    // last one so headers to the left of the question don't ride along. A
    // 25+ character unbroken run means the diff glued the words — unusable.
    const last = asks ? asks[asks.length - 1] : null
    const seg = last ? (last.split(/\s{3,}/).pop() ?? last) : null
    const clean = seg && seg.length >= 12 && !/\S{25,}/.test(seg)
    const question = clean ? seg.replace(/\s+/g, ' ').trim() : null
    return { kind: 'blocked', question }
  }
  return { kind: 'finished', question: null }
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export class ActivityMonitor {
  private states = new Map<string, ActivityState>()
  private workingSince = new Map<string, number>()
  // Consecutive polls with output flowing, and when that flow started.
  private flowStreak = new Map<string, number>()
  private flowStart = new Map<string, number>()
  // Sessions that looked done and are serving out the confirmation window,
  // with the ping already classified and worded at transition time.
  private pendingNotify = new Map<string, { at: number; kind: PingKind; body: string }>()
  private shown = new Set<Notification>()
  private timer: NodeJS.Timeout | null = null

  onNotificationClick: ((workspaceId: string) => void) | null = null
  isWindowFocused: (() => boolean) | null = null
  // Fires for every earned ping regardless of window focus (the desktop toast
  // below still only shows unfocused) — the phone companion applies its own
  // delivery rules and uses 'finished' to refresh next-step suggestions.
  onPing: ((workspaceId: string, kind: PingKind, body: string, focused: boolean) => void) | null =
    null
  // Fires on every state flip, alongside the renderer event.
  onState: ((workspaceId: string, state: ActivityState) => void) | null = null

  constructor(
    private send: SendFn,
    private ptyManager: PtyManager
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  current(workspaceId: string): ActivityState {
    return this.states.get(workspaceId) ?? 'off'
  }

  anyWorking(): boolean {
    for (const state of this.states.values()) if (state === 'working') return true
    return false
  }

  private poll(): void {
    const now = Date.now()
    for (const workspace of db.workspaces.listActive()) {
      const prev = this.states.get(workspace.id) ?? 'off'
      let next: ActivityState
      if (!this.ptyManager.has(workspace.id)) {
        next = 'off'
        this.flowStreak.delete(workspace.id)
      } else if (prev === 'working') {
        // Already mid-turn: output flow keeps it alive; silence means done.
        const outputAge = this.ptyManager.outputAgeMs(workspace.id) ?? Infinity
        next = outputAge < OUTPUT_IDLE_MS ? 'working' : 'waiting'
        // A finished turn starts counting flow from zero, or a single repaint
        // after it (Claude Code redraws its footer a few seconds later) would
        // count as sustained output and flip the session straight back.
        if (next === 'waiting') this.flowStreak.set(workspace.id, 0)
      } else {
        // Idle: enter working on sustained output flow (Claude animating its
        // spinner) that is not just the echo of the user typing, or right away
        // on a freshly drawn busy marker when the TUI does show one.
        const outputAge = this.ptyManager.outputAgeMs(workspace.id)
        const flowing = outputAge !== null && outputAge < OUTPUT_FLOWING_MS
        const streak = flowing ? (this.flowStreak.get(workspace.id) ?? 0) + 1 : 0
        if (streak === 1) this.flowStart.set(workspace.id, now - (outputAge ?? 0))
        this.flowStreak.set(workspace.id, streak)
        const inputAge = this.ptyManager.inputAgeMs(workspace.id)
        const typing = inputAge !== null && inputAge < TYPING_GUARD_MS
        const markerAge = this.ptyManager.busyMarkerAgeMs(workspace.id)
        const freshMarker = markerAge !== null && markerAge < MARKER_FRESH_MS
        next = freshMarker || (streak >= ENTER_STREAK && !typing) ? 'working' : 'waiting'
      }

      if (next !== prev) {
        // Backdate to when the burst's output actually started; the poll can
        // lag it by a few seconds, which would shrink measured work time.
        if (next === 'working') {
          const markerAge = this.ptyManager.busyMarkerAgeMs(workspace.id)
          const fromMarker = markerAge !== null && markerAge < MARKER_FRESH_MS ? now - markerAge : now
          const fromFlow = this.flowStart.get(workspace.id) ?? now
          this.workingSince.set(workspace.id, Math.min(fromMarker, fromFlow))
        }
        this.states.set(workspace.id, next)
        this.send(IPC.EvActivity, { workspaceId: workspace.id, state: next })
        this.onState?.(workspace.id, next)

        // Turn settled: classify the screen and start the confirmation window
        // instead of firing right away, so a mid-turn pause can't masquerade
        // as "done". Two gates keep launches and recap repaints silent: the
        // session must have had real input, and the burst must have drawn the
        // busy marker at least once (a real turn always does; a `--continue`
        // recap or startup flash never does).
        if (prev === 'working' && next === 'waiting') {
          const idleFor = this.ptyManager.outputAgeMs(workspace.id) ?? 0
          const started = this.workingSince.get(workspace.id) ?? now
          const burst = now - idleFor - started
          const markerAge = this.ptyManager.busyMarkerAgeMs(workspace.id)
          const markerInBurst = markerAge !== null && now - markerAge >= started - 5000
          if (markerInBurst && this.ptyManager.hadInput(workspace.id)) {
            const codex = workspace.agent === 'codex'
            const screen = classifyScreen(this.ptyManager.screenText(workspace.id))
            let { kind } = screen
            // On a Mac the launch script reports the agent's exit itself.
            if (this.ptyManager.agentExited(workspace.id)) kind = 'exited'
            // Codex says it needs you in its window title ("Action Required"),
            // and a turn that ends on a question waits on you just the same.
            const codexAsk =
              codex && kind !== 'exited' ? codexPendingQuestion(workspace.worktreePath) : null
            const codexFlag =
              codex &&
              kind !== 'exited' &&
              /action\s*required/i.test(this.ptyManager.title(workspace.id))
            // Claude's transcript likewise: a reply that streamed in word by
            // word never has its options on screen together to be spotted.
            const claudeAsk =
              !codex && kind !== 'exited' ? pendingQuestion(workspace.worktreePath) : null
            if (codexAsk || codexFlag || claudeAsk) kind = 'blocked'
            if (kind === 'blocked') {
              // The transcript has the ask verbatim; the screen-scraped text
              // is the fallback for sessions without a local transcript (ssh).
              const ask = (codex ? codexAsk : claudeAsk) ?? screen.question
              this.pendingNotify.set(workspace.id, {
                at: now,
                kind,
                body: ask ?? 'Waiting on your input to continue'
              })
            } else if (kind === 'exited') {
              this.pendingNotify.set(workspace.id, {
                at: now,
                kind,
                body: `The ${codex ? 'Codex' : 'Claude'} process exited`
              })
            } else if (burst >= MIN_WORK_BURST_MS) {
              this.pendingNotify.set(workspace.id, {
                at: now,
                kind,
                body: `Worked ${fmtDuration(burst)}, back to you`
              })
            }
          }
        }
      }

      // A resumed (or closed) session cancels any pending ping. Resumed means a
      // new turn: input since the ping was queued, or the busy marker drawn
      // again. Output alone isn't enough — Claude Code redraws its footer a few
      // seconds after a turn ends, which would otherwise swallow every ping.
      const queued = this.pendingNotify.get(workspace.id)
      if (queued && next !== 'waiting') {
        const markerAge = this.ptyManager.busyMarkerAgeMs(workspace.id)
        const inputAge = this.ptyManager.inputAgeMs(workspace.id)
        const newTurn =
          (markerAge !== null && now - markerAge > queued.at) ||
          (inputAge !== null && now - inputAge > queued.at)
        if (next === 'off' || newTurn) this.pendingNotify.delete(workspace.id)
      }

      // Still idle after the confirmation window: fire once, but only if you're
      // not already looking at the window.
      const pending = this.pendingNotify.get(workspace.id)
      if (pending !== undefined && now - pending.at >= CONFIRM_STILL_IDLE_MS) {
        this.pendingNotify.delete(workspace.id)
        const focused = this.isWindowFocused?.() ?? false
        this.onPing?.(workspace.id, pending.kind, pending.body, focused)
        if (!focused) {
          this.notify(workspace.id, pending.kind, pending.body)
        }
      }
    }
  }

  // Wired to PtyManager.onUnexpectedExit: the process died on its own.
  // Deliberate closes and restarts never land here, and sessions that were
  // never typed into stay quiet (nothing of yours was lost).
  onUnexpectedExit(workspaceId: string, hadInput: boolean): void {
    this.pendingNotify.delete(workspaceId)
    if (!hadInput) return
    const focused = this.isWindowFocused?.() ?? false
    this.onPing?.(workspaceId, 'exited', 'The session ended unexpectedly', focused)
    if (focused) return
    this.notify(workspaceId, 'exited', 'The session ended unexpectedly')
  }

  // "project · session", matching the sidebar's language for main sessions.
  private label(workspaceId: string): string {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) return 'Claude session'
    const project = db.projects.get(workspace.projectId)?.name
    const session = workspace.kind === 'main' ? 'main' : workspace.name
    return project ? `${project} · ${session}` : workspace.name
  }

  private notify(workspaceId: string, kind: PingKind, body: string): void {
    if (!Notification.isSupported()) return
    const label = this.label(workspaceId)
    const title =
      kind === 'blocked'
        ? `${label} needs your answer`
        : kind === 'exited'
          ? `${label} exited`
          : `${label} is done`
    // Only being blocked chimes; results and deaths arrive as silent toasts.
    const notification = new Notification({ title, body, silent: kind !== 'blocked' })
    // Held until dismissed: a collected Notification stops delivering clicks
    // (macOS keeps toasts in Notification Center long after they appear).
    this.shown.add(notification)
    if (this.shown.size > 50) this.shown.delete(this.shown.values().next().value!)
    notification.on('click', () => {
      this.shown.delete(notification)
      this.onNotificationClick?.(workspaceId)
    })
    notification.on('close', () => this.shown.delete(notification))
    notification.show()
    console.log('[notify]', kind, '|', title, '|', body)
  }
}
