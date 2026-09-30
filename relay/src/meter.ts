// Pulls the usage block out of an upstream response. The free Workers plan
// allows 10ms of CPU per request, and a streamed reply arrives as hundreds of
// small network chunks, so a meter does nothing per chunk except keep the raw
// bytes — measured live, decoding and scanning each chunk as it arrived cost
// 18-26ms on a short Codex reply. Everything happens once, at the end: decode
// what was kept, then parse only the events that carry usage (Anthropic's
// message_start and last message_delta; the Responses terminal event).

// One priced line of a reply. Almost always there is exactly one; Anthropic
// splits a reply into several when it reports `usage.iterations` (server-side
// compaction, an advisor model, a refusal fallback), each at its own model's
// rates.
export interface UsageLine {
  model: string | null
  inputTokens: number // billed at the full input rate (never includes cache reads/writes)
  cachedTokens: number // cache reads
  cacheWrite5mTokens: number // Anthropic 5-minute writes; OpenAI cache writes
  cacheWrite1hTokens: number
  outputTokens: number // includes reasoning/thinking tokens (billed as output)
}

export interface MeteredUsage extends UsageLine {
  // `model` and the token fields above are totals across `lines`, for display.
  lines: UsageLine[]
  reasoningTokens: number // informational only, already inside outputTokens
  webSearches: number
  serviceTier: string | null
  speed: string | null // Anthropic fast mode
  inferenceGeo: string | null // Anthropic data residency
  // True when the reply was cut short (client pressed Esc, network drop) and
  // part of the usage had to be estimated rather than read.
  estimated: boolean
}

// Opening bytes read as they arrive, at most. Anthropic's message_start (the
// exact input usage) is always in the first chunk or two.
const HEAD_BYTES = 64 * 1024
// SSE framing + JSON envelope per delta event, and characters per token, for
// sizing the visible output of a reply that was cut off before its final
// usage event.
const EVENT_OVERHEAD_CHARS = 110
const CHARS_PER_TOKEN = 3.6

// Typical output speed per model family, in tokens per second, for a reply cut
// off before its final usage event: output (including hidden thinking or
// reasoning) is generated the whole time a reply streams, so time streamed x
// speed sizes it — measured from when the reply started, so the time spent
// reading the prompt doesn't count.
const OUTPUT_TOKENS_PER_SECOND: [RegExp, number][] = [
  [/haiku/, 150],
  [/sonnet/, 80],
  [/opus/, 60],
  [/fable|mythos/, 45],
  [/sol/, 100],
  [/astra/, 60]
]

function outputFromTime(model: string | null, streamedMs: number): number {
  const rate = OUTPUT_TOKENS_PER_SECOND.find(([re]) => re.test(model ?? ''))?.[1] ?? 80
  return Math.ceil((Math.max(streamedMs, 0) / 1000) * rate)
}

// Visible output tokens in an SSE text from `from` on.
function outputFromText(text: string, from: number): number {
  const after = text.slice(Math.max(from, 0))
  const payload = Math.max(0, after.length - countOccurrences(after, 'data:') * EVENT_OVERHEAD_CHARS)
  return Math.ceil(payload / CHARS_PER_TOKEN)
}

function dataLineContaining(text: string, marker: string, fromEnd: boolean): unknown {
  const at = fromEnd ? text.lastIndexOf(marker) : text.indexOf(marker)
  return at === -1 ? null : dataLineAt(text, at)
}

