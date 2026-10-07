import { app, ipcMain, Menu, type BrowserWindow } from 'electron'
import * as db from './db'
import type { ActivityMonitor, PingKind } from './services/ActivityMonitor'
import type { PtyManager } from './services/PtyManager'

// Hooks for the CI smoke test (scripts/smoke), registered only when Orcha is
// launched with --orcha-smoke. They let the test read main-process state that
// the UI never shows (PATH, which agent exited, pings fired while focused) and
// quit without AppleScript.
export const isSmoke = process.argv.includes('--orcha-smoke')

export function registerSmoke(
  window: BrowserWindow,
  ptyManager: PtyManager,
  activityMonitor: ActivityMonitor
): void {
  if (!isSmoke) return
  const pings: { workspaceId: string; kind: PingKind; body: string; at: number }[] = []
  const prior = activityMonitor.onPing
  activityMonitor.onPing = (workspaceId, kind, body, focused) => {
    pings.push({ workspaceId, kind, body, at: Date.now() })
    prior?.(workspaceId, kind, body, focused)
  }
  const transitions: { workspaceId: string; state: string; at: number }[] = []
  const priorState = activityMonitor.onState
  activityMonitor.onState = (workspaceId, state) => {
    transitions.push({ workspaceId, state, at: Date.now() })
    priorState?.(workspaceId, state)
  }

  ipcMain.handle('smoke:state', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    path: process.env.PATH ?? '',
    lang: process.env.LANG ?? '',
    leakedEnv: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)),
    windowVisible: window.isVisible(),
    menu: (Menu.getApplicationMenu()?.items ?? []).map((i) => i.role ?? i.label),
    sessions: db.workspaces.listActive().map((w) => ({
      id: w.id,
      agent: w.agent,
      open: ptyManager.has(w.id),
      agentExited: ptyManager.agentExited(w.id),
      activity: activityMonitor.current(w.id),
      outputAgeMs: ptyManager.outputAgeMs(w.id),
      busyMarkerAgeMs: ptyManager.busyMarkerAgeMs(w.id),
      inputAgeMs: ptyManager.inputAgeMs(w.id),
      screen: ptyManager.screenText(w.id).slice(-3000)
    })),
    pings,
    transitions
  }))
  ipcMain.handle('smoke:quit', () => app.quit())
}
