import { describe, expect, it, vi } from 'vitest'
import type { ChatModel, TurnSettings } from '../../../shared/ai'
import { specFor } from '../../../shared/models'
import type { ChatFile } from '../../../shared/types'
import {
  ProviderError,
  TurnStopped,
  type ClientTool,
  type FileLoader,
  type HistoryMessage,
  type Provider,
  type ProviderTurn,
  type StreamEvent,
  type ToolRunner,
  type TurnResult
} from '../provider'
import { azureProvider, requestFor, sseEvents } from './azureResponses'

const ENDPOINT = 'https://my-res.openai.azure.com'
const KEY = 'azure-key-0123456789'

// Files read back as fixed stand-ins.
const load: FileLoader = (f) =>
  f.kind === 'text' ? { text: `contents of ${f.name}` } : { base64: `B64${f.kind}` }

// A model as the picker offers it, built from the catalog's own facts.
function modelOf(id: string, over: Partial<ChatModel> = {}): ChatModel {
  const s = specFor(id)!
  return {
    id: `azure:${s.id}`,
    route: 'azure',
    apiModel: s.id,
    label: s.label,
    description: s.description,
    spec: s.id,
    current: s.current,
    context: s.context,
    maxOutput: s.maxOutput,
    vision: s.vision,
    pdf: s.pdf,
    tools: true,
    reasoning: s.reasoning,
    sampling: s.sampling,
    verbosity: s.verbosity,
    webSearch: s.webSearch !== null,
    retains30d: false,
    price: s.price,
    ready: true,
    ...over
  }
}

const settings = (over: Partial<TurnSettings> = {}): TurnSettings => ({
  effort: null,
  thinking: true,
  webSearch: false,
  verbosity: null,
  temperature: null,
  topP: null,
  keyId: null,
  ...over
})

const HISTORY: HistoryMessage[] = [
  { role: 'user', text: 'hi', files: [] },
  { role: 'assistant', text: 'hello', files: [] },
  { role: 'assistant', text: '   ', files: [] },
  { role: 'user', text: 'again', files: [] }
]

function turnFor(
  model: ChatModel,
  set: Partial<TurnSettings> = {},
  over: Partial<ProviderTurn> = {}
): ProviderTurn {
  return { model, system: 'SYSTEM', history: HISTORY, settings: settings(set), tools: [], ...over }
}

const WEATHER: ClientTool = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
}

const body = (t: ProviderTurn): Record<string, unknown> => requestFor(t, load)

