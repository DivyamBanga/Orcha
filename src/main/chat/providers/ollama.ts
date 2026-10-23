import { z } from 'zod'
import type { ChatModel, LocalModel, TurnSettings } from '../../../shared/ai'
import { EFFORTS, nearestEffort, type Reasoning } from '../../../shared/models'
import {
  describeFailure,
  jsonPost,
  KEEP_ALIVE,
  OFFLINE,
  readNdjson
} from '../../connections/ollama'
import {
  addTokens,
  fileText,
  NO_USAGE,
  ProviderError,
  TurnStopped,
  type ClientTool,
  type FileLoader,
  type HistoryMessage,
  type Provider,
  type ProviderTurn,
  type StopReason,
  type TokenUsage,
  type ToolRunner,
  type TurnResult
} from '../provider'

// Local models through Ollama's own chat API (POST /api/chat, which streams
// one JSON object per line), not its OpenAI-style one: only this one takes
// num_ctx, keep_alive and think, and reports how long loading and reading
// the prompt took.

// The most model calls one turn makes (each tool use is another call).
const MAX_ROUNDS = 6
// How much a model may think before it is cut off and asked to answer
// without. A streamed chunk is about one token, so 1,500 is roughly 80
// seconds on a 4B model.
const DEFAULT_THINKING_BUDGET = 1500
// Titles and other chores: short, steady answers.
const CHORE_TOKENS = 512
const CHORE_TEMPERATURE = 0.3
// For guessing how long a prompt takes to read: prose runs about 3.2
// characters a token, and an image about 450 tokens once it is shrunk to 768 px.
const CHARS_PER_TOKEN = 3.2
const IMAGE_TOKENS = 450
// A tool's answer is cut here, because local context windows are small.
const MAX_TOOL_RESULT = 8000
// A shorter prompt says little about reading speed: the fixed cost of a
// request dominates it.
const MIN_SAMPLE_TOKENS = 100

export interface OllamaProviderOptions {
  baseURL: string // http://127.0.0.1:11434
  load: FileLoader
  contextFor: (model: string) => number // OllamaManager.contextFor
  fetch?: typeof fetch
  thinkingBudget?: number // tokens; default 1500
}

// ---- what Ollama sends and takes ----

interface ToolCall {
  id?: string
  function: { index?: number; name: string; arguments?: unknown }
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[] // raw base64: Ollama rejects a data: prefix
  thinking?: string
  tool_calls?: ToolCall[]
  tool_name?: string
}

interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

// One line of a reply. The last (done) line carries the counts, in tokens
// and nanoseconds.
interface Chunk {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }
  done?: boolean
  done_reason?: string
  error?: string
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_cached_count?: number
  prompt_eval_duration?: number
  eval_count?: number
}

type Think = boolean | string | undefined

// ---- thinking ----

// What the picker's Reasoning looks like for a local model, from how Ollama
// says it thinks (LocalModel.think): a Thinking switch that starts off for
// models that go on and off, the levels for models that take levels (which
// can't be switched off), nothing for models that don't think.
export function reasoningFor(think: LocalModel['think']): Reasoning {
  if (think === true) {
    return { levels: [], defaultLevel: null, off: 'disabled', offByDefault: true }
  }
  // Only the names Orcha has a place for, in order from least to most.
  const levels = Array.isArray(think) ? EFFORTS.filter((e) => think.includes(e)) : []
  if (levels.length === 0) return { levels: [], defaultLevel: null, off: null }
  return { levels, defaultLevel: levels.includes('medium') ? 'medium' : levels[0], off: null }
}

// What to send as `think`. Models that go on and off get the Thinking
// switch; models with levels get the effort (they can't be turned off);
// models that don't think get nothing, since asking one to think is an error.
export function thinkFor(reasoning: Reasoning, settings: TurnSettings): Think {
  if (reasoning.levels.length > 0) {
    const wanted = settings.effort ?? reasoning.defaultLevel ?? 'medium'
    return nearestEffort(reasoning.levels, wanted) ?? undefined
  }
  return reasoning.off === null ? undefined : settings.thinking
}

// As little thinking as the model allows, for chores.
function quietest(reasoning: Reasoning): Think {
  if (reasoning.levels.length > 0) return reasoning.levels[0]
  return reasoning.off === null ? undefined : false
}

// ---- the request ----

