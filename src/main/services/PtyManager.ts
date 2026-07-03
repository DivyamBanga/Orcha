import * as pty from 'node-pty'
import { IPC } from '../../shared/ipc'
import * as db from '../db'

type SendFn = (channel: string, payload: unknown) => void

const REPLAY_LIMIT = 50_000

interface PtyEntry {
  proc: pty.IPty
  buffer: string
}

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  constructor(private send: SendFn) {}

  // Spawns the shell on first call; on later calls replays recent output so a
  // re-attached xterm isn't blank.
  create(workspaceId: string, cols: number, rows: number): void {
    const existing = this.ptys.get(workspaceId)
    if (existing) {
      if (existing.buffer) {
        this.send(IPC.EvPtyData, { workspaceId, data: existing.buffer })
      }
      return
    }

    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)

    const proc = pty.spawn('powershell.exe', [], {
      name: 'xterm-color',
      cwd: workspace.worktreePath,
      env: process.env as Record<string, string>,
      cols,
      rows,
      useConpty: true
    })
    const entry: PtyEntry = { proc, buffer: '' }
    this.ptys.set(workspaceId, entry)

    proc.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_LIMIT)
      this.send(IPC.EvPtyData, { workspaceId, data })
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(workspaceId)
      this.send(IPC.EvPtyExit, { workspaceId, exitCode })
    })
  }

  write(workspaceId: string, data: string): void {
    this.ptys.get(workspaceId)?.proc.write(data)
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

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