describe('request: what is sent', () => {
  const sol = modelOf('gpt-6-sol')

  it('names the deployment, keeps nothing on the server, and puts the system prompt in a developer message', () => {
    const b = body(turnFor(modelOf('gpt-6-sol', { apiModel: 'my-sol' })))
    expect(b.model).toBe('my-sol')
    expect(b.stream).toBe(true)
    expect(b.store).toBe(false)
    expect(b.input).toEqual([
      { role: 'developer', content: 'SYSTEM' },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'again' }] }
    ])
  })

  it('has no developer message when there is no system prompt', () => {
    expect((body(turnFor(sol, {}, { system: '  ' })).input as unknown[])[0]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }]
    })
  })

  it('sends attached files as data URLs and inline text, files first', () => {
    const file = (kind: ChatFile['kind'], name: string, mime: string): ChatFile => ({
      hash: 'a'.repeat(64),
      name,
      mime,
      bytes: 300,
      kind
    })
    const history: HistoryMessage[] = [
      {
        role: 'user',
        text: 'What do these say?',
        files: [
          file('image', 'shot.png', 'image/png'),
          file('pdf', 'paper.pdf', 'application/pdf'),
          file('text', 'notes.md', 'text/markdown')
        ]
      }
    ]
    const input = body(turnFor(sol, {}, { history })).input as { content: unknown }[]
    expect(input[1].content).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,B64image' },
      {
        type: 'input_file',
        filename: 'paper.pdf',
        file_data: 'data:application/pdf;base64,B64pdf'
      },
      { type: 'input_text', text: '<file name="notes.md">\ncontents of notes.md\n</file>' },
      { type: 'input_text', text: 'What do these say?' }
    ])
  })

  it('caps the answer at 64K, or the model’s own limit when that is lower', () => {
    expect(body(turnFor(sol)).max_output_tokens).toBe(64_000)
    expect(body(turnFor(modelOf('gpt-4.1'))).max_output_tokens).toBe(32_768)
    expect(body(turnFor(modelOf('gpt-chat-latest'))).max_output_tokens).toBe(16_384)
  })

  describe('GPT-6.1 Sol: no "none", and no sampling', () => {
    const model = modelOf('gpt-6.1-sol')

    it('leaves the effort to the model unless one is chosen', () => {
      expect(body(turnFor(model)).reasoning).toEqual({ summary: 'auto' })
      expect(body(turnFor(model, { effort: 'xhigh' })).reasoning).toEqual({
        effort: 'xhigh',
        summary: 'auto'
      })
    })

    it('turns "none" into the lowest level it has', () => {
      expect(body(turnFor(model, { effort: 'none' })).reasoning).toEqual({
        effort: 'low',
        summary: 'auto'
      })
    })

    it('never sends temperature or top_p', () => {
      for (const effort of [null, 'none', 'high'] as const) {
        const b = body(turnFor(model, { effort, temperature: 0.7, topP: 0.9 }))
        expect(b).not.toHaveProperty('temperature')
        expect(b).not.toHaveProperty('top_p')
      }
    })
  })

  describe('GPT-6 Sol: "none" is allowed, and with it sampling', () => {
    it('sends "none", and temperature and top_p with it', () => {
      const b = body(turnFor(sol, { effort: 'none', temperature: 0.3, topP: 0.9 }))
      expect(b.reasoning).toEqual({ effort: 'none', summary: 'auto' })
      expect(b.temperature).toBe(0.3)
      expect(b.top_p).toBe(0.9)
    })

    it('sends only what was set', () => {
      const b = body(turnFor(sol, { effort: 'none', temperature: 0.3 }))
      expect(b.temperature).toBe(0.3)
      expect(b).not.toHaveProperty('top_p')
      expect(body(turnFor(sol, { effort: 'none' }))).not.toHaveProperty('temperature')
    })

    it('holds sampling back while it thinks, including at its default effort', () => {
      for (const effort of ['low', 'high', 'max', null] as const) {
        const b = body(turnFor(sol, { effort, temperature: 0.3, topP: 0.9 }))
        expect(b, String(effort)).not.toHaveProperty('temperature')
        expect(b, String(effort)).not.toHaveProperty('top_p')
      }
    })
  })

  describe('GPT-5.1: thinks at "none" unless told otherwise', () => {
    const model = modelOf('gpt-5.1')
    it('allows sampling at its default, and not once it thinks', () => {
      expect(body(turnFor(model, { temperature: 0.5 })).temperature).toBe(0.5)
      expect(body(turnFor(model, { effort: 'low', temperature: 0.5 }))).not.toHaveProperty(
        'temperature'
      )
    })
  })

  describe('GPT-5: minimal, no "none", no sampling', () => {
    const model = modelOf('gpt-5')
    it('sends "minimal" as is, and moves levels it lacks to the nearest', () => {
      expect(body(turnFor(model, { effort: 'minimal' })).reasoning).toEqual({
        effort: 'minimal',
        summary: 'auto'
      })
      expect(body(turnFor(model, { effort: 'none' })).reasoning).toMatchObject({
        effort: 'minimal'
      })
      expect(body(turnFor(model, { effort: 'xhigh' })).reasoning).toMatchObject({ effort: 'high' })
      expect(body(turnFor(model, { effort: 'max' })).reasoning).toMatchObject({ effort: 'high' })
    })
    it('takes no sampling', () => {
      expect(body(turnFor(model, { effort: 'minimal', temperature: 1 }))).not.toHaveProperty(
        'temperature'
      )
    })
  })

  describe('gpt-4.1: no reasoning, sampling always', () => {
    const model = modelOf('gpt-4.1')
    it('sends no reasoning object whatever the effort, and sampling as set', () => {
      const b = body(turnFor(model, { effort: 'high', temperature: 0.2, topP: 0.8 }))
      expect(b).not.toHaveProperty('reasoning')
      expect(b.temperature).toBe(0.2)
      expect(b.top_p).toBe(0.8)
    })
    it('sends no verbosity, as it has none', () => {
      expect(body(turnFor(model, { verbosity: 'low' }))).not.toHaveProperty('text')
    })
    it('asks for no encrypted reasoning even with tools, as it has none to send', () => {
      const b = body(turnFor(model, {}, { tools: [WEATHER] }))
      expect(b.tools).toHaveLength(1)
      expect(b).not.toHaveProperty('include')
    })
  })

  describe('verbosity', () => {
    it('is sent where the model has it and it is set', () => {
      expect(body(turnFor(sol, { verbosity: 'low' })).text).toEqual({ verbosity: 'low' })
      expect(body(turnFor(sol, { verbosity: 'high' })).text).toEqual({ verbosity: 'high' })
      expect(body(turnFor(sol))).not.toHaveProperty('text')
    })
  })

  describe('tools', () => {
    it('offers the web search tool when it is on and the model can search', () => {
      expect(body(turnFor(sol, { webSearch: true })).tools).toEqual([{ type: 'web_search' }])
      expect(body(turnFor(sol, { webSearch: false }))).not.toHaveProperty('tools')
      expect(
        body(turnFor(modelOf('gpt-6-sol', { webSearch: false }), { webSearch: true }))
      ).not.toHaveProperty('tools')
    })

    it('offers Orcha’s tools as functions, after search, and asks for encrypted reasoning with them', () => {
      const b = body(turnFor(sol, { webSearch: true }, { tools: [WEATHER] }))
      expect(b.tools).toEqual([
        { type: 'web_search' },
        {
          type: 'function',
          name: 'get_weather',
          description: 'Current weather for a city.',
          parameters: WEATHER.schema,
          strict: false
        }
      ])
      expect(b.include).toEqual(['reasoning.encrypted_content'])
    })

    it('asks for no encrypted reasoning when there are no tools, or only search', () => {
      expect(body(turnFor(sol))).not.toHaveProperty('include')
      expect(body(turnFor(sol, { webSearch: true }))).not.toHaveProperty('include')
    })

    it('leaves Orcha’s tools out for a model that cannot call them', () => {
      const b = body(turnFor(modelOf('gpt-6-sol', { tools: false }), {}, { tools: [WEATHER] }))
      expect(b).not.toHaveProperty('tools')
      expect(b).not.toHaveProperty('include')
    })
  })
})

// ---- the network, faked ----

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

// A network that answers each request in turn (the last answer repeats).
function network(replies: (() => Response)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let n = 0
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body))
    })
    return replies[Math.min(n++, replies.length - 1)]()
  }) as unknown as typeof fetch
  return { fetch: fake, calls }
}

