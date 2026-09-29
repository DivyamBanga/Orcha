// Pulls the usage block out of an upstream response while the bytes stream
// through untouched. The free Workers plan allows 10ms of CPU per request, so
// nothing here JSON-parses the whole stream: Anthropic reports input usage in
// the very first event (message_start) and final usage in the last few
// (message_delta); the Responses API reports everything in its terminal event
// (response.completed). So we parse one small line from the head and only the
// terminal event from a rolling tail.

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

const ANTHROPIC_TAIL_CHARS = 96 * 1024
// The Responses terminal event echoes the whole response (instructions, tools,
// output), so keep enough tail to hold it entirely and parse it properly.
const RESPONSES_TAIL_CHARS = 1024 * 1024
// SSE framing + JSON envelope per delta event, and characters per token, for
// estimating the output of a reply that was interrupted before its final
// usage event. Only ever applied to the cut-off part of one reply.
const EVENT_OVERHEAD_CHARS = 110
const CHARS_PER_TOKEN = 3.6

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

// The last ~`limit` chars of a stream, kept as a list of chunks and only
// joined once at the end. Re-slicing one big string per chunk would copy the
// whole tail on every network read — quadratic, and the 10ms CPU budget can't
// afford that on a long reply.
function rollingTail(limit: number): { push(text: string): void; value(): string } {
  const parts: string[] = []
  let length = 0
  return {
    push(text) {
      parts.push(text)
      length += text.length
      while (parts.length > 1 && length - parts[0].length >= limit) {
        length -= parts.shift()!.length
      }
    },
    value: () => parts.join('')
  }
}

// Counts a marker over a chunked stream, including occurrences split across
// chunk boundaries. The carried seam is one char shorter than the marker, so
// an occurrence can never sit wholly inside it and be counted twice.
function streamCounter(needle: string): { count: number; feed(text: string): void } {
  let seam = ''
  const counter = {
    count: 0,
    feed(text: string): void {
      const scan = seam + text
      counter.count += countOccurrences(scan, needle)
      seam = scan.slice(-(needle.length - 1))
    }
  }
  return counter
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

export interface Meter {
  push(chunk: Uint8Array): void
  // `aborted`: the stream ended early (client went away / upstream dropped).
  finish(aborted: boolean): MeteredUsage | null
}

export function anthropicMeter(contentType: string): Meter {
  const decoder = new TextDecoder()
  const streaming = contentType.includes('text/event-stream')
  let head = ''
  let start: { model: string | null; usage: AnthropicUsageBlock | undefined } | null = null
  const tail = rollingTail(ANTHROPIC_TAIL_CHARS)
  let charsAfterStart = 0
  const eventsAfterStart = streamCounter('data:')
  let body = ''

  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true })
      if (!streaming) {
        if (body.length < 8 * 1024 * 1024) body += text
        return
      }
      if (!start) {
        head += text
        const event = dataLineContaining(head, '"message_start"', false) as {
          message?: { model?: string; usage?: AnthropicUsageBlock }
        } | null
        if (event?.message) {
          start = { model: event.message.model ?? null, usage: event.message.usage }
          tail.push(head.slice(head.indexOf('"message_start"')))
          head = ''
        } else if (head.length > 64 * 1024) {
          // No message_start within 64KB: not a Messages stream we understand.
          head = head.slice(-8 * 1024)
        }
        return
      }
      charsAfterStart += text.length
      eventsAfterStart.feed(text)
      tail.push(text)
    },

    finish() {
      if (!streaming) {
        try {
          const parsed = JSON.parse(body) as { model?: string; usage?: AnthropicUsageBlock }
          if (!parsed.usage) return null
          return anthropicUsage(parsed.model ?? null, parsed.usage, undefined)
        } catch {
          return null
        }
      }
      if (!start) return null
      const delta = dataLineContaining(tail.value(), '"message_delta"', true) as {
        usage?: AnthropicUsageBlock
      } | null
      const usage = anthropicUsage(start.model, start.usage, delta?.usage)
      if (!delta?.usage) {
        // Cut off before the final usage event: input (the bulk of the cost)
        // is exact from message_start; estimate the output that streamed.
        const payload = Math.max(0, charsAfterStart - eventsAfterStart.count * EVENT_OVERHEAD_CHARS)
        const estimate = Math.ceil(payload / CHARS_PER_TOKEN)
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
  const decoder = new TextDecoder()
  const streaming = contentType.includes('text/event-stream')
  const tail = rollingTail(RESPONSES_TAIL_CHARS)
  let chars = 0
  const events = streamCounter('data:')
  // The data line's "type" only — the SSE `event:` line repeats the name.
  const searchEvents = streamCounter('"type":"response.web_search_call.completed"')
  let body = ''

  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true })
      if (!streaming) {
        if (body.length < 8 * 1024 * 1024) body += text
        return
      }
      chars += text.length
      events.feed(text)
      searchEvents.feed(text)
      tail.push(text)
    },

    finish(aborted) {
      if (!streaming) {
        try {
          return responsesUsage(JSON.parse(body) as ResponsesObject, hint.model)
        } catch {
          return null
        }
      }
      const text = tail.value()
      // Nothing nested inside a response object has a "response.*" type, so
      // the last one in the stream is the terminal event's own. One backward
      // scan that stops there, instead of three that each read the whole tail.
      const lastEventAt = text.lastIndexOf('"type":"response.')
      const lastType = text.slice(lastEventAt + 17, lastEventAt + 30)
      const terminal =
        lastEventAt !== -1 &&
        (lastType.startsWith('completed"') ||
          lastType.startsWith('incomplete"') ||
          lastType.startsWith('failed"'))
      const finalAt = terminal ? lastEventAt : -1
      if (finalAt !== -1) {
        // The terminal event is the last thing in the stream and the tail is
        // sized to hold all of it, so parse it whole rather than trusting
        // where `usage` happens to sit in the JSON.
        const event = dataLineAt(text, finalAt) as { response?: ResponsesObject } | null
        if (event?.response) {
          const usage = responsesUsage(event.response, hint.model)
          if (usage) {
            if (usage.webSearches === 0) usage.webSearches = searchEvents.count
            return usage
          }
        }
        // Too big to have been held whole (over 1MB): read the usage numbers
        // from the end of it, where the response object keeps them.
        const usageAt = text.lastIndexOf('"usage":{')
        if (usageAt > finalAt) {
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
            webSearches: searchEvents.count
          })
        }
      }
      if (chars === 0 && !aborted) return null
      // Interrupted before the terminal event: the Responses API reports no
      // usage until the end, so estimate. Input is sized from this request's
      // own body and reported as uncached; the ledger re-splits it using the
      // cache-hit ratio of the guest's previous exact reply on this model.
      const line = emptyLine(hint.model)
      line.inputTokens = Math.ceil(hint.requestBytes / 4)
      line.outputTokens = Math.ceil(
        Math.max(0, chars - events.count * EVENT_OVERHEAD_CHARS) / CHARS_PER_TOKEN
      )
      return withTotals([line], hint.model, { webSearches: searchEvents.count, estimated: true })
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
