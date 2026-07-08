import { Notification } from 'electron'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
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
// Only notify when the work actually lasted a bit, so quick replies stay quiet.
const MIN_WORK_BURST_MS = 8000
// After the turn looks finished, wait this long and make sure it stayed idle
// before pinging. If the spinner comes back (the turn only paused on a slow
// command), the pending ping is cancelled and you never get a false "done".
const CONFIRM_STILL_IDLE_MS = 6000

// Rotating "your session finished" lines. Picked at random, never the same one
// twice in a row. Human, a little funny, no em dashes.
const DONE_LINES = [
  'All done. Get back to work.',
  'Finished. Your move, boss.',
  'Wrapped up and twiddling my thumbs.',
  'Done cooking. Come take a look.',
  'That one is done. What is next?',
  'Ready when you are.',
  'Claude tapped out. Go check the work.',
  'Stop scrolling, it is done.',
  'Finished the job. Reporting for duty.',
  'Done. Time to review the damage.',
  'Handoff time. It is all yours now.',
  'Cooked to perfection. Give it a look.',
  'Back to you. I did my part.',
  'Task complete. No notes, hopefully.',
  'Wrapped. Go be a genius.',
  'The robots have finished. Return to your desk.',
  'Done and dusted. Quit slacking.',
  'Finished before you finished your coffee.',
  'That is a wrap. Roll credits.',
  'Mission accomplished. Come collect.'
]

export class ActivityMonitor {
  private states = new Map<string, ActivityState>()
  private workingSince = new Map<string, number>()
  // Consecutive polls with output flowing, and when that flow started.
  private flowStreak = new Map<string, number>()
  private flowStart = new Map<string, number>()
  // Sessions that looked done and are serving out the confirmation window.
  private pendingNotify = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private lastLine = ''

  onNotificationClick: ((workspaceId: string) => void) | null = null
  isWindowFocused: (() => boolean) | null = null

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

        // Turn looks finished: start the confirmation window instead of firing
        // right away, so a mid-turn pause can't masquerade as "done". The
        // burst runs from the turn's opening marker to its last output, so a
        // stray marker flash measures ~0 and stays quiet. Sessions that never
        // got any input cannot have finished anything, so they stay quiet too
        // (that is what used to fire right after app startup).
        if (prev === 'working' && next === 'waiting') {
          const idleFor = this.ptyManager.outputAgeMs(workspace.id) ?? 0
          const burst = now - idleFor - (this.workingSince.get(workspace.id) ?? now)
          if (burst >= MIN_WORK_BURST_MS && this.ptyManager.hadInput(workspace.id)) {
            this.pendingNotify.set(workspace.id, now)
          }
        }
      }

      // A resumed (or closed) session cancels any pending "finished" ping.
      if (next !== 'waiting') this.pendingNotify.delete(workspace.id)

      // Still idle after the confirmation window: fire once, but only if you're
      // not already looking at the window.
      const pendingAt = this.pendingNotify.get(workspace.id)
      if (pendingAt !== undefined && now - pendingAt >= CONFIRM_STILL_IDLE_MS) {
        this.pendingNotify.delete(workspace.id)
        if (!(this.isWindowFocused?.() ?? false)) this.notify(workspace.id, workspace.name)
      }
    }
  }

  private nextLine(): string {
    const pool = DONE_LINES.filter((l) => l !== this.lastLine)
    const line = pool[Math.floor(Math.random() * pool.length)]
    this.lastLine = line
    return line
  }

  private notify(workspaceId: string, name: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: `${name} is done`,
      body: this.nextLine()
    })
    notification.on('click', () => this.onNotificationClick?.(workspaceId))
    notification.show()
  }
}