const provider = (net: { fetch: typeof fetch }): Provider =>
  azureProvider({ endpoint: ENDPOINT, apiKey: KEY, load, fetch: net.fetch })

// Server-sent events as Azure frames them.
function frames(events: object[], nl = '\n'): string {
  return events
    .map((e) => `event: ${(e as { type: string }).type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`)
    .join('')
}

// A body that arrives `size` bytes at a time (or fails where an Error is given).
function chunked(text: string | (string | Error)[], size = 64): ReadableStream<Uint8Array> {
  const parts: (Uint8Array | Error)[] =
    typeof text === 'string'
      ? (() => {
          const bytes = new TextEncoder().encode(text)
          const out: Uint8Array[] = []
          for (let at = 0; at < bytes.length; at += size) out.push(bytes.slice(at, at + size))
          return out
        })()
      : text.map((t) => (t instanceof Error ? t : new TextEncoder().encode(t)))
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) return controller.close()
      const part = parts[i++]
      if (part instanceof Error) controller.error(part)
      else controller.enqueue(part)
    }
  })
}

const streaming =
  (events: object[], opts: { nl?: string; size?: number } = {}): (() => Response) =>
  () =>
    new Response(chunked(frames(events, opts.nl), opts.size), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })

const jsonReply =
  (data: unknown, status = 200, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers })

// Events, as Azure sends them.
const said = (delta: string, item = 'msg_1'): object => ({
  type: 'response.output_text.delta',
  item_id: item,
  output_index: 0,
  content_index: 0,
  delta
})
const thought = (delta: string): object => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: 'rs_1',
  output_index: 0,
  summary_index: 0,
  delta
})
const usage = (over: object = {}): object => ({
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 120,
  ...over
})
const completed = (over: object = {}): object => ({
  type: 'response.completed',
  response: { status: 'completed', usage: usage(), ...over }
})
const item = (it: object): object => ({
  type: 'response.output_item.done',
  output_index: 0,
  item: it
})

async function play(
  p: Provider,
  turn: ProviderTurn,
  runTool?: ToolRunner
): Promise<{ result: TurnResult; events: StreamEvent[] }> {
  const events: StreamEvent[] = []
  const result = await p.run(turn, (e) => events.push(e), new AbortController().signal, runTool)
  return { result, events }
}

const SOL = modelOf('gpt-6-sol')
const ASK = turnFor(SOL)

describe('the call', () => {
  it('posts to the v1 route with the key in api-key, and no api-version', async () => {
    const net = network([streaming([said('Hi'), completed()])])
    await play(provider(net), ASK)
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`)
    expect(net.calls[0].headers['api-key']).toBe(KEY)
    expect(net.calls[0].headers['content-type']).toBe('application/json')
    expect(Object.keys(net.calls[0].headers).map((h) => h.toLowerCase())).not.toContain(
      'authorization'
    )
    expect(net.calls[0].body.model).toBe('gpt-6-sol')
    expect(net.calls[0].body.stream).toBe(true)
  })

  it('copes with a trailing slash on the endpoint', async () => {
    const net = network([streaming([said('Hi'), completed()])])
    await play(
      azureProvider({ endpoint: `${ENDPOINT}/`, apiKey: KEY, load, fetch: net.fetch }),
      ASK
    )
    expect(net.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`)
  })

  it('leaves Orcha’s tools out when nothing is there to run them', async () => {
    const net = network([streaming([said('Hi'), completed()])])
    await play(provider(net), turnFor(SOL, {}, { tools: [WEATHER] }))
    expect(net.calls[0].body).not.toHaveProperty('tools')
    expect(net.calls[0].body).not.toHaveProperty('include')
  })
})

