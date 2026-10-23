import type { ChatModel } from '../../../shared/ai'
import { nearestEffort, type Effort, type Price } from '../../../shared/models'
import type { ChatSource } from '../../../shared/types'
import {
  addTokens,
  fileText,
  ProviderError,
  TurnStopped,
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

// GPT models on the owner's own Azure AI Foundry resource, called directly with
// his key over the Responses API: POST {endpoint}/openai/v1/responses, the key
// in an `api-key` header, no api-version, and the request's `model` is the
// deployment's name. Nothing is stored server-side (store: false), so every turn
// sends the conversation again, the way the other providers do.
//
// The request builder and event reader started from the relay version
// (responses.ts) and fix what that one gets wrong against Azure itself:
//  - a frame may end in CRLF, and one split between network chunks is rejoined;
//  - a stream that ends without its terminal event is an error, never a success;
//  - a failure mid-stream arrives as {type:'error', error:{...}} (the flat
//    {type:'error', message} form is read too), and response.failed carries one;
//  - response.incomplete ends the reply as 'max-tokens' (or a refusal) instead of
//    being treated as done, and a refusal's words are shown as the reply;
//  - cache writes, cache reads, reasoning and web searches are counted apart;
//  - effort, sampling and verbosity are sent only where the model accepts them.

// Model calls in one turn; each round of tool use is another call.
const MAX_ROUNDS = 8

// Azure sets aside rate-limit quota for the whole output allowance of a request,
// so asking for a model's full 128K when answers run a few thousand tokens
// invites 429s for nothing.
const MAX_OUTPUT = 64_000

const UNREACHABLE =
  "Couldn't reach Azure. Check the endpoint in Settings and your internet connection."
const CUT_OFF = 'The connection to Azure dropped before the reply finished. Try again.'
const TOO_MANY_ROUNDS = `The model asked for tools ${MAX_ROUNDS} times in a row without answering, so Orcha stopped it.`

type Json = Record<string, unknown>
type Item = Record<string, unknown>
type SseEvent = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function azureProvider(opts: {
  endpoint: string
  apiKey: string
  load: FileLoader
  fetch?: typeof fetch
}): Provider {
  const send = opts.fetch ?? fetch
  const url = `${opts.endpoint.replace(/\/+$/, '')}/openai/v1/responses`

  const post = async (body: Json, deployment: string, signal?: AbortSignal): Promise<Response> => {
    let res: Response
    try {
      res = await send(url, {
        method: 'POST',
        headers: { 'api-key': opts.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new ProviderError(UNREACHABLE, 'unreachable')
    }
    if (!res.ok) throw await httpError(res, deployment)
    return res
  }

  return {
    async run(turn, emit, signal, runTool) {
      const { model } = turn
      // Tools only go out when something is there to run them.
      const request = requestFor(runTool ? turn : { ...turn, tools: [] }, opts.load)
      let input = request.input as Item[]
      const reply = new Reply(model, emit)
      let stop: StopReason = 'end'
      try {
        // One model call per round; when it calls tools, what it output and the
        // tools' answers go back and it goes again.
        for (let n = 0; ; n++) {
          const res = await post({ ...request, input }, model.apiModel, signal)
          if (!res.body) throw new ProviderError(CUT_OFF, 'unreachable')
          const round: Round = { items: [], refused: false, stop: null }
          for await (const event of sseEvents(res.body)) reply.take(event, round)
          if (round.stop === null) throw new ProviderError(CUT_OFF, 'unreachable')
          stop = round.stop
          // A reply cut short may hold a half-written tool call: never run it.
          const calls = round.items.filter((i) => i.type === 'function_call')
          if (stop !== 'end' || calls.length === 0 || !runTool) break
          if (n === MAX_ROUNDS - 1) throw new ProviderError(TOO_MANY_ROUNDS, 'unknown')
          const answers: Item[] = []
          for (const call of calls) {
            answers.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: await runOne(call, runTool, signal)
            })
          }
          input = [...input, ...replayable(round.items), ...answers]
        }
      } catch (err) {
        if (signal.aborted) throw new TurnStopped(reply.result('end'))
        throw err
      }
      return reply.result(stop)
    },

    async complete(model, system, prompt, extra) {
      const { levels } = model.reasoning
      // A chore wants the plainest answer: no reasoning where the model can switch
      // it off, else the lowest level it has.
      const effort = levels.includes('none') ? 'none' : (levels[0] ?? null)
      // Thinking counts toward the cap, so a small one on a model that can't stop
      // thinking would leave no room for the answer.
      const room = Math.max(extra?.maxOutput ?? 400, effort && effort !== 'none' ? 2_000 : 0)
      const res = await post(
        {
          model: model.apiModel,
          store: false,
          input: [...developer(system), { role: 'user', content: prompt }],
          ...(effort ? { reasoning: { effort } } : {}),
          max_output_tokens: Math.min(model.maxOutput, room)
        },
        model.apiModel,
        extra?.signal
      )
      const body = (await res.json().catch(() => null)) as ResponseObject | null
      if (!body) throw new ProviderError("Azure's answer couldn't be read.", 'unknown')
      if (body.status === 'failed' || body.error) {
        throw providerError(null, errorFields({ error: body.error }), model.apiModel, null)
      }
      const text = (body.output ?? [])
        .flatMap((i) =>
          i.type === 'message' && Array.isArray(i.content) ? (i.content as Item[]) : []
        )
        .map((c) => (c.type === 'output_text' ? str(c.text) : ''))
        .join('')
        .trim()
      if (!text && body.status === 'incomplete') {
        throw new ProviderError('The model ran out of room before it wrote an answer.', 'unknown')
      }
      return { text, usage: tokensFrom(body, model.price) }
    }
  }
}

// ---- the request ----

// Whether temperature and top_p may go out: never on some models, always on
// others, and on GPT's reasoning models only while reasoning is off.
function allowsSampling(model: ChatModel, effort: Effort | null): boolean {
  if (model.sampling !== 'when-no-reasoning') return model.sampling === 'always'
  return (effort ?? model.reasoning.defaultLevel) === 'none'
}

function developer(system: string): Item[] {
  return system.trim() ? [{ role: 'developer', content: system }] : []
}

// Your message as Responses content: its files first (images and PDFs as data
// URLs, text inline), then what you wrote.
function userContent(m: HistoryMessage, load: FileLoader): Record<string, string>[] {
  const files = m.files.map((f): Record<string, string> => {
    const data = load(f)
    if ('text' in data) return { type: 'input_text', text: fileText(f.name, data.text) }
    return f.kind === 'image'
      ? { type: 'input_image', image_url: `data:${f.mime};base64,${data.base64}` }
      : {
          type: 'input_file',
          filename: f.name,
          file_data: `data:application/pdf;base64,${data.base64}`
        }
  })
  return m.text.trim() ? [...files, { type: 'input_text', text: m.text }] : files
}

// The streaming request for one turn. Earlier turns go back as their visible
// text only (provider.ts says why).
export function requestFor(turn: ProviderTurn, load: FileLoader): Json & { input: unknown[] } {
  const { model, settings } = turn
  const thinks = model.reasoning.levels.length > 0
  // An effort the model doesn't list (carried over from another model's scale, or
  // "none" on a model that can't switch thinking off) becomes the nearest it does.
  const effort =
    thinks && settings.effort ? nearestEffort(model.reasoning.levels, settings.effort) : null
  const sampling = allowsSampling(model, effort)
  const clientTools = model.tools ? turn.tools : []
  const tools = [
    ...(settings.webSearch && model.webSearch ? [{ type: 'web_search' }] : []),
    ...clientTools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.schema,
      // Tools come from MCP servers and arrive with whatever schema they have;
      // strict mode would refuse any that isn't written for it.
      strict: false
    }))
  ]
  return {
    model: model.apiModel,
    stream: true,
    store: false,
    input: [
      ...developer(turn.system),
      ...turn.history
        .filter((m) => (m.role === 'user' ? m.text.trim() || m.files.length > 0 : m.text.trim()))
        .map((m) =>
          m.role === 'user'
            ? { role: 'user', content: userContent(m, load) }
            : { role: 'assistant', content: [{ type: 'output_text', text: m.text }] }
        )
    ],
    max_output_tokens: Math.min(model.maxOutput, MAX_OUTPUT),
    ...(thinks ? { reasoning: { ...(effort ? { effort } : {}), summary: 'auto' } } : {}),
    ...(model.verbosity && settings.verbosity ? { text: { verbosity: settings.verbosity } } : {}),
    ...(sampling && settings.temperature !== null ? { temperature: settings.temperature } : {}),
    ...(sampling && settings.topP !== null ? { top_p: settings.topP } : {}),
    ...(tools.length ? { tools } : {}),
    // Nothing is stored server-side, so a reasoning model that calls a tool needs
    // its reasoning (encrypted) sent back with the answer. Models that don't
    // reason refuse the option.
    ...(thinks && clientTools.length ? { include: ['reasoning.encrypted_content'] } : {})
  }
}

