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
  type EffortLevel,
  type ModelUsage,
  type Options,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SdkMcpToolDefinition,
  type SDKUserMessage,
  type ThinkingConfig
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatModel } from '../../../shared/ai'
import { effortLevels, hasThinkingSwitch, nearestEffort, type Effort } from '../../../shared/models'
import type { ChatSource } from '../../../shared/types'
import {
  fileText,
  ProviderError,
  TurnStopped,
  type ClientTool,
  type FileLoader,
  type HistoryMessage,
  type Provider,
  type ProviderErrorCode,
  type ProviderTurn,
  type StopReason,
  type StreamEvent,
  type TokenUsage,
  type ToolRunner,
  type TurnResult
} from '../provider'

// Claude on the owner's Max plan, through the Claude Agent SDK: never an API
// key, never a relay. Each chat is a Claude Code session on disk, and a reply
// resumes it at the reply before, so a branch (an edit, a retry) sees only its
// own path; the session holds the whole tree, like the chat. Sessions are run
// from `dir` (in Orcha's own data), which is how Claude Code files them: under
// ~/.claude/projects/, by that folder. An incognito turn is the exception: it
// gets a session of its own that is written nowhere, with the conversation so
// far in the message.

// The most model calls one reply makes (each search or tool use is another).
const MAX_ROUNDS = 6

// Models that take a fixed thinking budget instead of thinking adaptively
// (Haiku 4.5) get this many tokens.
const THINKING_BUDGET = 8_000

// Models Claude Code keeps thinking on for, whatever it is asked: its own
// model list (Claude Code 2.1.309, bundled with Agent SDK 0.3.309) marks them
// as rejecting `disabled`, so it turns that into adaptive thinking. models.ts
// follows the API, where Haiku 5.5 can be switched off; Sonnet 5.5 is covered
// by its 'between_tools' mode, which the Agent SDK can't ask for either.
const KEEPS_THINKING = new Set(['claude-haiku-5-5'])

const NOT_ON_PLAN =
  'Claude in chat runs on your Claude plan, but Claude Code on this computer is set up to use an API key instead. Sign in with your Claude account (type /login in a Claude tab), then try again.'
const SIGNED_OUT =
  'Claude isn’t signed in on this computer. Sign in from a Claude tab (type /login), then try again.'
const STOPPED_EARLY = 'Claude stopped before it finished. Try again.'
const TOO_MANY_STEPS = 'That took more steps than one reply allows; ask it to carry on.'
const LIMIT_REACHED = 'You’ve reached the limit of your Claude plan for now.'

// This computer's environment minus anything that could point Claude Code at
// an API key or another provider; what's left is its own sign-in.
function planEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !/^(CLAUDE|ANTHROPIC)/i.test(e[0])
    )
  )
}

// The SDK calls this provider makes, so tests can stand in for Claude Code.
export interface PlanSdk {
  query(params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }): AsyncIterable<SDKMessage>
  getSessionMessages(id: string, options: { dir: string }): Promise<{ uuid: string }[]>
  forkSession(
    id: string,
    options: { dir: string; upToMessageId: string }
  ): Promise<{ sessionId: string }>
  deleteSession(id: string, options: { dir: string }): Promise<void>
}

const REAL_SDK: PlanSdk = { query, getSessionMessages, forkSession, deleteSession }

// ---- thinking and effort ----

const SDK_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

function sdkEffort(effort: Effort | null): EffortLevel | undefined {
  return SDK_EFFORTS.find((level) => level === effort)
}