describe('reading the reply', () => {
  const sayings = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
    thought('Checking '),
    thought('the question.'),
    { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
    thought('Writing it up.'),
    said('Héllo '),
    said('wörld 🌍'),
    completed()
  ]

  // CRLF framing, and chunks that cut frames, line endings and characters anywhere.
  it.each([1, 2, 3, 5, 7, 11, 64])(
    'reads CRLF-framed events arriving %i bytes at a time',
    async (size) => {
      const net = network([streaming(sayings, { nl: '\r\n', size })])
      const { result, events } = await play(provider(net), ASK)
      expect(events).toEqual([
        { kind: 'thinking', delta: 'Checking ' },
        { kind: 'thinking', delta: 'the question.' },
        { kind: 'thinking', delta: '\n\n' },
        { kind: 'thinking', delta: 'Writing it up.' },
        { kind: 'text', delta: 'Héllo ' },
        { kind: 'text', delta: 'wörld 🌍' }
      ])
      expect(result.text).toBe('Héllo wörld 🌍')
      expect(result.parts.thinking?.text).toBe('Checking the question.\n\nWriting it up.')
      expect(result.parts.thinking?.ms).toBeGreaterThanOrEqual(0)
      expect(result.stop).toBe('end')
      expect(result.model).toBe('azure:gpt-6-sol')
      expect(result.ttftMs).toBeGreaterThanOrEqual(0)
    }
  )

  it('reads the same events with plain LF framing', async () => {
    const lf = await play(provider(network([streaming(sayings)])), ASK)
    const crlf = await play(provider(network([streaming(sayings, { nl: '\r\n' })])), ASK)
    expect(lf.result.text).toBe(crlf.result.text)
    expect(lf.events).toEqual(crlf.events)
  })

  it('counts cached tokens, cache writes, reasoning and searches apart', async () => {
    const net = network([
      streaming([
        said('x'),
        completed({
          usage: usage({
            input_tokens: 300_000,
            input_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 50_000 },
            output_tokens: 900,
            output_tokens_details: { reasoning_tokens: 400 }
          }),
          tool_usage: { web_search: { num_requests: 2 } }
        })
      ])
    ])
    const { result } = await play(provider(net), ASK)
    expect(result.usage).toEqual({
      input: 50_000,
      cacheRead: 200_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWrite: 50_000,
      output: 900,
      reasoning: 400,
      webSearches: 2,
      // Over the 272K a request may hold before the long-context rate applies.
      longContext: true
    })
  })

  it('does not call a short request long-context, nor a model without that rate', async () => {
    const short = await play(provider(network([streaming([said('x'), completed()])])), ASK)
    expect(short.result.usage).toMatchObject({ input: 100, cacheRead: 0, cacheWrite: 0 })
    expect(short.result.usage?.longContext).toBe(false)
    const big = completed({ usage: usage({ input_tokens: 500_000 }) })
    const gpt41 = turnFor(modelOf('gpt-4.1'))
    const none = await play(provider(network([streaming([said('x'), big])])), gpt41)
    expect(none.result.usage?.longContext).toBe(false)
  })

  it('never lets the buckets add up to more than the input', async () => {
    const net = network([
      streaming([
        said('x'),
        completed({
          usage: usage({
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 90, cache_write_tokens: 50 }
          })
        })
      ])
    ])
    const { result } = await play(provider(net), ASK)
    expect(result.usage).toMatchObject({ input: 0, cacheRead: 90, cacheWrite: 10 })
  })

  it('has no usage when Azure sent none', async () => {
    const net = network([streaming([said('x'), { type: 'response.completed', response: {} }])])
    expect((await play(provider(net), ASK)).result.usage).toBeNull()
  })

  it('ends as max-tokens, keeping the words, when the output ran out', async () => {
    const net = network([
      streaming([
        said('Part of an '),
        said('answer'),
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: usage()
          }
        }
      ])
    ])
    const { result } = await play(provider(net), ASK)
    expect(result.text).toBe('Part of an answer')
    expect(result.stop).toBe('max-tokens')
    expect(result.usage?.output).toBe(20)
  })

  it('ends as a refusal when the content filter cut the reply short', async () => {
    const net = network([
      streaming([
        said('Start'),
        {
          type: 'response.incomplete',
          response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
        }
      ])
    ])
    const { result } = await play(provider(net), ASK)
    expect(result.text).toBe('Start')
    expect(result.stop).toBe('refusal')
  })

  it('shows the model’s refusal as the reply, and ends as a refusal', async () => {
    const net = network([
      streaming([
        { type: 'response.refusal.delta', item_id: 'msg_1', content_index: 0, delta: 'I can’t ' },
        {
          type: 'response.refusal.delta',
          item_id: 'msg_1',
          content_index: 0,
          delta: 'help with that.'
        },
        { type: 'response.refusal.done', item_id: 'msg_1', refusal: 'I can’t help with that.' },
        completed()
      ])
    ])
    const { result, events } = await play(provider(net), ASK)
    expect(result.text).toBe('I can’t help with that.')
    expect(result.stop).toBe('refusal')
    expect(events.map((e) => e.kind)).toEqual(['text', 'text'])
    expect(result.usage).not.toBeNull()
  })

  it('says when it is queued', async () => {
    const net = network([streaming([{ type: 'response.queued' }, said('x'), completed()])])
    const { events } = await play(provider(net), ASK)
    expect(events[0]).toEqual({ kind: 'status', status: 'queued' })
  })

  it('starts each message in a reply on a new paragraph', async () => {
    const net = network([
      streaming([said('Looking it up.', 'msg_1'), said('  Here it is.', 'msg_2'), completed()])
    ])
    const { result, events } = await play(provider(net), ASK)
    expect(result.text).toBe('Looking it up.\n\nHere it is.')
    expect(events.map((e) => (e.kind === 'text' ? e.delta : ''))).toEqual([
      'Looking it up.',
      '\n\nHere it is.'
    ])
  })

  it('ignores events it does not know', async () => {
    const net = network([
      streaming([
        { type: 'response.something_new', whatever: 1 },
        said('ok'),
        { type: 'response.content_part.done' },
        completed()
      ])
    ])
    expect((await play(provider(net), ASK)).result.text).toBe('ok')
  })

  describe('citations', () => {
    const cite = (url: string, title: string, end: number, id = 'msg_1'): object => ({
      type: 'response.output_text.annotation.added',
      item_id: id,
      output_index: 1,
      content_index: 0,
      annotation_index: 0,
      annotation: { type: 'url_citation', url, title, start_index: 0, end_index: end }
    })
    const TOWER = 'https://a.example/tower'
    const HISTORY_URL = 'https://b.example/history'

    it('gathers sources once each and puts a chip after each cited claim', async () => {
      const net = network([
        streaming([
          { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
          said('The CN Tower is 553 m tall.'),
          cite(TOWER, 'CN Tower', 27),
          said(' It opened in 1976.'),
          cite(HISTORY_URL, 'History', 46),
          cite(TOWER, 'CN Tower', 46),
          completed()
        ])
      ])
      const { result, events } = await play(provider(net), turnFor(SOL, { webSearch: true }))
      expect(result.parts.sources).toEqual([
        { url: TOWER, title: 'CN Tower' },
        { url: HISTORY_URL, title: 'History' }
      ])
      expect(result.text).toBe(
        `The CN Tower is 553 m tall. [1](<${TOWER}> "cite") It opened in 1976.` +
          ` [2](<${HISTORY_URL}> "cite")[1](<${TOWER}> "cite")`
      )
      // What streamed had no chips yet; the search was shown as it began.
      expect(events.flatMap((e) => (e.kind === 'text' ? [e.delta] : [])).join('')).toBe(
        'The CN Tower is 553 m tall. It opened in 1976.'
      )
      expect(events[0]).toEqual({
        kind: 'tool',
        tool: { kind: 'search', label: 'Searching the web' }
      })
    })

    it('titles a source by its address when it has no title', async () => {
      const net = network([streaming([said('Claim.'), cite(TOWER, '', 6), completed()])])
      const { result } = await play(provider(net), ASK)
      expect(result.parts.sources).toEqual([{ url: TOWER, title: TOWER }])
    })

    it('puts a chip at the end when the position is past it', async () => {
      const net = network([streaming([said('Short.'), cite(TOWER, 'T', 999), completed()])])
      const { result } = await play(provider(net), ASK)
      expect(result.text).toBe(`Short. [1](<${TOWER}> "cite")`)
    })
  })
})