// The model as the picker offers it, for a model Ollama has installed.
export function localChatModel(model: LocalModel, ready = true): ChatModel {
  return {
    id: `ollama:${model.name}`,
    route: 'ollama',
    apiModel: model.name,
    label: model.name,
    description: [model.parameters, model.quantization, 'on this computer']
      .filter(Boolean)
      .join(' · '),
    spec: null,
    current: true,
    context: model.context,
    // Long answers take minutes on a laptop: a cap keeps one that runs away
    // from going on for ever.
    maxOutput: Math.min(8192, Math.floor(model.context / 2)),
    vision: model.capabilities.includes('vision'),
    pdf: false,
    tools: model.capabilities.includes('tools'),
    reasoning: reasoningFor(model.think),
    sampling: 'always',
    verbosity: false,
    webSearch: false,
    retains30d: false,
    price: null,
    ready
  }
}

// Ollama's own sampling for Qwen3 is the profile for thinking (temperature
// 1.0), which runs on and on once thinking is off. So unless the person chose
// otherwise, Qwen3 without thinking gets the model card's profile for that
// (temperature 0.7, top-p 0.8; the top-k and repeat penalty in Ollama's
// settings for the model already match it).
function sampling(
  model: string,
  settings: TurnSettings,
  thinking: boolean
): Record<string, number> {
  const card = /^qwen3/i.test(model) && !thinking
  const temperature = settings.temperature ?? (card ? 0.7 : null)
  const topP = settings.topP ?? (card ? 0.8 : null)
  return {
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { top_p: topP })
  }
}

// The conversation as Ollama's messages: the system prompt, then each message
// as its visible text with its files. Text files go inline, images as raw
// base64, and what a model can't read is said in a note so it can tell you.
// Images are only sent with the newest message: a model that re-reads the
// whole conversation every turn would otherwise pay for every image again
// (several seconds each), and its earlier replies already describe them.
export function chatMessages(turn: ProviderTurn, load: FileLoader): Message[] {
  const newest = turn.history.findLastIndex((m) => m.role === 'user')
  const messages: Message[] = turn.system.trim() ? [{ role: 'system', content: turn.system }] : []
  turn.history.forEach((m, i) => {
    if (!m.text.trim() && m.files.length === 0) return
    messages.push(
      m.role === 'user'
        ? userMessage(m, turn.model, load, i === newest)
        : { role: 'assistant', content: m.text }
    )
  })
  return messages
}

function userMessage(
  m: HistoryMessage,
  model: ChatModel,
  load: FileLoader,
  newest: boolean
): Message {
  const images: string[] = []
  const blocks: string[] = []
  for (const f of m.files) {
    if (f.kind === 'image' && !model.vision) {
      blocks.push(`[The image "${f.name}" was left out: this model can't see images.]`)
    } else if (f.kind === 'image' && !newest) {
      blocks.push(`[An image named "${f.name}" was attached here.]`)
    } else {
      const data = load(f)
      if ('text' in data) blocks.push(fileText(f.name, data.text))
      else if (f.kind === 'image') images.push(data.base64)
      else blocks.push(`[The file "${f.name}" was left out: this model can't read PDFs directly.]`)
    }
  }
  if (m.text.trim()) blocks.push(m.text)
  return { role: 'user', content: blocks.join('\n\n'), ...(images.length ? { images } : {}) }
}

const ollamaTools = (tools: ClientTool[]): OllamaTool[] =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema }
  }))

// The body of a chat request. num_ctx goes in every one: a model whose
// runner was loaded with another number is reloaded (5-6 seconds), and
// Ollama's default is only 4096 on this kind of computer.
export function chatBody(args: {
  model: ChatModel
  settings: TurnSettings
  messages: Message[]
  tools: OllamaTool[]
  think: Think
  numCtx: number
}): Record<string, unknown> {
  const { model, settings, think } = args
  return {
    model: model.apiModel,
    messages: args.messages,
    ...(args.tools.length ? { tools: args.tools } : {}),
    stream: true,
    ...(think === undefined ? {} : { think }),
    keep_alive: KEEP_ALIVE,
    options: {
      num_ctx: args.numCtx,
      ...sampling(model.apiModel, settings, think !== undefined && think !== false),
      ...(model.maxOutput > 0 ? { num_predict: model.maxOutput } : {})
    }
  }
}

// ---- the reply ----