// How a turn asks Claude Code to think and how hard. This follows the API's
// rules in models.ts wherever the Agent SDK can say the same thing:
//  - thinking that can't be switched off is always adaptive;
//  - otherwise the Thinking switch picks adaptive or off. Off is an explicit
//    'disabled', also for the models the API says to leave `thinking` out for,
//    because Claude Code thinks adaptively unless it is told not to;
//  - Haiku 4.5 thinks with a fixed budget;
//  - the effort is the one asked for (or the model's default), kept to a level
//    the model takes, and to its cap while thinking is off.
// Where Claude Code can't turn thinking off (see KEEPS_THINKING), "off" means
// the lowest effort with the reasoning left out of sight.
export function reasoningFor(
  model: ChatModel,
  want: { thinking: boolean; effort: Effort | null }
): { thinking: ThinkingConfig; effort?: EffortLevel } {
  const r = model.reasoning
  const off = hasThinkingSwitch(r) && !want.thinking
  const stuckOn = off && (r.off === 'between_tools' || KEEPS_THINKING.has(model.spec ?? ''))
  const wanted = stuckOn ? 'low' : (want.effort ?? r.defaultLevel)
  const level = wanted ? nearestEffort(effortLevels(r, off && !stuckOn), wanted) : null
  const effort = sdkEffort(level)

  let thinking: ThinkingConfig = { type: 'adaptive', display: 'summarized' }
  if (stuckOn) thinking = { type: 'adaptive', display: 'omitted' }
  else if (off) thinking = { type: 'disabled' }
  else if (r.budgetOnly) {
    thinking = { type: 'enabled', budgetTokens: THINKING_BUDGET, display: 'summarized' }
  }
  return { thinking, ...(effort ? { effort } : {}) }
}

// ---- tools ----

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

// Orcha's tools as Claude Code sees them. The runner may take a while (it asks
// first for anything that changes something), and when it fails the model is
// told so instead of the whole reply ending.
export function planTools(
  tools: ClientTool[],
  runTool: ToolRunner
): SdkMcpToolDefinition<Record<string, z.ZodType>>[] {
  return tools.map((t) =>
    tool(t.name, t.description, zodShape(t.schema), async (input) => {
      try {
        const text = await runTool({ name: t.name, input })
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        return { isError: true, content: [{ type: 'text' as const, text }] }
      }
    })
  )
}

// ---- where a reply goes ----

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
async function place(
  sdk: PlanSdk,
  session: { id: string; at: string | null },
  dir: string
): Promise<Placement> {
  if (!session.at) return { id: session.id, at: null, fresh: true }
  const newest = await sdk.getSessionMessages(session.id, { dir }).catch(() => [])
  if (newest.some((m) => m.uuid === session.at)) return { ...session, fresh: false }
  if (newest.length === 0) return { id: session.id, at: null, fresh: true }
  try {
    const fork = await sdk.forkSession(session.id, { dir, upToMessageId: session.at })
    return { id: fork.sessionId, at: null, fresh: false }
  } catch {
    return { id: randomUUID(), at: null, fresh: true }
  }
}

// What's sent: the new message, after the conversation so far written out
// when the session starts afresh.
export function promptFor(
  history: HistoryMessage[],
  load: FileLoader,
  resuming: boolean
): SDKUserMessage {
  const last = history[history.length - 1]
  type Blocks = Exclude<SDKUserMessage['message']['content'], string>
  const blocks: Blocks = last.files.map((f): Blocks[number] => {
    const data = load(f)
    if ('text' in data) return { type: 'text', text: fileText(f.name, data.text) }
    return f.kind === 'image'
      ? {
          type: 'image',
          source: { type: 'base64', media_type: f.mime as 'image/png', data: data.base64 }
        }
      : {
          type: 'document',
          title: f.name,
          source: { type: 'base64', media_type: 'application/pdf', data: data.base64 }
        }
  })
  if (last.text.trim() || blocks.length === 0) blocks.push({ type: 'text', text: last.text })

  const earlier = resuming
    ? []
    : history.slice(0, -1).filter((m) => m.text.trim() || m.files.length > 0)
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
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: blocks } }
}

// ---- the turn's settings ----

// What every Claude Code run here has in common. Nothing of this computer's
// Claude Code setup comes in (CLAUDE.md, hooks, settings, MCP servers, other
// tools), and what the person wrote reaches the model as written: Claude Code
// would otherwise run a message starting with "/" as one of its own commands
// and read any file named with an "@".
function isolated(): Options {
  return {
    settingSources: [],
    strictMcpConfig: true,
    verbatimPrompts: true,
    permissionMode: 'dontAsk',
    includePartialMessages: true
  }
}