describe('when the reply fails', () => {
  // Azure answers 200 and reports a failure inside the stream.
  const failing = (event: object): (() => Response) => streaming([said('Some words, then '), event])

  it.each([
    [
      'the nested form, no capacity',
      {
        type: 'error',
        error: {
          type: 'too_many_requests',
          code: 'no_capacity',
          headers: { 'skip-error-remapping': 'true' },
          message: 'The system is currently experiencing high demand.',
          param: null
        }
      },
      { code: 'overloaded', status: 429 }
    ],
    [
      'the nested form, a rate limit with a wait',
      {
        type: 'error',
        error: {
          type: 'too_many_requests',
          code: 'rate_limit_exceeded',
          headers: { 'retry-after-ms': 1200 },
          message: 'Slow down.'
        }
      },
      { code: 'rate-limit', status: 429, retryAfterMs: 1200 }
    ],
    [
      'the nested form, a server error',
      { type: 'error', error: { type: 'server_error', code: 'internal', message: 'Boom.' } },
      { code: 'overloaded', status: 500 }
    ],
    [
      'the nested form, forbidden',
      { type: 'error', error: { type: 'forbidden', code: 'blocked', message: 'No.' } },
      { code: 'auth', status: 403 }
    ],
    [
      'the nested form, a bad request',
      {
        type: 'error',
        error: { type: 'user_error', code: 'invalid_prompt', message: 'The prompt is not valid.' }
      },
      { code: 'bad-request', status: 400 }
    ],
    [
      'the flat form',
      { type: 'error', code: 'rate_limit_exceeded', message: 'Slow down.', param: null },
      { code: 'rate-limit' }
    ],
    [
      'a failed response',
      {
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'server_error', message: 'Oops.' } }
      },
      { code: 'overloaded' }
    ]
  ])('turns %s into a typed error', async (_name, event, expected) => {
    const net = network([failing(event)])
    const err = await play(provider(net), ASK).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject(expected)
  })

  it('knows an error frame by its event line when the payload has no type', async () => {
    const net = network([
      () =>
        new Response(
          chunked(
            'event: error\ndata: {"error":{"type":"server_error","code":"x","message":"Down."}}\n\n'
          ),
          { status: 200 }
        )
    ])
    const err = await play(provider(net), ASK).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'overloaded', status: 500 })
  })

  it('says it in plain words, with the wait when Azure gave one', async () => {
    const net = network([
      failing({
        type: 'error',
        error: {
          type: 'too_many_requests',
          code: 'rate_limit_exceeded',
          headers: { 'retry-after-ms': '1200' }
        }
      })
    ])
    const err = (await play(provider(net), ASK).catch((e: unknown) => e)) as ProviderError
    expect(err.message).toBe(
      'Azure is limiting requests to "gpt-6-sol" right now. Try again in 2 seconds.'
    )
  })

  it('is an error, not a success, when the stream ends without its final event', async () => {
    const net = network([streaming([said('Half an answer')])])
    const err = await play(provider(net), ASK).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'unreachable' })
    expect((err as Error).message).toMatch(/dropped before the reply finished/)
  })

  it('is an error when the connection breaks mid-stream', async () => {
    const net = network([
      () =>
        new Response(chunked([frames([said('Half')]), new Error('terminated')]), { status: 200 })
    ])
    const err = await play(provider(net), ASK).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'unreachable' })
  })

  it('is an error when there is nothing to read', async () => {
    const net = network([() => new Response(null, { status: 200 })])
    expect(await play(provider(net), ASK).catch((e: unknown) => e)).toMatchObject({
      code: 'unreachable'
    })
  })

  it('is unreachable when there is no network', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const err = await play(
      azureProvider({ endpoint: ENDPOINT, apiKey: KEY, load, fetch: down }),
      ASK
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'unreachable' })
    expect((err as Error).message).not.toContain(KEY)
  })
})