interface Reply {
  content: string
  thinking: string
  thinkingChunks: number
  calls: ToolCall[]
  done: Chunk | null // null when the reply was cut off while still thinking
  cut: boolean
}

// Reads one streamed reply, handing words and reasoning on as they arrive.
// Past `cutAt` thinking chunks with no answer yet it stops reading, which
// closes the connection and so stops Ollama generating.
async function readReply(
  body: ReadableStream<Uint8Array>,
  model: string,
  cutAt: number | undefined,
  hooks: { thinking(delta: string): void; text(delta: string): void }
): Promise<Reply> {
  const reply: Reply = {
    content: '',
    thinking: '',
    thinkingChunks: 0,
    calls: [],
    done: null,
    cut: false
  }
  for await (const line of readNdjson(body)) {
    const chunk = line as Chunk
    // A reply that fails says so in a line of its own, after the 200.
    if (typeof chunk.error === 'string') {
      const { message, code } = describeFailure(200, chunk.error, model)
      throw new ProviderError(message, code)
    }
    const m = chunk.message
    if (m?.thinking) {
      reply.thinking += m.thinking
      reply.thinkingChunks++
      hooks.thinking(m.thinking)
      if (cutAt !== undefined && !reply.content && reply.thinkingChunks > cutAt) {
        reply.cut = true
        break
      }
    }
    if (m?.content) {
      reply.content += m.content
      hooks.text(m.content)
    }
    if (m?.tool_calls) reply.calls.push(...m.tool_calls)
    if (chunk.done) reply.done = chunk
  }
  return reply
}

// A model that used up its whole allowance thinking has no answer to show.
const ranOutThinking = (r: Reply): boolean =>
  r.done?.done_reason === 'length' && !r.content && r.thinking !== '' && r.calls.length === 0

// Tokens from a finished reply's counts. Ollama counts the whole prompt and,
// since 0.33.3, says how much of it was already in its cache; thinking is
// part of eval_count, and is estimated from the chunks it streamed.
function tokensOf(done: Chunk, thinkingChunks: number): TokenUsage | null {
  if (done.prompt_eval_count === undefined && done.eval_count === undefined) return null
  const prompt = done.prompt_eval_count ?? 0
  const cached = Math.min(done.prompt_eval_cached_count ?? 0, prompt)
  const output = done.eval_count ?? 0
  return {
    ...NO_USAGE,
    input: prompt - cached,
    cacheRead: cached,
    output,
    reasoning: Math.min(thinkingChunks, output)
  }
}

function stopFor(done: Chunk, numCtx: number): StopReason {
  if (done.done_reason !== 'length') return 'end'
  const used = (done.prompt_eval_count ?? 0) + (done.eval_count ?? 0)
  return used >= numCtx ? 'context-full' : 'max-tokens'
}

// ---- client tools ----