export function optionsFor(turn: ProviderTurn, placement: Placement): Options {
  const { model, settings } = turn
  const search = settings.webSearch && model.webSearch
  const options: Options = {
    ...isolated(),
    model: model.apiModel,
    systemPrompt: turn.system,
    tools: search ? ['WebSearch'] : [],
    allowedTools: [
      ...(search ? ['WebSearch'] : []),
      ...turn.tools.map((t) => `mcp__orcha__${t.name}`)
    ],
    maxTurns: MAX_ROUNDS,
    ...reasoningFor(model, settings)
  }
  if (turn.incognito) {
    options.persistSession = false
  } else if (placement.fresh) {
    options.sessionId = placement.id
  } else {
    options.resume = placement.id
    if (placement.at) options.resumeSessionAt = placement.at
  }
  return options
}

// ---- usage ----

// Claude Code's own tally of every model call it made for a turn, per model.
// A web search is a call of its own, and only this has it. The field is not in
// the SDK's typings (it is on the result message of the Claude Code bundled
// with Agent SDK 0.3.309, described there as the thing to add up over a
// conversation), so it is read defensively. `modelUsage` is no use for this: it
// is cumulative, and starts from the whole session's totals when one is resumed.
function turnTally(result: SDKResultMessage): ModelUsage[] {
  const tally = (result as { model_usage_since_last_result?: Record<string, ModelUsage> })
    .model_usage_since_last_result
  return tally ? Object.values(tally) : []
}

// A turn's tokens as exclusive buckets (input leaves out the cache). Without
// the tally this is the main loop's own `usage`, which is per turn.
export function tokenUsage(result: SDKResultMessage): TokenUsage {
  const main = result.usage
  const calls = turnTally(result)
  const sum = (pick: (u: ModelUsage) => number): number =>
    calls.reduce((total, u) => total + pick(u), 0)
  const counts =
    calls.length > 0
      ? {
          input: sum((u) => u.inputTokens),
          output: sum((u) => u.outputTokens),
          reasoning: sum((u) => u.thinkingTokens ?? 0),
          cacheRead: sum((u) => u.cacheReadInputTokens),
          cacheWrite: sum((u) => u.cacheCreationInputTokens),
          webSearches: sum((u) => u.webSearchRequests)
        }
      : {
          input: main.input_tokens,
          output: main.output_tokens,
          reasoning: main.output_tokens_details?.thinking_tokens ?? 0,
          cacheRead: main.cache_read_input_tokens,
          cacheWrite: main.cache_creation_input_tokens,
          webSearches: main.server_tool_use?.web_search_requests ?? 0
        }
  // Only the main loop says how long its cache writes last; whatever else was
  // written is Claude Code's own default for a plan, the long one.
  const cacheWrite5m = Math.min(
    main.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    counts.cacheWrite
  )
  return {
    input: counts.input,
    cacheRead: counts.cacheRead,
    cacheWrite5m,
    cacheWrite1h: counts.cacheWrite - cacheWrite5m,
    cacheWrite: 0,
    output: counts.output,
    reasoning: Math.min(counts.reasoning, counts.output),
    webSearches: counts.webSearches,
    // The result doesn't say how big each request was, and a plan has no
    // dollars for the long-context rate to change.
    longContext: false
  }
}

// ---- errors ----

// What went wrong, as far as Claude Code says.
export interface PlanFailure {
  text: string
  // The type on the error message Claude Code wrote into the chat, if it did.
  kind?: SDKAssistantMessageError
  // The HTTP status behind it.
  status?: number | null
  // The latest word on the plan's limits.
  limit?: SDKRateLimitInfo | null
  // Why the turn ended (the result message's terminal_reason).
  terminal?: string
}

// Claude Code's errors, as plainly as possible.
function plain(text: string): string {
  return text
    .replace(/^Claude Code returned an error result: /, '')
    .replace(/^API Error: /, '')
    .trim()
}