describe('when Azure refuses the request', () => {
  const error = (code: string, message: string): object => ({ error: { code, message } })
  const NOT_FOUND = error(
    'DeploymentNotFound',
    'The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.'
  )

  it.each([
    [
      'a rate limit, with the wait in milliseconds',
      429,
      error('429', 'Requests to the Responses Operation have exceeded token rate limit.'),
      { 'retry-after-ms': '2500' },
      { code: 'rate-limit', status: 429, retryAfterMs: 2500 },
      /Try again in 3 seconds/
    ],
    [
      'a rate limit, with the wait in seconds',
      429,
      error('429', 'Too many requests.'),
      { 'retry-after': '7' },
      { code: 'rate-limit', retryAfterMs: 7000 },
      /Try again in 7 seconds/
    ],
    [
      'a rate limit, with no wait given',
      429,
      error('429', 'Too many requests.'),
      {},
      { code: 'rate-limit', retryAfterMs: null },
      /Try again in a moment/
    ],
    [
      'a prompt the content filter blocked',
      400,
      error(
        'content_filter',
        'The response was filtered due to the prompt triggering content management policy.'
      ),
      {},
      { code: 'refused', status: 400 },
      /content filter blocked this message/
    ],
    [
      'a bad key',
      401,
      error('401', 'Access denied due to invalid subscription key.'),
      {},
      { code: 'auth', status: 401 },
      /didn't accept the API key/
    ],
    [
      'a key that is not allowed here',
      403,
      error('PermissionDenied', 'Request blocked by network rules.'),
      {},
      { code: 'auth', status: 403 },
      /different resource/
    ],
    [
      'a safety review stop on GPT-6 Astra',
      403,
      error('misalignment_policy_violation', 'Blocked.'),
      {},
      { code: 'refused', status: 403 },
      /safety review/
    ],
    [
      'a deployment that does not exist',
      404,
      NOT_FOUND,
      {},
      { code: 'not-found', status: 404 },
      /couldn't find a deployment named "gpt-6-sol"/
    ],
    [
      'a conversation that is too long',
      400,
      error('context_length_exceeded', 'Your input exceeds the context window of this model.'),
      {},
      { code: 'context-full' },
      /longer than the model can read/
    ],
    [
      'a request the model cannot take',
      400,
      error('unsupported_value', "Unsupported value: 'reasoning.effort' does not support 'xhigh'."),
      {},
      { code: 'bad-request', status: 400 },
      /Azure rejected the request: Unsupported value: 'reasoning.effort'/
    ],
    [
      'a subscription out of quota, even when it comes as a 429',
      429,
      error('insufficient_quota', 'You exceeded your current quota.'),
      {},
      { code: 'no-credit', status: 429 },
      /out of quota or credit/
    ],
    [
      'Azure being down',
      503,
      error('ServiceUnavailable', 'Down.'),
      {},
      { code: 'overloaded', status: 503 },
      /busy/
    ],
    [
      'a gateway page instead of JSON',
      502,
      '<html>Bad gateway</html>',
      {},
      { code: 'overloaded' },
      /busy/
    ]
  ])('explains %s', async (_name, status, data, headers, expected, words) => {
    const net = network([jsonReply(data, status, headers)])
    const err = (await play(provider(net), ASK).catch((e: unknown) => e)) as ProviderError
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject(expected)
    expect(err.message).toMatch(words)
    expect(err.message).not.toContain(KEY)
  })

  it('tells a spent subscription from a busy one', async () => {
    const net = network([jsonReply(error('insufficient_quota', 'Quota.'), 402)])
    expect(await play(provider(net), ASK).catch((e: unknown) => e)).toMatchObject({
      code: 'no-credit',
      status: 402
    })
  })
})

