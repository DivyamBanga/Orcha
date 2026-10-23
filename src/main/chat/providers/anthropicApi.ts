import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaIterationsUsage,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatModel } from '../../../shared/ai'
import { specFor } from '../../../shared/models'
import {
  addTokens,
  NO_USAGE,
  TurnStopped,
  type FileLoader,
  type Provider,
  type ProviderTurn,
  type StopReason,
  type StreamEvent,
  type TokenUsage,
  type ToolRunner,
  type TurnResult
} from '../provider'
import { refusalOf, toProviderError } from './anthropicErrors'
import { completionRequest, requestFor } from './anthropicRequest'
import { Reply } from './anthropicStream'

// Claude on the owner's own Anthropic API keys: the Provider the chat uses for
// the "API" route. One provider per key; the key lives only in this closure.

const ANTHROPIC_URL = 'https://api.anthropic.com'

// The most model calls one turn makes: each tool use, and each time a long
// search pauses the turn, is another call.
const MAX_ROUNDS = 8

export interface ClientSettings {
  baseURL?: string
  fetch?: typeof fetch
  maxRetries?: number
  timeout?: number
}

// Rate limits and the monthly spend cap both arrive as 429. The SDK would wait
// out a long retry-after in silence and retry a spend cap that can't succeed,
// so 429s are marked not worth retrying and handed to the chat, which can
// offer another key. Everything else transient is retried by the SDK (twice).
function neverRetry429(send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await send(input, init)
    if (response.status !== 429) return response
    const headers = new Headers(response.headers)
    headers.set('x-should-retry', 'false')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }
}

export function anthropicClient(apiKey: string, settings: ClientSettings = {}): Anthropic {
  return new Anthropic({
    apiKey,
    // Always set: left out, the SDK follows ANTHROPIC_BASE_URL from the
    // environment, which would send the key to whatever that points at.
    baseURL: settings.baseURL ?? ANTHROPIC_URL,
    fetch: neverRetry429(settings.fetch ?? fetch),
    maxRetries: settings.maxRetries,
    timeout: settings.timeout
  })
}

// ---- usage ----

// One model call and what it used. A turn is usually one call per round; a
// refusal fallback makes two in one request, on different models and prices.
export interface ApiCall {
  model: string
  usage: TokenUsage
}

export interface ApiTurnResult extends TurnResult {
  calls: ApiCall[]
}

// The token fields a message's usage and each of its iterations share.
interface WireTokens {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
}

// Haiku 5.5 charges more for a request whose whole prompt, cached or not,
// passes a size.
function longPrompt(usage: TokenUsage, model: string): boolean {
  const above = specFor(model)?.price.long?.above
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
  return above !== undefined && prompt > above
}

function tokens(u: WireTokens, model: string): TokenUsage {
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const five = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  // Without the split, what was written had the 5-minute lifetime, which is
  // what these requests ask for.
  const written = Math.max(u.cache_creation_input_tokens ?? 0, hour + five)
  const usage: TokenUsage = {
    ...NO_USAGE,
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: written - hour,
    cacheWrite1h: hour,
    output: u.output_tokens ?? 0
  }
  usage.longContext = longPrompt(usage, model)
  return usage
}

function modelOf(iteration: BetaIterationsUsage[number], fallback: string): string {
  return 'model' in iteration && iteration.model ? iteration.model : fallback
}

// What a message cost, per attempt: when a refusal fallback or a long search
// ran, `iterations` lists every attempt and is what is billed (the top-level
// numbers describe only the one that produced the message).
function callsOf(message: BetaMessage): ApiCall[] {
  const u = message.usage
  const calls: ApiCall[] = u.iterations?.length
    ? u.iterations.map((it) => {
        const model = modelOf(it, message.model)
        return { model, usage: tokens(it, model) }
      })
    : [{ model: message.model, usage: tokens(u, message.model) }]
  // The reasoning split and the search count belong to the attempt that
  // produced the message, the last.
  const served = calls[calls.length - 1].usage
  served.reasoning = Math.min(u.output_tokens_details?.thinking_tokens ?? 0, served.output)
  served.webSearches = u.server_tool_use?.web_search_requests ?? 0
  return calls
}

function totalOf(calls: ApiCall[]): TokenUsage | null {
  return calls.reduce<TokenUsage | null>((sum, call) => addTokens(sum, { ...call.usage }), null)
}

// ---- the turn ----

// What goes back to Claude when its turn isn't over: exactly what it sent,
// thinking signatures and search records included. Left out: blocks with no
// words (the API refuses an empty one) and, when a refusal fallback took over
// mid-turn, what the declining model left before the hand-off (its thinking
// and tool calls, and any search it never got an answer to), as the API asks.
function echo(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const handoff = content.findLastIndex((b) => b.type === 'fallback')
  const answered = new Set(content.flatMap((b) => ('tool_use_id' in b ? [b.tool_use_id] : [])))
  return content.filter((b, i) => {
    if (b.type === 'text') return b.text.trim() !== ''
    if (i > handoff) return true
    if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use') {
      return false
    }
    if ((b.type as string) === 'connector_text') return false
    if (b.type === 'server_tool_use') return answered.has(b.id)
    return true
  }) as BetaContentBlockParam[]
}

