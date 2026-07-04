import {
  query,
  getSessionMessages,
  createSdkMcpServer,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import type { WorkspaceManager } from './WorkspaceManager'
import type { SessionManager } from './SessionManager'
import type { GitService } from './GitService'

type SendFn = (channel: string, payload: unknown) => void

const KEY = 'orchestrator'
const SESSION_KEY = 'orchestrator_session_id'

const BRIEFING = `
You are Orcha's Mission Control: the orchestrator for a fleet of parallel Claude Code
sessions, each working in its own isolated git worktree ("workspace").

You have MCP tools (server "orcha") to command the fleet:
- list_workspaces: see every active workspace, its project, branch, busy/idle state, and git status.
- get_workspace_activity: recent activity lines for one workspace.
- send_prompt_to_workspace: dispatch a prompt to a workspace's Claude session. This is
  ASYNC — it returns immediately while the workspace works. Report what you kicked off;
  check activity later when asked.
- create_workspace: create a new workspace (worktree + branch) in a project, optionally
  dispatching an initial prompt.

Guidelines: prefer one workspace per independent task. When the user asks "what's
everyone doing", use list_workspaces then get_workspace_activity for the busy ones.
Don't edit files yourself — your job is coordinating the fleet, not coding.
`.trim()

export class OrchestratorService {
  private abort: AbortController | null = null
  private cwd = join(homedir(), '.orcha', 'orchestrator')

  constructor(
    private send: SendFn,
    private workspaceManager: WorkspaceManager,
    private sessionManager: SessionManager,
    private gitService: GitService
  ) {
    mkdirSync(this.cwd, { recursive: true })
  }

  isBusy(): boolean {
    return this.abort !== null
  }

  interrupt(): void {
    this.abort?.abort()
  }

  private text(payload: unknown): { content: [{ type: 'text'; text: string }] } {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  private buildServer(): ReturnType<typeof createSdkMcpServer> {
    return createSdkMcpServer({
      name: 'orcha',
      tools: [
        tool('list_workspaces', 'List all active workspaces with project, branch, session status, and git state', {}, async () => {
          const projects = new Map(db.projects.list().map((p) => [p.id, p.name]))
          const rows = await Promise.all(
            db.workspaces.listActive().map(async (w) => ({
              workspace_id: w.id,
              name: w.name,
              project: projects.get(w.projectId) ?? 'unknown',
              branch: w.branch,
              session_status: this.sessionManager.isBusy(w.id) ? 'busy' : 'idle',
              git: await this.gitService.status(w.id).catch(() => null),
              last_activity_at: w.lastActivityAt
            }))
          )
          return this.text(rows)
        }),

        tool(
          'get_workspace_activity',
          'Recent activity lines for one workspace session',
          { workspace_id: z.string(), limit: z.number().optional() },
          async (args) => {
            const workspace = db.workspaces.get(args.workspace_id)
            if (!workspace) return this.text({ error: `Unknown workspace: ${args.workspace_id}` })
            const lines = this.sessionManager.recentActivity(args.workspace_id)
            return this.text({
              name: workspace.name,
              session_status: this.sessionManager.isBusy(args.workspace_id) ? 'busy' : 'idle',
              recent: lines.slice(-(args.limit ?? 10))
            })
          }
        ),

        tool(
          'send_prompt_to_workspace',
          'Dispatch a prompt to a workspace session. Async: returns immediately while the workspace works.',
          { workspace_id: z.string(), prompt: z.string() },
          async (args) => {
            if (this.sessionManager.isBusy(args.workspace_id)) {
              return this.text({ status: 'busy', note: 'workspace is mid-turn; retry later' })
            }
            const workspace = db.workspaces.get(args.workspace_id)
            if (!workspace) return this.text({ error: `Unknown workspace: ${args.workspace_id}` })
            this.sessionManager.sendPrompt(args.workspace_id, args.prompt).catch(() => {})
            return this.text({ status: 'dispatched', workspace: workspace.name })
          }
        ),

        tool(
          'create_workspace',
          'Create a new workspace (git worktree + branch) in a project, optionally dispatching an initial prompt',
          {
            project_name: z.string(),
            workspace_name: z.string(),
            initial_prompt: z.string().optional()
          },
          async (args) => {
            const project = db.projects
              .list()
              .find((p) => p.name.toLowerCase() === args.project_name.toLowerCase())
            if (!project) {
              const names = db.projects.list().map((p) => p.name)
              return this.text({ error: `Unknown project "${args.project_name}". Valid: ${names.join(', ')}` })
            }
            const workspace = await this.workspaceManager.create(project.id, args.workspace_name)
            this.send(IPC.EvWorkspacesChanged, {})
            if (args.initial_prompt) {
              this.sessionManager.sendPrompt(workspace.id, args.initial_prompt).catch(() => {})
            }
            return this.text({
              workspace_id: workspace.id,
              branch: workspace.branch,
              worktree_path: workspace.worktreePath,
              dispatched: Boolean(args.initial_prompt)
            })
          }
        )
      ]
    })
  }

  async sendPrompt(text: string): Promise<void> {
    if (this.abort) throw new Error('Mission Control is busy with a previous prompt')

    const abort = new AbortController()
    this.abort = abort
    this.send(IPC.EvSessionStatus, { workspaceId: KEY, status: 'busy' })

    try {
      const q = query({
        prompt: text,
        options: {
          cwd: this.cwd,
          resume: db.appState.get(SESSION_KEY),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEFING },
          settingSources: ['user'],
          mcpServers: { orcha: this.buildServer() },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          executable: 'node',
          includePartialMessages: true,
          abortController: abort
        }
      })

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          db.appState.set(SESSION_KEY, msg.session_id)
        }
        this.send(IPC.EvSessionMessage, { workspaceId: KEY, message: msg })
      }
      this.send(IPC.EvSessionStatus, { workspaceId: KEY, status: 'idle' })
    } catch (err) {
      const aborted = abort.signal.aborted
      if (!aborted) {
        this.send(IPC.EvSessionMessage, {
          workspaceId: KEY,
          message: { type: 'orcha_error', text: err instanceof Error ? err.message : String(err) }
        })
      }
      this.send(IPC.EvSessionStatus, { workspaceId: KEY, status: aborted ? 'idle' : 'error' })
    } finally {
      this.abort = null
    }
  }

  async getHistory(): Promise<unknown[]> {
    const sessionId = db.appState.get(SESSION_KEY)
    if (!sessionId) return []
    try {
      return await getSessionMessages(sessionId, { dir: this.cwd })
    } catch {
      return []
    }
  }
}
