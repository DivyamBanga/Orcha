import type { ChatModel, TurnSettings } from '../../../shared/ai'
import { specFor } from '../../../shared/models'
import {
  ProviderError,
  type FileLoader,
  type ProviderTurn,
  type StreamEvent,
  type ToolRunner
} from '../provider'
import { anthropicApiProvider, type ApiTurnResult } from './anthropicApi'

// Stand-ins for the tests of Claude on an API key: models and turns as the
// chat would hand them over, Anthropic's streaming wire format written out by
// hand from its documented event shapes, and a fetch that plays them back.
// Not used by the app.

// ---- models and turns ----

// A catalog model built from what Orcha knows about it (MODEL_SPECS).
export function chatModel(id: string, over: Partial<ChatModel> = {}): ChatModel {
  const spec = specFor(id)
  if (!spec) throw new Error(`No spec for ${id}`)
  return {
    id: `api:${spec.id}`,
    route: 'api',
    apiModel: spec.id,
    label: spec.label,
    description: spec.description,
    spec: spec.id,
    current: spec.current,
    context: spec.context,
    maxOutput: spec.maxOutput,
    vision: spec.vision,
    pdf: spec.pdf,
    tools: true,
    reasoning: spec.reasoning,
    sampling: spec.sampling,
    verbosity: spec.verbosity,
    webSearch: spec.webSearch !== null,
    retains30d: spec.retains30d ?? false,
    price: spec.price,
    ready: true,
    ...over
  }
}

export function turnOf(
  model: ChatModel,
  over: Partial<TurnSettings> = {},
  extra: Partial<ProviderTurn> = {}
): ProviderTurn {
  return {
    model,
    system: 'SYSTEM',
    history: [{ role: 'user', text: 'hi', files: [] }],
    settings: {
      effort: null,
      thinking: true,
      webSearch: false,
      verbosity: null,
      temperature: null,
      topP: null,
      keyId: null,
      ...over
    },
    tools: [],
    ...extra
  }
}

// Files read back as fixed stand-ins.
export const loadStub: FileLoader = (f) =>
  f.kind === 'text' ? { text: `contents of ${f.name}` } : { base64: `B64${f.kind}` }

// ---- the wire ----

export type Ev = Record<string, unknown>