// One at a time: a tool that asks before it changes something asks once, then
// the next. A tool that fails tells Claude so, and the turn goes on.
async function answers(
  uses: BetaToolUseBlock[],
  runTool: ToolRunner
): Promise<BetaToolResultBlockParam[]> {
  const results: BetaToolResultBlockParam[] = []
  for (const use of uses) {
    try {
      const content = await runTool({ name: use.name, input: use.input })
      results.push({ type: 'tool_result', tool_use_id: use.id, content })
    } catch (err) {
      const content = err instanceof Error ? err.message : String(err)
      results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: true })
    }
  }
  return results
}

// What follows when a turn isn't over: a search that paused is sent back as it
// was, with nothing added; tool calls are answered. Null when it is over.
async function continuation(
  final: BetaMessage,
  runTool: ToolRunner | undefined
): Promise<BetaMessageParam[] | null> {
  const assistant: BetaMessageParam = { role: 'assistant', content: echo(final.content) }
  if (final.stop_reason === 'pause_turn') return [assistant]
  if (final.stop_reason !== 'tool_use' || !runTool) return null
  const uses = final.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
  if (uses.length === 0) return null
  return [assistant, { role: 'user', content: await answers(uses, runTool) }]
}

const STOPS: Record<string, StopReason | undefined> = {
  max_tokens: 'max-tokens',
  model_context_window_exceeded: 'context-full'
}

async function runTurn(
  client: Anthropic,
  load: FileLoader,
  turn: ProviderTurn,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
  runTool?: ToolRunner
): Promise<ApiTurnResult> {
  // Orcha's tools are offered only when something can answer them.
  const answerable = turn.model.tools ? runTool : undefined
  const params = requestFor({ ...turn, tools: answerable ? turn.tools : [] }, load)
  const messages: BetaMessageParam[] = [...params.messages]
  const reply = new Reply(emit)
  const calls: ApiCall[] = []
  let live: BetaMessageStream | null = null
  let answeredBy: string | null = null
  let stop: StopReason = 'end'

  // Whatever there is so far, for a turn that is stopped. The call in flight
  // has told us its prompt, but not yet what it wrote.
  const snapshot = (): ApiTurnResult => {
    const current = live?.currentMessage
    const all = current ? [...calls, ...callsOf(current)] : calls
    return {
      text: reply.text,
      parts: reply.parts(),
      usage: totalOf(all),
      model: answeredBy ?? current?.model ?? null,
      stop,
      ttftMs: reply.ttftMs,
      calls: all
    }
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      reply.startRound(round)
      live = client.beta.messages.stream({ ...params, messages }, { signal })
      for await (const event of live) reply.handle(event)
      const final = await live.finalMessage()
      live = null
      calls.push(...callsOf(final))
      answeredBy = final.model
      // A refusal that a fallback model answered is an ordinary reply by the
      // time it gets here; one that stands is an error.
      if (final.stop_reason === 'refusal') throw refusalOf(final, totalOf(calls))
      stop = STOPS[final.stop_reason ?? ''] ?? 'end'
      if (round + 1 === MAX_ROUNDS) break
      const next = await continuation(final, answerable)
      if (!next) break
      messages.push(...next)
    }
    return snapshot()
  } catch (err) {
    if (err instanceof TurnStopped) throw err
    if (signal.aborted) throw new TurnStopped(snapshot())
    throw toProviderError(err, turn.model.apiModel)
  }
}

async function complete(
  client: Anthropic,
  model: ChatModel,
  system: string,
  prompt: string,
  opts?: { maxOutput?: number; signal?: AbortSignal }
): Promise<{ text: string; usage: TokenUsage | null }> {
  try {
    const params = completionRequest(model, system, prompt, opts?.maxOutput)
    const final = await client.beta.messages.stream(params, { signal: opts?.signal }).finalMessage()
    const usage = totalOf(callsOf(final))
    if (final.stop_reason === 'refusal') throw refusalOf(final, usage)
    const text = final.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
    return { text: text.join('').trim(), usage }
  } catch (err) {
    // The caller stopped it; that is not a failure to explain.
    if (opts?.signal?.aborted) throw err
    throw toProviderError(err, model.apiModel)
  }
}

export function anthropicApiProvider(opts: {
  apiKey: string
  load: FileLoader
  baseURL?: string
  fetch?: typeof fetch
}): Provider {
  const client = anthropicClient(opts.apiKey, { baseURL: opts.baseURL, fetch: opts.fetch })
  return {
    run: (turn, emit, signal, runTool) => runTurn(client, opts.load, turn, emit, signal, runTool),
    complete: (model, system, prompt, options) => complete(client, model, system, prompt, options)
  }
}
