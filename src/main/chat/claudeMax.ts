import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import {
  createSdkMcpServer,
  deleteSession,
  forkSession,
  getSessionMessages,
  listSessions,
  query,
  tool,
  type Options,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatSource } from '../../shared/types'
import { userContent } from './anthropic'
import {
  MAX_ROUNDS,
  TurnAborted,
  type ChatAdapter,
  type ClientTool,
  type FileLoader,
  type ToolRunner,
  type TurnInput,
  type TurnResult
} from './adapter'

// Claude for the host, on their own Claude plan through the Agent SDK: never
// an API key, never the relay. Each chat is a Claude Code session on disk,
// and a reply resumes it at the reply before, so a branch (an edit, a retry)
// sees only its own path; the session holds the whole tree, like the chat.
// Sessions are run from `dir` (in Orcha's own data), which is how Claude
// Code files them: under ~/.claude/projects/, by that folder.

// This computer's environment minus anything that could point Claude Code at
// an API key or another provider; what's left is its own sign-in.
function planEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !/^(CLAUDE|ANTHROPIC)/i.test(e[0])
    )
  )
}

const NOT_ON_PLAN =
  'Claude in chat runs on your Claude plan, but Claude Code on this computer is set up to use an API key instead. Sign in with your Claude account (type /login in a Claude tab), then try again.'

// A client tool's JSON Schema (flat: strings, enums, numbers) as the shape the
// SDK's in-process tools take.
export function zodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: string; enum?: string[]; description?: string }
  >
  const required = new Set((schema.required ?? []) as string[])
  return Object.fromEntries(
    Object.entries(properties).map(([name, p]) => {
      let type: z.ZodType = p.enum
        ? z.enum(p.enum as [string, ...string[]])
        : p.type === 'integer'
          ? z.number().int()
          : p.type === 'number'
            ? z.number()
            : p.type === 'boolean'
              ? z.boolean()
              : z.string()
      if (p.description) type = type.describe(p.description)
      return [name, required.has(name) ? type : type.optional()]
    })
  )
}

function toolServer(tools: ClientTool[], runTool: ToolRunner): Options['mcpServers'] {
  return {
    orcha: createSdkMcpServer({
      name: 'orcha',
      tools: tools.map((t) =>
        tool(t.name, t.description, zodShape(t.schema), async (input) => ({
          content: [{ type: 'text' as const, text: runTool({ name: t.name, input }) }]
        }))
      )
    })
  }
}

// Where a reply goes among Claude Code's sessions.
export interface Placement {
  id: string
  // The message it carries on from (null: the session's newest).
  at: string | null
  // A session started afresh, with the conversation so far written out.
  fresh: boolean
}

// Claude Code resumes a session only from a message on its newest branch;
// from anywhere else (an earlier branch of the chat) the path is first copied
// into a session of its own. With nothing to carry on from (the first reply,
// or one after a reply that didn't finish), or a session that's gone, the
// reply starts afresh.
async function place(session: { id: string; at: string | null }, dir: string): Promise<Placement> {
  if (!session.at) return { id: session.id, at: null, fresh: true }
  const newest = await getSessionMessages(session.id, { dir }).catch(() => [])
  if (newest.some((m) => m.uuid === session.at)) return { ...session, fresh: false }
  if (newest.length === 0) return { id: session.id, at: null, fresh: true }
  try {
    const fork = await forkSession(session.id, { dir, upToMessageId: session.at })
    return { id: fork.sessionId, at: null, fresh: false }
  } catch {
    return { id: randomUUID(), at: null, fresh: true }
  }
}

