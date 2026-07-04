import { Notification } from 'electron'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import { lastActivityAgeSeconds } from '../claudeSessions'
import type { PtyManager } from './PtyManager'

type SendFn = (channel: string, payload: unknown) => void

export type ActivityState = 'working' | 'waiting' | 'off'

// Transcript written within this window => Claude is actively working.
const WORKING_WINDOW_S = 15
const POLL_MS = 5000
// Only notify for work bursts longer than this (skip trivial blips).
const MIN_WORK_BURST_MS = 10_000

export class ActivityMonitor {
  private states = new Map<string, ActivityState>()
  private workingSince = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

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
    for (const workspace of db.workspaces.listActive()) {
      const prev = this.states.get(workspace.id) ?? 'off'
      let next: ActivityState
      if (!this.ptyManager.has(workspace.id)) {
        next = 'off'
      } else {
        const age = lastActivityAgeSeconds(workspace.worktreePath)
        next = age !== null && age < WORKING_WINDOW_S ? 'working' : 'waiting'
      }
      if (next === prev) continue

      if (next === 'working') this.workingSince.set(workspace.id, Date.now())
      this.states.set(workspace.id, next)
      this.send(IPC.EvActivity, { workspaceId: workspace.id, state: next })

      if (prev === 'working' && next === 'waiting') {
        const burst = Date.now() - (this.workingSince.get(workspace.id) ?? 0)
        if (burst >= MIN_WORK_BURST_MS && !(this.isWindowFocused?.() ?? false)) {
          this.notify(workspace.id, workspace.name)
        }
      }
    }
  }

  private notify(workspaceId: string, name: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: name,
      body: 'Claude finished — the session is waiting for you.'
    })
    notification.on('click', () => this.onNotificationClick?.(workspaceId))
    notification.show()
  }
}
