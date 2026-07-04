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
import { lastActivityAgeSeconds, readRecentActivity } from '../claudeSessions'
import type { WorkspaceManager } from './WorkspaceManager'
import type { PtyManager } from './PtyManager'
import type { GitService } from './GitService'
import type { ProjectService } from './ProjectService'

type SendFn = (channel: string, payload: unknown) => void

const KEY = 'orchestrator'
const SESSION_KEY = 'orchestrator_session_id'

// A session is "working" if its transcript changed in the last 30s.
const ACTIVE_WINDOW_S = 30

const BRIEFING = `
You are Orcha's Mission Control: the coordinator for the user's fleet of Claude Code
terminal sessions. Each project tab is a live Claude Code TUI running in that project's
repo folder (full-auto permissions); parallel sessions on the same repo run in separate
git worktrees.

Your MCP tools (server "orcha"):
- list_sessions: every open session with project, folder, git state, and whether it
  looks active (transcript written in the last ${ACTIVE_WINDOW_S}s).
- get_session_activity: recent transcript lines for one session.
- send_prompt_to_session: TYPE a prompt into that session's terminal (as if the user
  typed it). Async — the session works on its own; check activity later.
- create_project: create a brand-new GitHub repo, clone it under Desktop\\Projects,
  and open it as a session tab; optionally send it an initial prompt.
- create_parallel_session: add a worktree session (own branch) to an existing project
  for parallel work; optionally send an initial prompt.

Guidelines: one independent task per session. When asked "what's everyone doing",
list sessions then pull activity for the busy ones. You coordinate; you don't edit
files yourself.
`.trim()

export class OrchestratorService {
  private abort: AbortController | null = null
  private cwd = join(homedir(), '.orcha', 'orchestrator')

  constructor(
    private send: SendFn,
    private workspaceManager: WorkspaceManager,
    private ptyManager: PtyManager,
    private gitService: GitService,
    private projectService: ProjectService
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
        tool(
          'list_sessions',
          'List all session tabs with project, folder, git state, and activity',
          {},
          async () => {
            const projects = new Map(db.projects.list().map((p) => [p.id, p.name]))
            const rows = await Promise.all(
              db.workspaces.listActive().map(async (w) => {
                const age = lastActivityAgeSeconds(w.worktreePath)
                return {
                  session_id: w.id,
                  name: w.name,
                  project: projects.get(w.projectId) ?? 'unknown',
                  kind: w.kind,
                  folder: w.worktreePath,
                  terminal_open: this.ptyManager.has(w.id),
                  looks_active: age !== null && age < ACTIVE_WINDOW_S,
                  last_transcript_write_s_ago: age === null ? null : Math.round(age),
                  git: await this.gitService.status(w.id).catch(() => null)
                }
              })
            )
            return this.text(rows)
          }
        ),

        tool(
          'get_session_activity',
          'Recent transcript lines for one session',
          { session_id: z.string(), limit: z.number().optional() },
          async (args) => {
            const workspace = db.workspaces.get(args.session_id)
            if (!workspace) return this.text({ error: `Unknown session: ${args.session_id}` })
            const age = lastActivityAgeSeconds(workspace.worktreePath)
            return this.text({
              name: workspace.name,
              looks_active: age !== null && age < ACTIVE_WINDOW_S,
              recent: readRecentActivity(workspace.worktreePath, args.limit ?? 10)
            })
          }
        ),

        tool(
          'send_prompt_to_session',
          'Type a prompt into a session terminal. Async: returns once typed; the session works on its own.',
          { session_id: z.string(), prompt: z.string() },
          async (args) => {
            const workspace = db.workspaces.get(args.session_id)
            if (!workspace) return this.text({ error: `Unknown session: ${args.session_id}` })
            await this.ptyManager.dispatchPrompt(args.session_id, args.prompt)
            return this.text({ status: 'typed into terminal', session: workspace.name })
          }
        ),

        tool(
          'create_project',
          'Create a new GitHub repo, clone it under Desktop\\Projects, open it as a session tab',
          {
            name: z.string(),
            private: z.boolean().optional(),
            initial_prompt: z.string().optional()
          },
          async (args) => {
            const project = await this.projectService.createRepo(args.name, args.private ?? true)
            this.send(IPC.EvWorkspacesChanged, {})
            const main = db.workspaces
              .listActive()
              .find((w) => w.projectId === project.id && w.kind === 'main')
            if (args.initial_prompt && main) {
              this.ptyManager.dispatchPrompt(main.id, args.initial_prompt).catch(() => {})
            }
            return this.text({
              project: project.name,
              folder: project.repoPath,
              session_id: main?.id,
              dispatched: Boolean(args.initial_prompt)
            })
          }
        ),

        tool(
          'create_parallel_session',
          'Add a parallel worktree session (own branch) to an existing project',
          {
            project_name: z.string(),
            session_name: z.string(),
            initial_prompt: z.string().optional(),
            model: z.enum(['opus', 'sonnet', 'haiku']).optional()
          },
          async (args) => {
            const project = db.projects
              .list()
              .find((p) => p.name.toLowerCase() === args.project_name.toLowerCase())
            if (!project) {
              const names = db.projects.list().map((p) => p.name)
              return this.text({
                error: `Unknown project "${args.project_name}". Valid: ${names.join(', ')}`
              })
            }
            const workspace = await this.workspaceManager.create(
              project.id,
              args.session_name,
              args.model ?? null
            )
            this.send(IPC.EvWorkspacesChanged, {})
            if (args.initial_prompt) {
              this.ptyManager.dispatchPrompt(workspace.id, args.initial_prompt).catch(() => {})
            }
            return this.text({
              session_id: workspace.id,
              branch: workspace.branch,
              folder: workspace.worktreePath,
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