// Small models leave out required arguments and send the wrong kinds of
// value. Says so, for the model to read and try again, instead of running
// the tool on them. A schema zod can't read is left for the tool to judge.
export function toolProblems(tool: ClientTool, input: Record<string, unknown>): string | null {
  let schema: z.ZodType
  try {
    schema = z.fromJSONSchema(tool.schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    return null
  }
  const check = schema.safeParse(input)
  if (check.success) return null
  const problems = check.error.issues.map((issue) => {
    const path = issue.path.join('.')
    return input[String(issue.path[0])] === undefined
      ? `"${path}" is missing`
      : `"${path}" is not valid (${issue.message})`
  })
  const required = Array.isArray(tool.schema.required) ? tool.schema.required.join(', ') : ''
  return (
    `The "${tool.name}" tool was not run: ${problems.join('; ')}. ` +
    `Call it again with correct arguments${required ? ` (required: ${required})` : ''}.`
  )
}

// Arguments arrive as an object; one that came as JSON text still works.
function argumentsOf(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// Runs one tool call and says how it went, for the model. Whatever goes
// wrong becomes the answer rather than an error, so the model can try again.
async function callTool(call: ToolCall, tools: ClientTool[], runTool: ToolRunner): Promise<string> {
  const name = call.function.name
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return `There is no tool called "${name}". The tools you can use are: ${tools.map((t) => t.name).join(', ')}.`
  }
  const input = argumentsOf(call.function.arguments)
  const problems = toolProblems(tool, input)
  if (problems) return problems
  try {
    const answer = await runTool({ name, input })
    return answer.length > MAX_TOOL_RESULT
      ? `${answer.slice(0, MAX_TOOL_RESULT)}\n[Cut: the answer was ${answer.length} characters long.]`
      : answer
  } catch (err) {
    return `The "${name}" tool failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---- waiting ----

// How many tokens a prompt is, roughly: Ollama has no tokenizer to ask.
function promptTokens(messages: Message[], tools: OllamaTool[]): number {
  let chars = JSON.stringify(tools).length
  let images = 0
  for (const m of messages) {
    chars +=
      m.content.length + (m.thinking?.length ?? 0) + JSON.stringify(m.tool_calls ?? []).length
    images += m.images?.length ?? 0
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS
}

// ---- failures ----

async function connect(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  model: string
): Promise<Response> {
  let res: Response
  try {
    res = await doFetch(url, init)
  } catch (err) {
    if (init.signal?.aborted) throw err
    throw new ProviderError(OFFLINE, 'unreachable')
  }
  if (!res.ok) {
    const { message, code } = describeFailure(res.status, await res.text().catch(() => ''), model)
    throw new ProviderError(message, code, null, res.status)
  }
  return res
}

// A stream that broke off, as the person should hear it.
function brokenStream(err: unknown, signal: AbortSignal): unknown {
  if (err instanceof ProviderError || signal.aborted) return err
  return new ProviderError('Ollama stopped partway through its reply. Try again.', 'unreachable')
}

// ---- the provider ----

export function ollamaProvider(opts: OllamaProviderOptions): Provider {
  const doFetch = opts.fetch ?? fetch
  const budget = opts.thinkingBudget ?? DEFAULT_THINKING_BUDGET
  const chatUrl = `${opts.baseURL}/api/chat`
  // What this run has learned about each model, to say how long a wait will
  // be: prompt tokens read per second, and the last cold load in ms.
  const readSpeed = new Map<string, number>()
  const loadTime = new Map<string, number>()

  // Whether a model is in memory the way a chat would load it. A model loaded
  // with another context is loaded again, so it counts as not loaded. null
  // when Ollama can't say.
  async function isLoaded(
    model: string,
    numCtx: number,
    signal: AbortSignal
  ): Promise<boolean | null> {
    try {
      const res = await doFetch(`${opts.baseURL}/api/ps`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)])
      })
      if (!res.ok) return null
      const body = (await res.json()) as { models?: { name?: string; context_length?: number }[] }
      return (body.models ?? []).some(
        (m) => m.name === model && (m.context_length === undefined || m.context_length === numCtx)
      )
    } catch {
      return null
    }
  }

  // Remembers how fast a model read the prompt and how long it took to load.
  function learn(model: string, done: Chunk): void {
    const read = (done.prompt_eval_count ?? 0) - (done.prompt_eval_cached_count ?? 0)
    const seconds = (done.prompt_eval_duration ?? 0) / 1e9
    if (read >= MIN_SAMPLE_TOKENS && seconds > 0) {
      const before = readSpeed.get(model)
      readSpeed.set(model, before ? before * 0.7 + (read / seconds) * 0.3 : read / seconds)
    }
    const loadMs = (done.load_duration ?? 0) / 1e6
    if (loadMs > 1000) loadTime.set(model, loadMs)
  }

  return {
    async run(turn, emit, signal, runTool) {
      const { model, settings } = turn
      const name = model.apiModel
      const numCtx = opts.contextFor(name)
      const started = Date.now()
      const messages = chatMessages(turn, opts.load)
      const tools = runTool && model.tools ? ollamaTools(turn.tools) : []
      // Only a model that goes on and off is cut short for thinking too long;
      // one with levels is thinking as much as it was told to.
      const switchable = model.reasoning.levels.length === 0 && model.reasoning.off !== null
      let think = thinkFor(model.reasoning, settings)

      let text = ''
      let thinking = ''
      let thinkingMs = 0
      let usage: TokenUsage | null = null
      let ttftMs: number | null = null
      let stop: StopReason = 'end'
      const partial = (): TurnResult => ({
        text,
        parts: thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {},
        usage,
        model: name,
        stop,
        ttftMs
      })

      // Says what the wait is, until the first words come: loading the model,
      // or reading the prompt, with a guess at how long that takes.
      const announce = async (): Promise<void> => {
        const loaded = await isLoaded(name, numCtx, signal)
        const speed = readSpeed.get(name)
        const reading = speed ? (promptTokens(messages, tools) / speed) * 1000 : undefined
        const loading = loaded === false ? loadTime.get(name) : undefined
        const eta =
          loading === undefined && reading === undefined
            ? undefined
            : (loading ?? 0) + (reading ?? 0)
        emit({
          kind: 'status',
          status: loaded === false ? 'loading' : 'reading',
          ...(eta === undefined ? {} : { etaMs: Math.round(eta) })
        })
      }

      // One request, streamed to the window as it arrives.
      const ask = async (thinkNow: Think, cutAt: number | undefined): Promise<Reply> => {
        await announce()
        const stopper = new AbortController()
        const res = await connect(
          doFetch,
          chatUrl,
          jsonPost(
            chatBody({ model, settings, messages, tools, think: thinkNow, numCtx }),
            AbortSignal.any([signal, stopper.signal])
          ),
          name
        )
        // A later round's words start a new paragraph after the last ones.
        let textAtStart = true
        let thinkingAtStart = true
        let thinkingFrom = 0
        let thinkingTo = 0
        const first = (): void => {
          ttftMs ??= Date.now() - started
        }
        try {
          const reply = await readReply(res.body!, name, cutAt, {
            thinking(delta) {
              first()
              thinkingFrom ||= Date.now()
              if (thinkingAtStart && thinking.trim()) delta = '\n\n' + delta.trimStart()
              thinkingAtStart = false
              thinking += delta
              emit({ kind: 'thinking', delta })
            },
            text(delta) {
              first()
              if (thinkingFrom) thinkingTo ||= Date.now()
              if (textAtStart) {
                delta = delta.trimStart()
                if (!delta) return
                if (text.trim()) delta = '\n\n' + delta
                textAtStart = false
              }
              text += delta
              emit({ kind: 'text', delta })
            }
          })
          if (reply.done) {
            const counted = tokensOf(reply.done, reply.thinkingChunks)
            if (counted) usage = addTokens(usage, counted)
            learn(name, reply.done)
            stop = stopFor(reply.done, numCtx)
          } else if (reply.cut) {
            // Ollama only counts a reply when it finishes, so one that was
            // cut off is counted by the reasoning it streamed.
            const chunks = reply.thinkingChunks
            usage = addTokens(usage, { ...NO_USAGE, output: chunks, reasoning: chunks })
          } else {
            throw new ProviderError(
              'Ollama stopped partway through its reply. Try again.',
              'unreachable'
            )
          }
          return reply
        } catch (err) {
          throw brokenStream(err, signal)
        } finally {
          stopper.abort()
          if (thinkingFrom) thinkingMs += (thinkingTo || Date.now()) - thinkingFrom
        }
      }

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          let reply = await ask(think, switchable && think === true ? budget : undefined)
          if (switchable && think === true && (reply.cut || ranOutThinking(reply))) {
            // Thinking for the rest of the turn would only do it again.
            think = false
            reply = await ask(false, undefined)
          }
          if (reply.calls.length === 0 || tools.length === 0 || !runTool) break
          // What it said and asked for goes back with the tools' answers.
          messages.push({
            role: 'assistant',
            content: reply.content,
            ...(reply.thinking ? { thinking: reply.thinking } : {}),
            tool_calls: reply.calls
          })
          for (const call of reply.calls) {
            messages.push({
              role: 'tool',
              tool_name: call.function.name,
              content: await callTool(call, turn.tools, runTool)
            })
          }
        }
        return partial()
      } catch (err) {
        if (signal.aborted) throw new TurnStopped(partial())
        throw err
      }
    },

    async complete(model, system, prompt, o) {
      const think = quietest(model.reasoning)
      const res = await connect(
        doFetch,
        chatUrl,
        jsonPost(
          {
            model: model.apiModel,
            messages: [
              ...(system.trim() ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: prompt }
            ],
            stream: false,
            ...(think === undefined ? {} : { think }),
            keep_alive: KEEP_ALIVE,
            options: {
              num_ctx: opts.contextFor(model.apiModel),
              temperature: CHORE_TEMPERATURE,
              num_predict: o?.maxOutput ?? CHORE_TOKENS
            }
          },
          o?.signal
        ),
        model.apiModel
      )
      const body = (await res.json()) as Chunk
      return { text: (body.message?.content ?? '').trim(), usage: tokensOf(body, 0) }
    }
  }
}