describe('tools', () => {
  const call = (over: object = {}): object => ({
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Waterloo"}',
    status: 'completed',
    ...over
  })
  const withTools = turnFor(SOL, {}, { tools: [WEATHER] })
  const KEPT = [
    {
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Check the weather.' }],
      encrypted_content: 'ENC1'
    },
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Checking.' }]
    },
    call()
  ]

  it('runs a tool and goes again with what the model output and the answer', async () => {
    const net = network([
      streaming([
        item(KEPT[0]),
        item({ id: 'rs_2', type: 'reasoning', summary: [] }),
        item({ id: 'ws_1', type: 'web_search_call', status: 'completed' }),
        said('Checking.'),
        item(KEPT[1]),
        item(KEPT[2]),
        completed({ usage: usage({ input_tokens: 100, output_tokens: 20 }) })
      ]),
      streaming([
        said('It’s 14 degrees.', 'msg_2'),
        completed({
          usage: usage({
            input_tokens: 160,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 30,
            output_tokens_details: { reasoning_tokens: 5 }
          })
        })
      ])
    ])
    const runTool = vi.fn<ToolRunner>(async () => '14 C, calm')
    const { result } = await play(provider(net), withTools, runTool)

    expect(runTool).toHaveBeenCalledTimes(1)
    expect(runTool).toHaveBeenCalledWith({ name: 'get_weather', input: { city: 'Waterloo' } })
    expect(net.calls).toHaveLength(2)
    expect(net.calls[1].body.input).toEqual([
      ...(net.calls[0].body.input as unknown[]),
      // Its reasoning (only the encrypted one), its words and its call...
      ...KEPT,
      // ...and the answer. The hosted search's record and the unusable reasoning stay out.
      { type: 'function_call_output', call_id: 'call_1', output: '14 C, calm' }
    ])
    expect(net.calls[1].body.include).toEqual(['reasoning.encrypted_content'])
    expect(net.calls[1].body.tools).toHaveLength(1)
    // The second round's words start a new paragraph, and the usage is both rounds'.
    expect(result.text).toBe('Checking.\n\nIt’s 14 degrees.')
    expect(result.stop).toBe('end')
    expect(result.usage).toMatchObject({ input: 160, cacheRead: 100, output: 50, reasoning: 5 })
  })

  it('answers several calls in order, running them one at a time', async () => {
    const net = network([
      streaming([
        item(call({ call_id: 'call_a', arguments: '{"city":"A"}' })),
        item(call({ id: 'fc_2', call_id: 'call_b', arguments: '{"city":"B"}' })),
        completed()
      ]),
      streaming([said('Both done.'), completed()])
    ])
    const order: string[] = []
    const runTool: ToolRunner = async ({ input }) => {
      const city = (input as { city: string }).city
      order.push(`start ${city}`)
      await new Promise((r) => setTimeout(r, city === 'A' ? 20 : 0))
      order.push(`end ${city}`)
      return `weather in ${city}`
    }
    await play(provider(net), withTools, runTool)
    expect(order).toEqual(['start A', 'end A', 'start B', 'end B'])
    const sent = net.calls[1].body.input as { type?: string; call_id?: string; output?: string }[]
    expect(sent.filter((i) => i.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'call_a', output: 'weather in A' },
      { type: 'function_call_output', call_id: 'call_b', output: 'weather in B' }
    ])
  })

  it('tells the model when its arguments were not JSON, and does not run the tool', async () => {
    const net = network([
      streaming([item(call({ arguments: '{"city": ' })), completed()]),
      streaming([said('Sorry.'), completed()])
    ])
    const runTool = vi.fn<ToolRunner>(async () => 'never')
    await play(provider(net), withTools, runTool)
    expect(runTool).not.toHaveBeenCalled()
    const out = (net.calls[1].body.input as { type?: string; output?: string }[]).find(
      (i) => i.type === 'function_call_output'
    )
    expect(out?.output).toBe('get_weather did not run: its arguments were not valid JSON.')
  })

  it('tells the model when a tool fails, and the reply goes on', async () => {
    const net = network([
      streaming([item(call()), completed()]),
      streaming([said('The tool broke.'), completed()])
    ])
    const runTool: ToolRunner = async () => {
      throw new Error('the weather service is down')
    }
    const { result } = await play(provider(net), withTools, runTool)
    expect(result.text).toBe('The tool broke.')
    const out = (net.calls[1].body.input as { type?: string; output?: string }[]).find(
      (i) => i.type === 'function_call_output'
    )
    expect(out?.output).toBe('get_weather failed: the weather service is down')
  })

  it('does not run a tool call from a reply that was cut short', async () => {
    const net = network([
      streaming([
        item(call({ arguments: '{"ci' })),
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: usage()
          }
        }
      ])
    ])
    const runTool = vi.fn<ToolRunner>(async () => 'never')
    const { result } = await play(provider(net), withTools, runTool)
    expect(runTool).not.toHaveBeenCalled()
    expect(net.calls).toHaveLength(1)
    expect(result.stop).toBe('max-tokens')
  })

  it('stops a model that keeps calling tools after eight rounds', async () => {
    const net = network([streaming([item(call()), completed()])])
    const runTool = vi.fn<ToolRunner>(async () => 'ok')
    const err = await play(provider(net), withTools, runTool).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/8 times in a row/)
    expect(net.calls).toHaveLength(8)
    // The eighth round's calls are not run: nothing could follow them.
    expect(runTool).toHaveBeenCalledTimes(7)
  })

  it('puts citations from a later round where they belong', async () => {
    // The later message opens with two spaces that are dropped; the citation's
    // position (7: after "Done.") counts them.
    const net = network([
      streaming([said('Checking.'), item(call()), completed()]),
      streaming([
        said('  Done. More.', 'msg_2'),
        {
          type: 'response.output_text.annotation.added',
          item_id: 'msg_2',
          content_index: 0,
          annotation: { type: 'url_citation', url: 'https://x.example/', title: 'X', end_index: 7 }
        },
        completed()
      ])
    ])
    const { result } = await play(provider(net), withTools, async () => 'ok')
    expect(result.text).toBe('Checking.\n\nDone. [1](<https://x.example/> "cite") More.')
  })
})

describe('stopping', () => {
  it('hands back what had streamed when the person stops', async () => {
    const stuck = (async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames([thought('Hmm. '), said('Hel')])))
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError'))
          )
        }
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const events: StreamEvent[] = []
    const abort = new AbortController()
    const running = azureProvider({ endpoint: ENDPOINT, apiKey: KEY, load, fetch: stuck }).run(
      ASK,
      (e) => events.push(e),
      abort.signal
    )
    await vi.waitFor(() => expect(events).toHaveLength(2))
    abort.abort()
    const err = await running.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TurnStopped)
    const partial = (err as TurnStopped).partial
    expect(partial.text).toBe('Hel')
    expect(partial.parts.thinking?.text).toBe('Hmm. ')
    expect(partial.stop).toBe('end')
  })

  it('stops before sending when already stopped', async () => {
    const net = network([streaming([said('x'), completed()])])
    const abort = new AbortController()
    abort.abort()
    const refusing = (async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return net.fetch(_url, init)
    }) as unknown as typeof fetch
    const err = await azureProvider({ endpoint: ENDPOINT, apiKey: KEY, load, fetch: refusing })
      .run(ASK, () => {}, abort.signal)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TurnStopped)
    expect(net.calls).toHaveLength(0)
  })
})