const LOGGED_OUT = /not logged in|run \/login|invalid api key/i
const OUT_OF_CREDIT =
  /out of (extra )?usage|requires usage credits|usage credits required|(doesn['’]t|does not) include (extra )?usage|usage allocation has been disabled|usage limit is set to \$0/i
const LIMIT_HIT = /^you['’]ve (hit|reached) your/i
const TOO_LONG = /prompt is too long|context window|too many tokens/i
const OFFLINE = /unable to connect|econnrefused|enotfound|etimedout|fetch failed|network/i
const SIGN_IN_PROBLEMS: SDKAssistantMessageError[] = [
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error'
]

// The error to show, with what the chat can do about it: sign in ('auth'), try
// another route ('no-credit', 'rate-limit', with the time the plan's limit
// lifts when Claude Code says), wait ('overloaded'), or just read it.
export function planError(f: PlanFailure, now: number = Date.now()): ProviderError {
  const text = plain(f.text)
  const status = f.status ?? null
  const error = (
    code: ProviderErrorCode,
    message = text,
    retryAfterMs: number | null = null
  ): ProviderError => new ProviderError(message || STOPPED_EARLY, code, retryAfterMs, status)

  if (f.kind === 'authentication_failed' || status === 401 || LOGGED_OUT.test(text)) {
    return error('auth', SIGNED_OUT)
  }
  if ((f.kind && SIGN_IN_PROBLEMS.includes(f.kind)) || status === 403) return error('auth')
  if (f.kind === 'billing_error' || status === 402 || OUT_OF_CREDIT.test(text)) {
    return error('no-credit')
  }
  if (f.kind === 'rate_limit' || status === 429 || LIMIT_HIT.test(text)) {
    // `resetsAt` is in seconds.
    const resetsAt = f.limit?.status === 'rejected' ? f.limit.resetsAt : undefined
    const wait = resetsAt === undefined ? null : Math.max(0, resetsAt * 1000 - now)
    return new ProviderError(text || LIMIT_REACHED, 'rate-limit', wait, status ?? 429)
  }
  if (f.kind === 'overloaded' || status === 529) return error('overloaded')
  if (f.kind === 'model_not_found' || status === 404) return error('not-found')
  if (f.terminal === 'prompt_too_long' || TOO_LONG.test(text)) return error('context-full')
  if (f.kind === 'invalid_request' || (status !== null && status >= 400 && status < 500)) {
    return error('bad-request')
  }
  if (f.kind === 'server_error' || (status !== null && status >= 500) || OFFLINE.test(text)) {
    return error('unreachable')
  }
  return error('unknown')
}

// ---- one reply, as Claude Code reports it ----

// A turn's words, reasoning, sources and outcome, built up from Claude Code's
// messages one at a time. Kept apart from the SDK call so tests can feed it
// messages.
export class Reply {
  text = ''
  thinking = ''
  // The reply's last message, which the next one carries on from.
  at: string | null = null
  // What answered (a refusal fallback can differ from what was asked for).
  answeredBy: string | null = null
  ttftMs: number | null = null
  private thinkingStarted: number | null = null
  private thinkingMs = 0
  private startedAt: number
  // A later model call (after a search or a tool) starts a new paragraph.
  private calls = 0
  private opened = true
  private sources: ChatSource[] = []
  private searches = 0
  // The error message Claude Code wrote into the chat, if it did.
  private apiError: { kind: SDKAssistantMessageError; text: string } | null = null
  private limit: SDKRateLimitInfo | null = null
  private result: SDKResultMessage | null = null

  constructor(
    private emit: (event: StreamEvent) => void,
    private clock: () => number = () => performance.now()
  ) {
    this.startedAt = clock()
  }

  // Throws when Claude Code isn't signed in to the plan.
  handle(m: SDKMessage): void {
    if (m.type === 'system') {
      if (m.subtype === 'init' && m.apiKeySource !== 'none') {
        throw new ProviderError(NOT_ON_PLAN, 'auth')
      }
      // Waiting to try again (busy, or a limit that lifts soon), with nothing
      // on screen yet.
      if (m.subtype === 'api_retry' && !this.text && !this.thinking) {
        this.emit({ kind: 'status', status: 'queued', etaMs: m.retry_delay_ms })
      }
    } else if (m.type === 'rate_limit_event') {
      this.limit = m.rate_limit_info
    } else if (m.type === 'stream_event') {
      if (!m.parent_tool_use_id) this.stream(m.event)
    } else if (m.type === 'assistant') {
      if (!m.parent_tool_use_id) this.assistant(m)
    } else if (m.type === 'user') {
      this.found(m.tool_use_result)
    } else if (m.type === 'result') {
      this.result = m
    }
  }

  private stream(e: SDKPartialAssistantMessage['event']): void {
    if (e.type === 'message_start') {
      if (this.calls++ > 0) this.opened = false
    } else if (e.type === 'content_block_start') {
      if (e.content_block.type === 'tool_use' && e.content_block.name === 'WebSearch') {
        this.emit({ kind: 'tool', tool: { kind: 'search', label: 'Searching the web' } })
      }
    } else if (e.type === 'content_block_delta') {
      if (e.delta.type === 'thinking_delta') {
        this.ttftMs ??= Math.round(this.clock() - this.startedAt)
        this.thinkingStarted ??= this.clock()
        this.thinking += e.delta.thinking
        this.emit({ kind: 'thinking', delta: e.delta.thinking })
      } else if (e.delta.type === 'text_delta') {
        this.ttftMs ??= Math.round(this.clock() - this.startedAt)
        if (this.thinkingStarted !== null && !this.thinkingMs) {
          this.thinkingMs = Math.round(this.clock() - this.thinkingStarted)
        }
        let delta = e.delta.text
        if (!this.opened && this.text.trim()) delta = '\n\n' + delta.trimStart()
        this.opened = true
        this.text += delta
        this.emit({ kind: 'text', delta })
      }
    }
  }

  private assistant(m: SDKAssistantMessage): void {
    if (m.error) {
      // Claude Code's own account of an API error, not something the model said.
      const text = m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      this.apiError = { kind: m.error, text }
    } else {
      this.at = m.uuid
      this.answeredBy = m.message.model
    }
  }

  // A search's results: { results: [{ content: [{ title, url }] }, "summary"],
  // searchCount }.
  private found(output: unknown): void {
    const search = output as { results?: unknown; searchCount?: unknown } | null | undefined
    const results = search?.results
    if (!Array.isArray(results)) return
    this.searches += typeof search?.searchCount === 'number' ? search.searchCount : 1
    for (const r of results) {
      const links = (r as { content?: { title?: string; url?: string }[] })?.content
      for (const link of Array.isArray(links) ? links : []) {
        if (link?.url && !this.sources.some((s) => s.url === link.url)) {
          this.sources.push({ url: link.url, title: link.title || link.url })
        }
      }
    }
  }

  // Whatever has come so far, for a reply that was stopped.
  partial(): TurnResult {
    const thinkingMs =
      this.thinkingMs ||
      (this.thinkingStarted === null ? 0 : Math.round(this.clock() - this.thinkingStarted))
    return {
      text: this.text,
      parts: {
        ...(this.thinking ? { thinking: { text: this.thinking, ms: thinkingMs } } : {}),
        ...(this.sources.length ? { sources: this.sources } : {})
      },
      usage: null,
      model: this.answeredBy,
      stop: 'end',
      ttftMs: this.ttftMs
    }
  }

  // How the turn ended; throws if it failed.
  finish(now: number = Date.now()): TurnResult {
    const r = this.result
    if (!r) {
      const text = this.apiError?.text || STOPPED_EARLY
      throw planError({ text, kind: this.apiError?.kind, limit: this.limit }, now)
    }
    const stop = this.stopReason(r)
    // A reply cut off by the output limit, or declined, still has its words.
    if ((r.is_error || r.subtype !== 'success') && stop === 'end') {
      throw planError(
        {
          text: this.apiError?.text || failureText(r),
          kind: this.apiError?.kind,
          status: r.subtype === 'success' ? r.api_error_status : undefined,
          limit: this.limit,
          terminal: r.terminal_reason
        },
        now
      )
    }
    const usage = tokenUsage(r)
    // A search that only the main loop's numbers know of (no tally).
    usage.webSearches = Math.max(usage.webSearches, this.searches)
    return { ...this.partial(), usage, stop }
  }

  private stopReason(r: SDKResultMessage): StopReason {
    if (r.stop_reason === 'refusal') return 'refusal'
    if (r.stop_reason === 'max_tokens' || this.apiError?.kind === 'max_output_tokens') {
      return 'max-tokens'
    }
    if (r.stop_reason === 'model_context_window_exceeded') return 'context-full'
    return 'end'
  }
}

function failureText(r: SDKResultMessage): string {
  if (r.subtype === 'success') return r.result
  if (r.subtype === 'error_max_turns') return TOO_MANY_STEPS
  return r.errors.join(' ')
}

// Feeds a run's messages to its reply; stops the run if the reply says to.
async function follow(
  messages: AsyncIterable<SDKMessage>,
  reply: Reply,
  abort: AbortController
): Promise<void> {
  for await (const m of messages) {
    try {
      reply.handle(m)
    } catch (err) {
      abort.abort()
      throw err
    }
  }
}

// ---- the provider ----

export interface ClaudePlanOptions {
  load: FileLoader
  // The Claude Code that ships in the packaged app (see claudeSdkBinary in
  // platform.ts); the SDK finds its own in development.
  binary?: string
  // Where chat sessions live.
  dir: string
  // Tests give their own.
  sdk?: PlanSdk
}

export function claudePlanProvider(opts: ClaudePlanOptions): Provider {
  const { load, binary, dir } = opts
  const sdk = opts.sdk ?? REAL_SDK
  const spawn = (): Options => ({
    cwd: dir,
    env: planEnv(),
    executable: 'node',
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {})
  })

  return {
    async run(turn, emit, signal, runTool) {
      mkdirSync(dir, { recursive: true })
      const incognito = turn.incognito === true
      const placement: Placement =
        turn.session && !incognito
          ? await place(sdk, turn.session, dir)
          : { id: randomUUID(), at: null, fresh: true }
      const abort = new AbortController()
      const stop = (): void => abort.abort()
      signal.addEventListener('abort', stop)
      // (Stopped while the session was being found.)
      if (signal.aborted) abort.abort()

      const reply = new Reply(emit)
      const withSession = (result: TurnResult): TurnResult =>
        incognito ? result : { ...result, session: { id: placement.id, at: reply.at } }

      async function* prompt(): AsyncGenerator<SDKUserMessage> {
        yield promptFor(turn.history, load, !placement.fresh)
      }
      try {
        const messages = sdk.query({
          prompt: prompt(),
          options: {
            ...optionsFor(turn, placement),
            ...spawn(),
            abortController: abort,
            ...(runTool && turn.tools.length
              ? {
                  mcpServers: {
                    orcha: createSdkMcpServer({
                      name: 'orcha',
                      tools: planTools(turn.tools, runTool)
                    })
                  }
                }
              : {})
          }
        })
        await follow(messages, reply, abort)
        if (signal.aborted) throw new TurnStopped(withSession(reply.partial()))
        return withSession(reply.finish())
      } catch (err) {
        if (signal.aborted) throw new TurnStopped(withSession(reply.partial()))
        // A session made for this reply alone (a copy, or a fresh one) goes
        // with it.
        if (!incognito && placement.id !== turn.session?.id) {
          await sdk.deleteSession(placement.id, { dir }).catch(() => {})
        }
        throw err instanceof ProviderError
          ? err
          : planError({ text: err instanceof Error ? err.message : String(err) })
      } finally {
        signal.removeEventListener('abort', stop)
      }
    },

    // Chores (titles, summaries): one call, no tools, as little thinking as
    // the model allows, and nothing kept. The Agent SDK has no limit on the
    // length of the answer, so `maxOutput` isn't applied.
    async complete(model, system, prompt, extra) {
      mkdirSync(dir, { recursive: true })
      const abort = new AbortController()
      const stop = (): void => abort.abort()
      extra?.signal?.addEventListener('abort', stop)
      if (extra?.signal?.aborted) abort.abort()

      const reply = new Reply(() => {})
      try {
        const messages = sdk.query({
          prompt,
          options: {
            ...isolated(),
            model: model.apiModel,
            systemPrompt: system,
            tools: [],
            maxTurns: 1,
            persistSession: false,
            ...reasoningFor(model, { thinking: false, effort: 'low' }),
            ...spawn(),
            abortController: abort
          }
        })
        await follow(messages, reply, abort)
        const { text, usage } = reply.finish()
        return { text: text.trim(), usage }
      } catch (err) {
        if (extra?.signal?.aborted) throw err
        throw err instanceof ProviderError
          ? err
          : planError({ text: err instanceof Error ? err.message : String(err) })
      } finally {
        extra?.signal?.removeEventListener('abort', stop)
      }
    }
  }
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