// ---- tool rounds ----

// What goes back to the model with a round's tool answers: its words, its tool
// calls, and its reasoning when that carries the encrypted copy the model can
// resume from (one without it names an item Azure never stored, and is refused).
// The hosted search's own records stay out.
function replayable(items: Item[]): Item[] {
  return items.filter(
    (i) =>
      i.type === 'message' ||
      i.type === 'function_call' ||
      (i.type === 'reasoning' && Boolean(i.encrypted_content))
  )
}

// One tool call's answer, as text for the model. A tool that can't run says why
// instead of ending the reply.
async function runOne(call: Item, runTool: ToolRunner, signal: AbortSignal): Promise<string> {
  const name = str(call.name)
  let input: unknown
  try {
    input = JSON.parse(str(call.arguments) || '{}')
  } catch {
    return `${name} did not run: its arguments were not valid JSON.`
  }
  try {
    return await runTool({ name, input })
  } catch (err) {
    signal.throwIfAborted()
    return `${name} failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---- reading a reply ----

interface Round {
  items: Item[] // what the model output, for sending back with tool answers
  refused: boolean
  stop: StopReason | null // null until the terminal event arrives
}

interface ResponseObject {
  status?: string
  error?: { code?: unknown; message?: unknown } | null
  incomplete_details?: { reason?: string } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  } | null
  // Azure reports hosted web search here, outside `usage`.
  tool_usage?: { web_search?: { num_requests?: number } }
  output?: Item[]
}

// Token counts in the ledger's exclusive buckets. Cached and cache-written
// tokens are parts of the input count, so they come out of it.
function tokensFrom(response: ResponseObject | undefined, price: Price | null): TokenUsage | null {
  const u = response?.usage
  if (!u) return null
  const total = num(u.input_tokens)
  const cached = Math.min(num(u.input_tokens_details?.cached_tokens), total)
  const written = Math.min(num(u.input_tokens_details?.cache_write_tokens), total - cached)
  const output = num(u.output_tokens)
  return {
    input: total - cached - written,
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: written,
    output,
    reasoning: Math.min(num(u.output_tokens_details?.reasoning_tokens), output),
    webSearches: num(response?.tool_usage?.web_search?.num_requests),
    // The long-context rate applies to a request by the size of its whole input.
    longContext: price?.long ? total > price.long.above : false
  }
}

// Citation chips after a claim: " [1][3]", each a Markdown link to its source
// titled "cite" (which the chat draws as a chip, and Copy leaves out).
function citeMarks(numbers: number[], sources: ChatSource[]): string {
  return (
    ' ' +
    numbers
      .filter((n) => sources[n])
      .map((n) => `[${n + 1}](<${sources[n].url.replace(/[<>\s]/g, encodeURIComponent)}> "cite")`)
      .join('')
  )
}

// Everything a turn has produced so far, built up from its events.
class Reply {
  private text = ''
  private thinking = ''
  private thinkingStarted = 0
  private thinkingMs = 0
  private ttftMs: number | null = null
  private usage: TokenUsage | null = null
  private lastKey = ''
  private readonly sources: ChatSource[] = []
  private readonly cites: { key: string; end: number; n: number }[] = []
  // A citation's position counts from the start of its own message, so where
  // each message begins in the whole text is noted as it starts.
  private readonly starts = new Map<string, number>()
  private readonly startedAt = Date.now()

  constructor(
    private readonly model: ChatModel,
    private readonly emit: (event: StreamEvent) => void
  ) {}

  take(event: SseEvent, round: Round): void {
    const key = `${str(event.item_id)}:${num(event.content_index)}`
    switch (event.type) {
      case 'response.output_text.delta':
        this.words(str(event.delta), key)
        break
      case 'response.refusal.delta':
        round.refused = true
        this.words(str(event.delta), key)
        break
      case 'response.reasoning_summary_part.added':
        // Each part of a summary reads as a paragraph of its own.
        if (this.thinking) this.thought('\n\n')
        break
      case 'response.reasoning_summary_text.delta':
        this.thought(str(event.delta))
        break
      case 'response.web_search_call.in_progress':
        this.emit({ kind: 'tool', tool: { kind: 'search', label: 'Searching the web' } })
        break
      case 'response.output_text.annotation.added': {
        const a = event.annotation as
          { type?: string; url?: string; title?: string; end_index?: number } | undefined
        if (a?.type === 'url_citation' && a.url) this.cite(a.url, a.title, num(a.end_index), key)
        break
      }
      case 'response.output_item.done':
        if (event.item && typeof event.item === 'object') round.items.push(event.item as Item)
        break
      case 'response.queued':
        this.emit({ kind: 'status', status: 'queued' })
        break
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response as ResponseObject | undefined
        const tokens = tokensFrom(response, this.model.price)
        if (tokens) this.usage = addTokens(this.usage, tokens)
        const reason = response?.incomplete_details?.reason
        round.stop =
          reason === 'max_output_tokens'
            ? 'max-tokens'
            : round.refused || reason === 'content_filter'
              ? 'refusal'
              : 'end'
        break
      }
      case 'response.failed':
        throw streamFailure(
          errorFields({ error: (event.response as ResponseObject | undefined)?.error }),
          this.model.apiModel,
          null
        )
      case 'error': {
        const headers = (event.error as { headers?: Json } | undefined)?.headers
        throw streamFailure(
          errorFields(event),
          this.model.apiModel,
          retryAfter((name) => String(headers?.[name] ?? ''))
        )
      }
    }
  }

  private words(delta: string, key: string): void {
    if (!delta) return
    const now = Date.now()
    this.ttftMs ??= now - this.startedAt
    if (this.thinkingStarted && !this.thinkingMs) this.thinkingMs = now - this.thinkingStarted
    let out = delta
    let shift = 0
    // A new message (every later round has one) starts a new paragraph.
    if (this.lastKey && key !== this.lastKey && this.text.trim()) {
      const bare = delta.trimStart()
      out = '\n\n' + bare
      // The model's own positions count its leading whitespace, which was dropped.
      shift = 2 - (delta.length - bare.length)
    }
    this.lastKey = key
    if (!this.starts.has(key)) this.starts.set(key, this.text.length + shift)
    this.text += out
    this.emit({ kind: 'text', delta: out })
  }

  private thought(delta: string): void {
    const now = Date.now()
    this.ttftMs ??= now - this.startedAt
    this.thinkingStarted ||= now
    this.thinking += delta
    this.emit({ kind: 'thinking', delta })
  }

  private cite(url: string, title: string | undefined, end: number, key: string): void {
    let n = this.sources.findIndex((s) => s.url === url)
    if (n < 0) n = this.sources.push({ url, title: title || url }) - 1
    this.cites.push({ key, end, n })
  }

  // The text with a chip after each cited claim, put in from the end so the
  // positions before it stay right. (The live text catches up when the reply
  // finishes.)
  private cited(): string {
    const at = new Map<number, number[]>()
    for (const c of this.cites) {
      const pos = Math.min((this.starts.get(c.key) ?? 0) + c.end, this.text.length)
      at.set(pos, [...(at.get(pos) ?? []), c.n])
    }
    let out = this.text
    for (const pos of [...at.keys()].sort((a, b) => b - a)) {
      out = out.slice(0, pos) + citeMarks([...new Set(at.get(pos))], this.sources) + out.slice(pos)
    }
    return out
  }

  result(stop: StopReason): TurnResult {
    const ms = this.thinkingMs || (this.thinkingStarted ? Date.now() - this.thinkingStarted : 0)
    return {
      text: this.cited(),
      parts: {
        ...(this.thinking ? { thinking: { text: this.thinking, ms } } : {}),
        ...(this.sources.length ? { sources: this.sources } : {})
      },
      usage: this.usage,
      // Azure never swaps the model, so the one asked for is the one that answered.
      model: this.model.id,
      stop,
      ttftMs: this.ttftMs
    }
  }
}

// Server-sent events from a fetch body, as parsed `data:` payloads. Lines end in
// CRLF, LF or CR; a frame is the lines up to a blank one, so a frame split
// between chunks (or a CRLF split between them) is put back together first.
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let name = ''
  let data: string[] = []

  const frame = (): SseEvent | null => {
    const text = data.join('\n')
    const event = name
    data = []
    name = ''
    if (!text || text === '[DONE]') return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const out = parsed as SseEvent
      // The frame's own name stands in when the payload leaves its type out.
      if (typeof out.type !== 'string' && event) out.type = event
      return out
    } catch {
      return null // not JSON; skip
    }
  }
  const line = (text: string): SseEvent | null => {
    if (text === '') return frame()
    if (text.startsWith('data:')) data.push(text.slice(5).trimStart())
    else if (text.startsWith('event:')) name = text.slice(6).trim()
    return null // other fields and ":" comments (keep-alives) carry nothing
  }

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      // A CR at the very end waits for the next chunk, which may start with its LF.
      const end = /\r\n|\n|\r(?!$)/g
      let from = 0
      for (let m = end.exec(buffer); m; m = end.exec(buffer)) {
        const done = line(buffer.slice(from, m.index))
        from = m.index + m[0].length
        if (done) yield done
      }
      buffer = buffer.slice(from)
    }
  } catch {
    throw new ProviderError(CUT_OFF, 'unreachable')
  }
  // A stream may end on a last line with no terminator, or a frame with no
  // blank line after it.
  buffer = (buffer + decoder.decode()).replace(/\r$/, '')
  const last = (buffer ? line(buffer) : null) ?? frame()
  if (last) yield last
}

// ---- errors ----

interface ApiError {
  code: string
  type: string
  message: string
}

// The error in either shape Azure sends: {error:{code, message, type}} (the HTTP
// error body, and the nested form of a mid-stream failure) or the flat
// {code, message} of a plain error event.
function errorFields(body: unknown): ApiError {
  const root = (body && typeof body === 'object' ? body : {}) as Json
  const e = (root.error && typeof root.error === 'object' ? root.error : root) as Json
  return { code: String(e.code ?? ''), type: String(e.type ?? ''), message: str(e.message).trim() }
}

// A mid-stream error says what kind it is instead of an HTTP status.
const STATUS_OF_TYPE: Record<string, number> = {
  server_error: 500,
  too_many_requests: 429,
  forbidden: 403,
  user_error: 400
}

function streamFailure(
  e: ApiError,
  deployment: string,
  retryAfterMs: number | null
): ProviderError {
  return providerError(STATUS_OF_TYPE[e.type] ?? null, e, deployment, retryAfterMs)
}

async function httpError(res: Response, deployment: string): Promise<ProviderError> {
  let body: unknown = null
  try {
    body = JSON.parse(await res.text())
  } catch {
    // not JSON; the status alone says enough
  }
  return providerError(
    res.status,
    errorFields(body),
    deployment,
    retryAfter((name) => res.headers.get(name) ?? '')
  )
}

// How long Azure says to wait: retry-after-ms, else Retry-After (seconds or a date).
function retryAfter(header: (name: string) => string): number | null {
  const ms = header('retry-after-ms')
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Math.round(Number(ms))
  const after = header('retry-after')
  if (!after) return null
  if (Number.isFinite(Number(after)) && Number(after) >= 0) return Math.round(Number(after) * 1000)
  const at = Date.parse(after)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function providerError(
  status: number | null,
  e: ApiError,
  deployment: string,
  retryAfterMs: number | null
): ProviderError {
  const code = classify(status, e)
  return new ProviderError(
    sayError(code, status, e, deployment, retryAfterMs),
    code,
    retryAfterMs,
    status
  )
}

function classify(status: number | null, e: ApiError): ProviderErrorCode {
  const code = e.code.toLowerCase()
  if (
    code.includes('content_filter') ||
    code.includes('responsibleaipolicy') ||
    code.includes('misalignment') ||
    /content management policy/i.test(e.message)
  ) {
    return 'refused'
  }
  if (code === 'deploymentnotfound' || status === 404) return 'not-found'
  if (
    code === 'context_length_exceeded' ||
    /context length|context window|maximum context/i.test(e.message)
  ) {
    return 'context-full'
  }
  // Azure's shared capacity is full: waiting helps, a different key wouldn't.
  if (code === 'no_capacity') return 'overloaded'
  // Out of quota can come as a 429 too, but waiting won't fix it.
  if (status === 402 || code === 'insufficient_quota') return 'no-credit'
  if (status === 429 || code === 'rate_limit_exceeded' || e.type === 'too_many_requests') {
    return 'rate-limit'
  }
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || (status !== null && status >= 500) || code === 'server_error') {
    return 'overloaded'
  }
  if (status === 400 || status === 422 || e.type === 'user_error') return 'bad-request'
  return 'unknown'
}

// What the person reads, in plain words. Azure's own text is shown only where
// it is the one clue there is.
function sayError(
  code: ProviderErrorCode,
  status: number | null,
  e: ApiError,
  deployment: string,
  retryAfterMs: number | null
): string {
  const theirs = e.message.slice(0, 300)
  switch (code) {
    case 'auth':
      return status === 403
        ? 'Azure refused this request. The key may belong to a different resource, or the resource may only allow certain networks.'
        : "Azure didn't accept the API key. Check it in Settings, under Connections."
    case 'not-found':
      return `Azure couldn't find a deployment named "${deployment}". Check its name and the endpoint in Settings, under Connections.`
    case 'rate-limit': {
      const wait =
        retryAfterMs === null
          ? 'in a moment'
          : `in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds`
      return `Azure is limiting requests to "${deployment}" right now. Try again ${wait}.`
    }
    case 'overloaded':
      return 'Azure is busy right now. Try again in a moment.'
    case 'no-credit':
      return 'Azure says this subscription is out of quota or credit.'
    case 'refused':
      return e.code.toLowerCase().includes('misalignment')
        ? "Azure's safety review stopped this conversation. Start a new chat to continue."
        : "Azure's content filter blocked this message. Try rephrasing it."
    case 'context-full':
      return 'This conversation is longer than the model can read. Start a new chat, or let Orcha shorten it.'
    case 'bad-request':
      return theirs ? `Azure rejected the request: ${theirs}` : 'Azure rejected the request.'
    default:
      return theirs || 'Azure returned an unexpected error.'
  }
}