describe('complete (a one-off prompt)', () => {
  const answer = (text: string, over: object = {}): object => ({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text }] }
    ],
    usage: usage(),
    ...over
  })

  it('asks for no reasoning where it can, a short answer, and nothing stored', async () => {
    const net = network([jsonReply(answer('  A Title  '))])
    const got = await provider(net).complete(SOL, 'You name chats.', '<message>hi</message>')
    expect(got.text).toBe('A Title')
    expect(got.usage).toMatchObject({ input: 100, output: 20 })
    expect(net.calls[0].url).toBe(`${ENDPOINT}/openai/v1/responses`)
    expect(net.calls[0].headers['api-key']).toBe(KEY)
    expect(net.calls[0].body).toEqual({
      model: 'gpt-6-sol',
      store: false,
      input: [
        { role: 'developer', content: 'You name chats.' },
        { role: 'user', content: '<message>hi</message>' }
      ],
      reasoning: { effort: 'none' },
      max_output_tokens: 400
    })
  })

  it('leaves room for thinking on a model that cannot stop', async () => {
    const net = network([jsonReply(answer('T'))])
    const astra = modelOf('gpt-6-astra')
    await provider(net).complete(astra, 's', 'p', { maxOutput: 40 })
    expect(net.calls[0].body.reasoning).toEqual({ effort: 'low' })
    expect(net.calls[0].body.max_output_tokens).toBe(2_000)
  })

  it('honours the size asked for where thinking is off', async () => {
    const net = network([jsonReply(answer('T'))])
    await provider(net).complete(SOL, 's', 'p', { maxOutput: 40 })
    expect(net.calls[0].body.max_output_tokens).toBe(40)
  })

  it('sends no reasoning to a model without it', async () => {
    const net = network([jsonReply(answer('T'))])
    await provider(net).complete(modelOf('gpt-4.1'), 's', 'p')
    expect(net.calls[0].body).not.toHaveProperty('reasoning')
  })

  it('says so when the model ran out of room before writing anything', async () => {
    const net = network([
      jsonReply({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: []
      })
    ])
    await expect(provider(net).complete(SOL, 's', 'p')).rejects.toThrow(/ran out of room/)
  })

  it('turns a failure into a typed error', async () => {
    const failed = network([
      jsonReply({ status: 'failed', error: { code: 'server_error', message: 'Oops.' } })
    ])
    await expect(provider(failed).complete(SOL, 's', 'p')).rejects.toMatchObject({
      code: 'overloaded'
    })
    const missing = network([
      jsonReply({ error: { code: 'DeploymentNotFound', message: 'No.' } }, 404)
    ])
    await expect(provider(missing).complete(SOL, 's', 'p')).rejects.toMatchObject({
      code: 'not-found'
    })
  })

  it('passes the signal on', async () => {
    const seen: (AbortSignal | null | undefined)[] = []
    const fake = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal)
      return new Response(JSON.stringify(answer('T')), { status: 200 })
    }) as unknown as typeof fetch
    const abort = new AbortController()
    await azureProvider({ endpoint: ENDPOINT, apiKey: KEY, load, fetch: fake }).complete(
      SOL,
      's',
      'p',
      { signal: abort.signal }
    )
    expect(seen[0]).toBe(abort.signal)
  })
})

describe('sseEvents', () => {
  const read = async (body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = []
    for await (const e of sseEvents(body)) out.push(e)
    return out
  }

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r']
  ])('reads %s line endings, however the chunks cut them', async (_name, nl) => {
    // A payload over two data lines, and one whose type only the event line gives.
    const text =
      `event: a${nl}data: {"type":"a",${nl}data:  "n":1}${nl}${nl}` +
      `event: error${nl}data: {"message":"x"}${nl}${nl}`
    for (const size of [1, 2, 3, 64]) {
      expect(await read(chunked(text, size)), `${size} bytes at a time`).toEqual([
        { type: 'a', n: 1 },
        { type: 'error', message: 'x' }
      ])
    }
  })

  it('joins a payload over several data lines, and skips what is not a payload', async () => {
    const text = [
      ': keep-alive',
      'retry: 1000',
      'id: 7',
      'data: {"type":"a",',
      'data:  "n":1}',
      '',
      'data: [DONE]',
      '',
      'data: not json',
      '',
      'data: [1,2]',
      '',
      'data: {"type":"b"}',
      '',
      ''
    ].join('\n')
    expect(await read(chunked(text))).toEqual([{ type: 'a', n: 1 }, { type: 'b' }])
  })

  it('takes the type from the event line when the payload has none', async () => {
    expect(await read(chunked('event: error\ndata: {"message":"x"}\n\n'))).toEqual([
      { type: 'error', message: 'x' }
    ])
  })

  it('gives a last frame that never got its blank line, if it is whole', async () => {
    expect(await read(chunked('data: {"type":"a"}\n\ndata: {"type":"b"}'))).toEqual([
      { type: 'a' },
      { type: 'b' }
    ])
    expect(await read(chunked('data: {"type":"a"}\n\ndata: {"type":"b'))).toEqual([{ type: 'a' }])
    expect(await read(chunked('data: {"type":"a"}\r'))).toEqual([{ type: 'a' }])
  })

  it('hands over what came before a failure, then fails', async () => {
    const got: Record<string, unknown>[] = []
    const run = async (): Promise<void> => {
      for await (const e of sseEvents(chunked(['data: {"type":"a"}\n\n', new Error('reset')]))) {
        got.push(e)
      }
    }
    await expect(run()).rejects.toMatchObject({ code: 'unreachable' })
    expect(got).toEqual([{ type: 'a' }])
  })
})
