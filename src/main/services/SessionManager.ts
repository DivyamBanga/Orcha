import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '../../shared/ipc'
import * as db from '../db'

type SendFn = (channel: string, payload: unknown) => void

const ACTIVITY_LIMIT = 20

export class SessionManager {
  private busy = new Map<string, AbortController>()
  private activity = new Map<string, string[]>()

  onTurnComplete: ((workspaceId: string) => void) | null = null

  constructor(private send: SendFn) {}

  isBusy(workspaceId: string): boolean {
    return this.busy.has(workspaceId)
  }

  recentActivity(workspaceId: string): string[] {
    return this.activity.get(workspaceId) ?? []
  }

  interrupt(workspaceId: string): void {
    this.busy.get(workspaceId)?.abort()
  }

  // Raw transcript messages for rehydrating the chat UI after a restart.
  async getHistory(workspaceId: string): Promise<unknown[]> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace?.sessionId) return []
    try {
      const messages = await getSessionMessages(workspace.sessionId, {
        dir: workspace.worktreePath
      })
      if (!this.activity.has(workspaceId)) {
        for (const msg of messages) {
          const m = msg as { type: string; message?: { content?: unknown } }
          if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
            for (const block of m.message.content as { type: string; text?: string }[]) {
              if (block.type === 'text' && block.text?.trim()) {
                this.pushActivity(workspaceId, `Claude: ${block.text.slice(0, 100)}`)
              }
            }
          }
        }
      }
      return messages
    } catch {
      // Session file may have been deleted; start fresh.
      return []
    }
  }

  private pushActivity(workspaceId: string, line: string): void {
    const list = this.activity.get(workspaceId) ?? []
    list.push(line)
    if (list.length > ACTIVITY_LIMIT) list.shift()
    this.activity.set(workspaceId, list)
  }

  async sendPrompt(workspaceId: string, text: string): Promise<void> {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    if (this.busy.has(workspaceId)) throw new Error('Session is busy with a previous prompt')

    const abort = new AbortController()
    this.busy.set(workspaceId, abort)
    this.send(IPC.EvSessionStatus, { workspaceId, status: 'busy' })
    this.pushActivity(workspaceId, `You: ${text.slice(0, 100)}`)

    try {
      const q = query({
        prompt: text,
        options: {
          cwd: workspace.worktreePath,
          resume: workspace.sessionId ?? undefined,
          // The SDK defaults to an EMPTY system prompt — without the preset the
          // model never sees the env block (working directory) and acts in the
          // wrong folder. settingSources restores CLAUDE.md loading.
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          // Under Electron the SDK would otherwise spawn process.execPath
          // (the Electron binary) as the JS runtime for its bundled CLI.
          executable: 'node',
          includePartialMessages: true,
          abortController: abort
        }
      })

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          // Session id changes on every resumed run — persist the latest.
          db.workspaces.setSessionId(workspaceId, msg.session_id)
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.pushActivity(workspaceId, `Claude: ${block.text.slice(0, 100)}`)
            } else if (block.type === 'tool_use') {
              this.pushActivity(workspaceId, `Tool: ${block.name}`)
            }
          }
        }
        this.send(IPC.EvSessionMessage, { workspaceId, message: msg })
      }
      this.send(IPC.EvSessionStatus, { workspaceId, status: 'idle' })
    } catch (err) {
      const aborted = abort.signal.aborted
      if (!aborted) {
        this.send(IPC.EvSessionMessage, {
          workspaceId,
          message: { type: 'orcha_error', text: err instanceof Error ? err.message : String(err) }
        })
      }
      this.send(IPC.EvSessionStatus, { workspaceId, status: aborted ? 'idle' : 'error' })
    } finally {
      this.busy.delete(workspaceId)
      this.onTurnComplete?.(workspaceId)
    }
  }
}