// What's sent: the new message, after the conversation so far written out
// when the session starts afresh.
export function promptFor(turn: TurnInput, load: FileLoader, resuming: boolean): SDKUserMessage {
  const last = turn.history[turn.history.length - 1]
  const content = userContent(last, load)
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  const earlier = resuming
    ? []
    : turn.history.slice(0, -1).filter((m) => m.text.trim() || m.files.length > 0)
  if (earlier.length > 0) {
    const transcript = earlier
      .map((m) => {
        const files = m.files.length ? ` [attached: ${m.files.map((f) => f.name).join(', ')}]` : ''
        return `${m.role === 'user' ? 'Them' : 'You'}: ${m.text}${files}`
      })
      .join('\n\n')
    blocks.unshift({
      type: 'text',
      text: `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\nCarry on this conversation. Their new message:`
    })
  }
  return {
    type: 'user',
    parent_tool_use_id: null,
    // The same blocks the API takes (anthropic.ts builds them with its beta types).
    message: { role: 'user', content: blocks as SDKUserMessage['message']['content'] }
  }
}

// The turn's settings. Thinking follows the catalog the way it does for the
// API (anthropic.ts): "always" models think, and the toggle sets how hard.
export function optionsFor(turn: TurnInput, placement: Placement): Options {
  const { model } = turn
  const search = turn.webSearch && model.webSearch !== null
  const options: Options = {
    model: model.id,
    systemPrompt: turn.system,
    // Nothing of this computer's Claude Code setup (CLAUDE.md, hooks,
    // settings, other tools) comes in.
    settingSources: [],
    tools: search ? ['WebSearch'] : [],
    allowedTools: [
      ...(search ? ['WebSearch'] : []),
      ...(turn.tools ?? []).map((t) => `mcp__orcha__${t.name}`)
    ],
    permissionMode: 'dontAsk',
    maxTurns: MAX_ROUNDS,
    includePartialMessages: true
  }
  if (placement.fresh) {
    options.sessionId = placement.id
  } else {
    options.resume = placement.id
    if (placement.at) options.resumeSessionAt = placement.at
  }
  if (model.thinking === 'toggle') {
    options.thinking = turn.thinking
      ? { type: 'adaptive', display: 'summarized' }
      : { type: 'disabled' }
  } else if (model.thinking === 'always') {
    options.thinking = { type: 'adaptive', display: 'summarized' }
    options.effort = turn.thinking ? 'high' : 'low'
  } else if (model.thinking === 'budget') {
    options.thinking = turn.thinking
      ? { type: 'enabled', budgetTokens: 8_000, display: 'summarized' }
      : { type: 'disabled' }
  }
  return options
}

