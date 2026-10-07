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
import { claudeRelayEnv, isGuest, relayConfig } from '../guest'
import { codexModels } from '../catalog'
import { codexActivityAgeSeconds, codexRecentActivity } from '../codex'
import { claudeSdkBinary } from '../platform'
import { PROJECTS_ROOT, type ProjectService } from './ProjectService'
import type { WorkspaceManager } from './WorkspaceManager'
import type { PtyManager } from './PtyManager'
import type { GitService } from './GitService'
import type { Workspace } from '../../shared/types'

type SendFn = (channel: string, payload: unknown) => void

const KEY = 'orchestrator'
const SESSION_KEY = 'orchestrator_session_id'

// A session is "working" if its transcript changed in the last 30s.
const ACTIVE_WINDOW_S = 30

// Codex tabs keep their own session logs; everything else reads Claude's.
const activityAge = (w: Workspace): number | null =>
  w.agent === 'codex'
    ? codexActivityAgeSeconds(w.worktreePath)
    : lastActivityAgeSeconds(w.worktreePath)
const recentActivity = (w: Workspace, limit: number): string[] =>
  w.agent === 'codex'
    ? codexRecentActivity(w.worktreePath, limit)
    : readRecentActivity(w.worktreePath, limit)

const BRIEFING = `
You are Orcha's Mission Control: the coordinator for the user's fleet of Claude Code
terminal sessions. Each project tab is a live Claude Code TUI running in that project's
repo folder (full-auto permissions); parallel sessions on the same repo run in separate
git worktrees. Some tabs may run OpenAI Codex instead (\`agent: "codex"\` in list_sessions,
on a GPT model); you drive them exactly the same way.

Your MCP tools (server "orcha"):
- list_sessions: every open session with project, folder, git state, and whether it
  looks active (transcript written in the last ${ACTIVE_WINDOW_S}s).
- get_session_activity: recent transcript lines for one session.
- send_prompt_to_session: TYPE a prompt into that session's terminal (as if the user
  typed it). Async — the session works on its own; check activity later.
- create_project: create a brand-new GitHub repo, clone it under ${PROJECTS_ROOT},
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
                const age = activityAge(w)
                return {
                  session_id: w.id,
                  name: w.name,
                  agent: w.agent,
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
            const age = activityAge(workspace)
            return this.text({
              name: workspace.name,
              agent: workspace.agent,
              looks_active: age !== null && age < ACTIVE_WINDOW_S,
              recent: recentActivity(workspace, args.limit ?? 10)
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
          `Create a new GitHub repo, clone it under ${PROJECTS_ROOT}, open it as a session tab`,
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
            model: z
              .string()
              .optional()
              .describe(
                `Claude: opus, sonnet or haiku. Codex: ${codexModels().ids.join(', ') || 'none available'}`
              ),
            agent: z.enum(['claude', 'codex']).optional()
          },
          async (args) => {
            // Projects made for chats alone have no folder to work in.
            const code = db.projects.list().filter((p) => !p.chatOnly)
            const project = code.find(
              (p) => p.name.toLowerCase() === args.project_name.toLowerCase()
            )
            if (!project) {
              const names = code.map((p) => p.name)
              return this.text({
                error: `Unknown project "${args.project_name}". Valid: ${names.join(', ')}`
              })
            }
            const agent = args.agent ?? 'claude'
            if (agent === 'codex' && !relayConfig()) {
              return this.text({ error: 'Codex sessions need a relay (an invite, or your own).' })
            }
            const codex = codexModels()
            if (agent === 'codex' && args.model && !codex.ids.includes(args.model)) {
              return this.text({ error: `Unknown Codex model. Valid: ${codex.ids.join(', ')}` })
            }
            const workspace = await this.workspaceManager.create(
              project.id,
              args.session_name,
              args.model ?? null,
              null,
              agent
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
      // A guest's Mission Control bills their host's relay, on the cheapest
      // model: coordinating sessions doesn't need more, and it shouldn't eat
      // into the budget meant for the real work.
      const guest = isGuest()
      const q = query({
        prompt: text,
        options: {
          cwd: this.cwd,
          resume: db.appState.get(SESSION_KEY),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEFING },
          settingSources: ['user'],
          // Mission Control dispatches and coordinates; it doesn't need Opus.
          // Sonnet keeps it snappy and saves the usage window for real work.
          model: guest ? 'haiku' : 'sonnet',
          ...(guest
            ? {
                env: claudeRelayEnv(
                  { ...process.env } as Record<string, string>,
                  'Mission Control',
                  'mission-control'
                )
              }
            : { effort: 'medium' as const }),
          mcpServers: { orcha: this.buildServer() },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          executable: 'node',
          pathToClaudeCodeExecutable: claudeSdkBinary(),
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