// Parses the SSE `data:` line that contains position `at`.
function dataLineAt(text: string, at: number): unknown {
  const start = text.lastIndexOf('data:', at)
  if (start === -1) return null
  let end = text.indexOf('\n', at)
  if (end === -1) end = text.length
  try {
    return JSON.parse(text.slice(start + 5, end).trim())
  } catch {
    return null
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++
  return count
}

function decode(chunks: Uint8Array[]): string {
  let size = 0
  for (const c of chunks) size += c.byteLength
  const joined = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    joined.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(joined)
}

function emptyLine(model: string | null): UsageLine {
  return {
    model,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0
  }
}

function withTotals(
  lines: UsageLine[],
  model: string | null,
  extra: Partial<MeteredUsage> = {}
): MeteredUsage {
  const total = emptyLine(model)
  for (const l of lines) {
    total.inputTokens += l.inputTokens
    total.cachedTokens += l.cachedTokens
    total.cacheWrite5mTokens += l.cacheWrite5mTokens
    total.cacheWrite1hTokens += l.cacheWrite1hTokens
    total.outputTokens += l.outputTokens
  }
  return {
    ...total,
    lines,
    reasoningTokens: 0,
    webSearches: 0,
    serviceTier: null,
    speed: null,
    inferenceGeo: null,
    estimated: false,
    ...extra
  }
}

// ---- Anthropic Messages API ------------------------------------------------

interface AnthropicUsageBlock {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
  server_tool_use?: { web_search_requests?: number | null } | null
  service_tier?: string | null
  speed?: string | null
  inference_geo?: string | null
  iterations?: (AnthropicUsageBlock & { type?: string; model?: string | null })[] | null
}

// Folds an Anthropic usage block into a line. message_delta repeats the input
// fields cumulatively (server tools can grow input mid-turn), so present
// fields overwrite rather than add. message_delta has no TTL breakdown for
// cache writes: when its total moves, the difference goes to whichever TTL
// the reply was already writing.
function applyAnthropicBlock(line: UsageLine, block: AnthropicUsageBlock): void {
  if (block.input_tokens != null) line.inputTokens = num(block.input_tokens)
  if (block.output_tokens != null) line.outputTokens = num(block.output_tokens)
  if (block.cache_read_input_tokens != null) line.cachedTokens = num(block.cache_read_input_tokens)
  if (block.cache_creation) {
    line.cacheWrite5mTokens = num(block.cache_creation.ephemeral_5m_input_tokens)
    line.cacheWrite1hTokens = num(block.cache_creation.ephemeral_1h_input_tokens)
  } else if (block.cache_creation_input_tokens != null) {
    const total = num(block.cache_creation_input_tokens)
    const diff = total - line.cacheWrite5mTokens - line.cacheWrite1hTokens
    if (line.cacheWrite1hTokens > line.cacheWrite5mTokens) line.cacheWrite1hTokens += diff
    else line.cacheWrite5mTokens += diff
  }
}

function anthropicUsage(
  model: string | null,
  start: AnthropicUsageBlock | undefined,
  final: AnthropicUsageBlock | undefined
): MeteredUsage {
  const line = emptyLine(model)
  if (start) applyAnthropicBlock(line, start)
  if (final) applyAnthropicBlock(line, final)
  const extra: Partial<MeteredUsage> = {
    webSearches: num(final?.server_tool_use?.web_search_requests ?? start?.server_tool_use?.web_search_requests),
    serviceTier: start?.service_tier ?? final?.service_tier ?? null,
    speed: start?.speed ?? final?.speed ?? null,
    inferenceGeo: start?.inference_geo ?? final?.inference_geo ?? null
  }
  // With iterations present, the top-level fields leave out compaction,
  // advisor and declined-fallback hops, so the iterations are the bill.
  const iterations = final?.iterations ?? start?.iterations
  if (Array.isArray(iterations) && iterations.length > 0) {
    const serving = iterations.find((i) => i.type === 'fallback_message')?.model ?? model
    const lines = iterations.map((entry) => {
      const l = emptyLine(entry.model ?? model)
      applyAnthropicBlock(l, entry)
      return l
    })
    return withTotals(lines, serving, extra)
  }
  return withTotals([line], model, extra)
}

// How the relay drives a meter. The complete reply is collected natively (no
// JavaScript per network chunk) and handed to finish() once; only a meter that
// needs its opening bytes early gets them chunk by chunk through head(), which
// stops as soon as it returns true.
export interface Meter {
  readsHead: boolean
  head(chunk: Uint8Array): boolean
  // `body` is the whole reply, or null when it was cut off (client pressed
  // Esc, network drop); `streamedMs` is how long it had been streaming.
  finish(body: Uint8Array | null, streamedMs: number): MeteredUsage | null
}

export function anthropicMeter(contentType: string): Meter {
  const streaming = contentType.includes('text/event-stream')
  const opening: Uint8Array[] = []
  let openingBytes = 0

  return {
    readsHead: streaming,

    // Held so an interrupted reply can still be billed its exact input.
    head(chunk) {
      opening.push(chunk)
      openingBytes += chunk.byteLength
      if (openingBytes >= HEAD_BYTES) return true
      const text = decode(opening)
      const at = text.indexOf('"message_start"')
      return at !== -1 && text.indexOf('\n', at) !== -1
    },

    finish(body, streamedMs) {
      const text = body ? new TextDecoder().decode(body) : decode(opening)
      if (!streaming) {
        try {
          const parsed = JSON.parse(text) as { model?: string; usage?: AnthropicUsageBlock }
          if (!parsed.usage) return null
          return anthropicUsage(parsed.model ?? null, parsed.usage, undefined)
        } catch {
          return null
        }
      }
      const startAt = text.indexOf('"message_start"')
      const start =
        startAt === -1
          ? null
          : (dataLineAt(text, startAt) as {
              message?: { model?: string; usage?: AnthropicUsageBlock }
            } | null)
      if (!start?.message) return null
      const model = start.message.model ?? null
      const delta = body
        ? (dataLineContaining(text, '"message_delta"', true) as {
            usage?: AnthropicUsageBlock
          } | null)
        : null
      const usage = anthropicUsage(model, start.message.usage, delta?.usage)
      if (!delta?.usage) {
        // Cut off before the final usage event: input (the bulk of the cost)
        // is exact from message_start; size the output that was generated.
        const estimate = body ? outputFromText(text, startAt) : outputFromTime(model, streamedMs)
        usage.lines[0].outputTokens = Math.max(usage.lines[0].outputTokens, estimate)
        usage.outputTokens = usage.lines[0].outputTokens
        usage.estimated = true
      }
      return usage
    }
  }
}

// ---- OpenAI Responses API (Azure) ---------------------------------------------

interface ResponsesObject {
  model?: string
  service_tier?: string
  usage?: {
    input_tokens?: number
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    output_tokens?: number
    output_tokens_details?: { reasoning_tokens?: number }
  } | null
  // Azure reports built-in web search here, outside `usage`.
  tool_usage?: { web_search?: { num_requests?: number } }
  output?: { type?: string }[]
}

export interface ResponsesHint {
  model: string
  requestBytes: number
}

function responsesUsage(response: ResponsesObject, model: string): MeteredUsage | null {
  const usage = response.usage
  if (!usage) return null
  const line = emptyLine(model)
  const input = num(usage.input_tokens)
  // Both detail counts are subsets of input_tokens.
  line.cachedTokens = Math.min(num(usage.input_tokens_details?.cached_tokens), input)
  line.cacheWrite5mTokens = Math.min(
    num(usage.input_tokens_details?.cache_write_tokens),
    input - line.cachedTokens
  )
  line.inputTokens = input - line.cachedTokens - line.cacheWrite5mTokens
  line.outputTokens = num(usage.output_tokens)
  const searches =
    response.tool_usage?.web_search?.num_requests ??
    (response.output ?? []).filter((o) => o.type === 'web_search_call').length
  return withTotals([line], model, {
    reasoningTokens: num(usage.output_tokens_details?.reasoning_tokens),
    webSearches: num(searches),
    serviceTier: response.service_tier ?? null
  })
}

function numberAfter(text: string, key: string): number {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`))
  return match ? Number(match[1]) : 0
}

export function responsesMeter(contentType: string, hint: ResponsesHint): Meter {
  const streaming = contentType.includes('text/event-stream')

  // Interrupted before the terminal event: the Responses API reports no usage
  // until the end, so estimate. Input is sized from this request's own body
  // and reported as uncached; the ledger re-splits it using the cache-hit
  // ratio of the guest's previous exact reply on this model.
  const estimated = (outputTokens: number, webSearches: number): MeteredUsage => {
    const line = emptyLine(hint.model)
    line.inputTokens = Math.ceil(hint.requestBytes / 4)
    line.outputTokens = outputTokens
    return withTotals([line], hint.model, { webSearches, estimated: true })
  }

  return {
    readsHead: false,
    head: () => true,

    finish(body, streamedMs) {
      if (!body) return estimated(outputFromTime(hint.model, streamedMs), 0)
      const text = new TextDecoder().decode(body)
      if (!streaming) {
        try {
          return responsesUsage(JSON.parse(text) as ResponsesObject, hint.model)
        } catch {
          return null
        }
      }
      // The data line's "type" only — the SSE `event:` line repeats the name.
      const searchEvents = countOccurrences(text, '"type":"response.web_search_call.completed"')
      // Nothing nested inside a response object has a "response.*" type, so
      // the last one in the stream is the terminal event's own.
      const lastEventAt = text.lastIndexOf('"type":"response.')
      const lastType = text.slice(lastEventAt + 17, lastEventAt + 30)
      const terminal =
        lastEventAt !== -1 &&
        (lastType.startsWith('completed"') ||
          lastType.startsWith('incomplete"') ||
          lastType.startsWith('failed"'))
      if (terminal) {
        // Parse the terminal event whole rather than trusting where `usage`
        // happens to sit in the JSON.
        const event = dataLineAt(text, lastEventAt) as { response?: ResponsesObject } | null
        if (event?.response) {
          const usage = responsesUsage(event.response, hint.model)
          if (usage) {
            if (usage.webSearches === 0) usage.webSearches = searchEvents
            return usage
          }
        }
        // A terminal event that won't parse: read the usage numbers from the
        // end of it, where the response object keeps them.
        const usageAt = text.lastIndexOf('"usage":{')
        if (usageAt > lastEventAt) {
          const usageText = text.slice(usageAt, usageAt + 800)
          const input = numberAfter(usageText, 'input_tokens')
          const cached = Math.min(numberAfter(usageText, 'cached_tokens'), input)
          const writes = Math.min(numberAfter(usageText, 'cache_write_tokens'), input - cached)
          const line = emptyLine(hint.model)
          line.cachedTokens = cached
          line.cacheWrite5mTokens = writes
          line.inputTokens = input - cached - writes
          line.outputTokens = numberAfter(usageText, 'output_tokens')
          return withTotals([line], hint.model, {
            reasoningTokens: numberAfter(usageText, 'reasoning_tokens'),
            webSearches: searchEvents
          })
        }
      }
      if (body.byteLength === 0) return null
      // The stream ended without its terminal event.
      return estimated(
        Math.max(outputFromText(text, 0), outputFromTime(hint.model, streamedMs)),
        searchEvents
      )
    }
  }
}

// The top-level "model" of a Responses request, read from the first bytes of
// the body without parsing it (request bodies carry the whole conversation and
// can run to megabytes). Codex serializes `model` as the first field; the full
// parse is only a fallback.
export function peekModel(body: ArrayBuffer): string | null {
  const head = new TextDecoder().decode(body.slice(0, 2048))
  const match = head.match(/^\s*\{\s*"model"\s*:\s*"([^"]+)"/)
  if (match) return match[1]
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : null
  } catch {
    return null
  }
}