export function claudeMaxAdapter(
  load: FileLoader,
  binary: string | undefined,
  dir: string
): ChatAdapter {
  const spawn = { cwd: dir, env: planEnv(), executable: 'node' as const }
  if (binary) Object.assign(spawn, { pathToClaudeCodeExecutable: binary })

  return {
    async run(turn, emit, signal, runTool) {
      mkdirSync(dir, { recursive: true })
      const placement = turn.session
        ? await place(turn.session, dir)
        : { id: randomUUID(), at: null, fresh: true }
      const abort = new AbortController()
      const stop = (): void => abort.abort()
      signal.addEventListener('abort', stop)

      let text = ''
      let thinking = ''
      let thinkingStarted = 0
      let thinkingMs = 0
      let usage: TurnResult['usage'] = null
      let at: string | null = null
      const sources: ChatSource[] = []
      const partial = (): TurnResult => ({
        text,
        parts: {
          ...(thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {}),
          ...(sources.length ? { sources } : {})
        },
        usage,
        model: turn.model.id,
        session: { id: placement.id, at }
      })

      async function* prompt(): AsyncGenerator<SDKUserMessage> {
        yield promptFor(turn, load, !placement.fresh)
      }
      try {
        const q = query({
          prompt: prompt(),
          options: {
            ...optionsFor(turn, placement),
            ...spawn,
            abortController: abort,
            ...(runTool && turn.tools?.length
              ? { mcpServers: toolServer(turn.tools, runTool) }
              : {})
          }
        })
        // A later model call (after a search or a tool) starts a new paragraph.
        let calls = 0
        let opened = true
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            if (m.apiKeySource !== 'none') {
              abort.abort()
              throw new Error(NOT_ON_PLAN)
            }
          } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
            const e = m.event
            if (e.type === 'message_start') {
              if (calls++ > 0) opened = false
            } else if (
              e.type === 'content_block_start' &&
              e.content_block.type === 'tool_use' &&
              e.content_block.name === 'WebSearch'
            ) {
              emit({ kind: 'tool', tool: { kind: 'search', label: 'Searching the web' } })
            } else if (e.type === 'content_block_delta' && e.delta.type === 'thinking_delta') {
              if (!thinkingStarted) thinkingStarted = Date.now()
              thinking += e.delta.thinking
              emit({ kind: 'thinking', delta: e.delta.thinking })
            } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
              if (thinkingStarted && !thinkingMs) thinkingMs = Date.now() - thinkingStarted
              let delta = e.delta.text
              if (!opened && text.trim()) delta = '\n\n' + delta.trimStart()
              opened = true
              text += delta
              emit({ kind: 'text', delta })
            }
          } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            at = m.uuid
          } else if (m.type === 'user') {
            // A search's results: { results: [{ content: [{ title, url }] }, "summary"] }.
            const found = (m.tool_use_result as { results?: unknown[] } | undefined)?.results
            for (const r of Array.isArray(found) ? found : []) {
              const links = (r as { content?: { title?: string; url?: string }[] })?.content
              for (const link of Array.isArray(links) ? links : []) {
                if (link?.url && !sources.some((s) => s.url === link.url)) {
                  sources.push({ url: link.url, title: link.title || link.url })
                }
              }
            }
          } else if (m.type === 'result') {
            const u = m.usage
            usage = {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0
            }
            if (m.subtype === 'success' && m.is_error) throw new Error(m.result)
            if (m.subtype === 'error_max_turns') {
              throw new Error('That took more steps than one reply allows; ask it to carry on.')
            }
            if (m.subtype !== 'success') throw new Error(m.errors.join(' ') || 'Claude stopped.')
          }
        }
        return partial()
      } catch (err) {
        if (signal.aborted) throw new TurnAborted(partial())
        // A session made for this reply alone (a copy, or a fresh one) goes
        // with it.
        if (placement.id !== turn.session?.id) {
          await deleteSession(placement.id, { dir }).catch(() => {})
        }
        throw new Error(describe(err))
      } finally {
        signal.removeEventListener('abort', stop)
      }
    },

    async complete(model, system, prompt) {
      mkdirSync(dir, { recursive: true })
      let text = ''
      for await (const m of query({
        prompt,
        options: {
          model,
          systemPrompt: system,
          settingSources: [],
          tools: [],
          maxTurns: 1,
          thinking: { type: 'disabled' },
          persistSession: false,
          ...spawn
        }
      })) {
        if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource !== 'none') {
          throw new Error(NOT_ON_PLAN)
        }
        if (m.type === 'assistant') {
          for (const b of m.message.content) if (b.type === 'text') text += b.text
        }
      }
      return text.trim()
    }
  }
}

// Claude Code's errors, as plainly as possible.
function describe(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/^Claude Code returned an error result: /, '')
    .replace(/^API Error: /, '')
  if (message !== NOT_ON_PLAN && /\/login|not logged in|invalid api key/i.test(message)) {
    return 'Claude isn’t signed in on this computer. Sign in from a Claude tab (type /login), then try again.'
  }
  return message
}

// Deleting chats deletes their sessions too, so nothing of them stays behind.
export async function deleteSessions(dir: string, ids: string[]): Promise<void> {
  for (const id of ids) await deleteSession(id, { dir }).catch(() => {})
}

export async function deleteAllSessions(dir: string): Promise<void> {
  const all = await listSessions({ dir }).catch(() => [])
  await deleteSessions(
    dir,
    all.map((s) => s.sessionId)
  )
}