export const sse = (events: Ev[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

export const start = (over: { model?: string; usage?: Ev } = {}): Ev => ({
  type: 'message_start',
  message: {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [],
    model: over.model ?? 'claude-opus-5-5',
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 25,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...over.usage
    }
  }
})
export const ping: Ev = { type: 'ping' }
export const open = (index: number, content_block: Ev): Ev => ({
  type: 'content_block_start',
  index,
  content_block
})
export const delta = (index: number, d: Ev): Ev => ({
  type: 'content_block_delta',
  index,
  delta: d
})
export const close = (index: number): Ev => ({ type: 'content_block_stop', index })
export const finish = (stop_reason: string, usage: Ev = {}, extra: Ev = {}): Ev[] => [
  {
    type: 'message_delta',
    delta: { stop_reason, stop_sequence: null, ...extra },
    usage: { output_tokens: 12, ...usage }
  },
  { type: 'message_stop' }
]

export const text = (index: number, ...chunks: string[]): Ev[] => [
  open(index, { type: 'text', text: '' }),
  ...chunks.map((t) => delta(index, { type: 'text_delta', text: t })),
  close(index)
]
// Thinking: its summary, then the signature just before the block closes.
export const thought = (index: number, summary: string, signature = 'sig'): Ev[] => [
  open(index, { type: 'thinking', thinking: '', signature: '' }),
  delta(index, { type: 'thinking_delta', thinking: summary }),
  delta(index, { type: 'signature_delta', signature }),
  close(index)
]
// A search: the query arrives as pieces of JSON.
export const search = (index: number, id: string, query: string): Ev[] => [
  open(index, { type: 'server_tool_use', id, name: 'web_search', input: {} }),
  delta(index, { type: 'input_json_delta', partial_json: '' }),
  delta(index, { type: 'input_json_delta', partial_json: `{"query":"${query.slice(0, 6)}` }),
  delta(index, { type: 'input_json_delta', partial_json: `${query.slice(6)}"}` }),
  close(index)
]
export const results = (index: number, id: string, pages: [url: string, title: string][]): Ev[] => [
  open(index, {
    type: 'web_search_tool_result',
    tool_use_id: id,
    content: pages.map(([url, title]) => ({
      type: 'web_search_result',
      url,
      title,
      encrypted_content: `enc-${title}`,
      page_age: null
    }))
  }),
  close(index)
]
// Words that cite a page.
export const citing = (index: number, words: string, url: string, title: string): Ev[] => [
  open(index, { type: 'text', text: '' }),
  delta(index, { type: 'text_delta', text: words }),
  delta(index, {
    type: 'citations_delta',
    citation: {
      type: 'web_search_result_location',
      url,
      title,
      encrypted_index: `idx-${title}`,
      cited_text: words
    }
  }),
  close(index)
]
export const toolCall = (index: number, id: string, name: string, input: object): Ev[] => {
  const json = JSON.stringify(input)
  return [
    open(index, { type: 'tool_use', id, name, input: {} }),
    delta(index, { type: 'input_json_delta', partial_json: '' }),
    delta(index, { type: 'input_json_delta', partial_json: json.slice(0, 5) }),
    delta(index, { type: 'input_json_delta', partial_json: json.slice(5) }),
    close(index)
  ]
}
// Where one model's reply hands over to another's after a refusal.
export const handoff = (index: number, from: string, to: string): Ev[] => [
  open(index, { type: 'fallback', from: { model: from }, to: { model: to } }),
  close(index)
]

// ---- answers, and a fetch that gives them in order and keeps what it was sent ----

// Given the request's signal, as fetch gets it, so an answer held open can end when it is stopped.
export type Answer = (signal?: AbortSignal | null) => Response | Promise<Response>

// Cut into uneven pieces, so events straddle the chunks as they do on a real connection.
function pieces(body: string, size = 29): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    }
  })
}

// A reply that streams the events given, one list after another.
export const stream =
  (...events: Ev[][]): Answer =>
  () =>
    new Response(pieces(sse(events.flat())), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_ok' }
    })

// An error answer: the status, the JSON body, and any headers.
export const httpError =
  (status: number, body: Ev, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_err', ...headers }
    })

// The JSON body of an error answer.
export const errorBody = (type: string, message: string, details?: Ev): Ev => ({
  type: 'error',
  error: { type, message, ...(details ? { details } : {}) },
  request_id: 'req_err'
})

export interface Sent {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

// A provider that talks to the given answers, in order (the last repeats), and
// keeps what was sent and what was streamed out.
export function setup(...answers: Answer[]): {
  sent: Sent[]
  events: StreamEvent[]
  provider: ReturnType<typeof anthropicApiProvider>
  run: (turn: ProviderTurn, runTool?: ToolRunner, signal?: AbortSignal) => Promise<ApiTurnResult>
} {
  const sent: Sent[] = []
  const events: StreamEvent[] = []
  let n = 0
  const fetchStub: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? 'null'))
    })
    return answers[Math.min(n++, answers.length - 1)](init?.signal)
  }
  const provider = anthropicApiProvider({
    apiKey: 'sk-ant-test-key',
    load: loadStub,
    baseURL: 'http://anthropic.test',
    fetch: fetchStub
  })
  return {
    sent,
    events,
    provider,
    run: (turn, runTool, signal = new AbortController().signal) =>
      provider.run(turn, (e) => events.push(e), signal, runTool) as Promise<ApiTurnResult>
  }
}

// The words that were streamed out, joined.
export const spoken = (events: StreamEvent[]): string =>
  events.flatMap((e) => (e.kind === 'text' ? [e.delta] : [])).join('')

// What a promise that is expected to be rejected was rejected with.
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to fail')
    },
    (e: unknown) => e
  )
}

// A failure that is the provider's own, with its code.
export async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await rejection(promise)
  if (!(err instanceof ProviderError)) throw err
  return err
}
