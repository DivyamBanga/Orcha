import { describe, expect, it, vi } from 'vitest'
import type { ChatModel } from '../../../shared/ai'
import { TurnStopped, type ClientTool, type ProviderTurn, type ToolRunner } from '../provider'
import { anthropicApiProvider, type ApiTurnResult } from './anthropicApi'
import { RefusalError } from './anthropicErrors'
import {
  chatModel,
  citing,
  delta,
  finish,
  handoff,
  loadStub,
  ping,
  providerError,
  rejection,
  results,
  search,
  setup,
  spoken,
  start,
  stream,
  text,
  thought,
  toolCall,
  turnOf,
  open,
  close,
  sse,
  type Answer,
  type Ev,
  type Sent
} from './anthropicTestKit'

// Streaming, tool and refusal behaviour of Claude on an API key, against
// replies written out by hand from Anthropic's documented event shapes.

const opus = chatModel('claude-opus-5-5')
const haiku = chatModel('claude-haiku-5-5')
const turn = (model: ChatModel = opus, extra: Partial<ProviderTurn> = {}): ProviderTurn =>
  turnOf(model, {}, extra)

describe('a plain reply', () => {
  it('streams the words and reports what it used, bucket by bucket', async () => {
    const { run, events } = setup(
      stream(
        [
          start({
            usage: {
              input_tokens: 25,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 40,
              cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 }
            }
          }),
          ping
        ],
        text(0, 'Hel', 'lo ', 'wörld'),
        finish('end_turn', {
          input_tokens: 25,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 40,
          output_tokens: 15,
          output_tokens_details: { thinking_tokens: 0 }
        })
      )
    )
    const result = await run(turn())
    expect(result.text).toBe('Hello wörld')
    expect(spoken(events)).toBe('Hello wörld')
    expect(result.stop).toBe('end')
    expect(result.model).toBe('claude-opus-5-5')
    expect(result.parts).toEqual({})
    expect(result.usage).toEqual({
      input: 25,
      cacheRead: 100,
      cacheWrite5m: 30,
      cacheWrite1h: 10,
      cacheWrite: 0,
      output: 15,
      reasoning: 0,
      webSearches: 0,
      longContext: false
    })
    expect(result.ttftMs).toBeGreaterThanOrEqual(0)
    expect(result.calls).toEqual([{ model: 'claude-opus-5-5', usage: result.usage }])
  })

  it('counts cache writes as 5-minute ones when the API sends only the total', async () => {
    const { run } = setup(
      stream(
        [start({ usage: { cache_creation_input_tokens: 40 } })],
        text(0, 'x'),
        finish('end_turn', { cache_creation_input_tokens: 40 })
      )
    )
    const { usage } = await run(turn())
    expect(usage).toMatchObject({ cacheWrite5m: 40, cacheWrite1h: 0 })
  })

  it('marks a Haiku 5.5 request whose whole prompt passes 100K as long-context', async () => {
    const long = (input: number, cached: number, model: string): Ev[] => [
      start({ model, usage: { input_tokens: input, cache_read_input_tokens: cached } }),
      ...text(0, 'x'),
      ...finish('end_turn', { input_tokens: input, cache_read_input_tokens: cached })
    ]
    const small = await setup(stream(long(50_000, 20_000, 'claude-haiku-5-5'))).run(turn(haiku))
    const big = await setup(stream(long(90_000, 20_000, 'claude-haiku-5-5'))).run(turn(haiku))
    const other = await setup(stream(long(900_000, 0, 'claude-opus-5-5'))).run(turn(opus))
    expect(small.usage?.longContext).toBe(false)
    expect(big.usage?.longContext).toBe(true)
    expect(other.usage?.longContext).toBe(false)
  })

  it('says why it stopped when it ran out of room', async () => {
    const cut = await setup(stream([start()], text(0, 'Half an'), finish('max_tokens'))).run(turn())
    expect(cut).toMatchObject({ text: 'Half an', stop: 'max-tokens' })
    const full = await setup(
      stream([start()], text(0, 'Long'), finish('model_context_window_exceeded'))
    ).run(turn())
    expect(full).toMatchObject({ text: 'Long', stop: 'context-full' })
  })

  it('sends the key as a bearer token, the dated API version and the beta it needs', async () => {
    const { run, sent } = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    await run(turn(opus))
    const [call] = sent
    expect(call.url).toBe('http://anthropic.test/v1/messages?beta=true')
    expect(call.headers.get('authorization')).toBe('Bearer sk-ant-test-key')
    expect(call.headers.get('anthropic-version')).toBe('2026-10-21')
    expect(call.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01')
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 64_000,
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: [{ role: 'user', content: 'hi' }]
    })
    for (const key of ['temperature', 'top_p', 'top_k']) expect(call.body).not.toHaveProperty(key)
  })

  it('asks for no beta where the model has no use for one', async () => {
    const { run, sent } = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    await run(turn(haiku))
    expect(sent[0].headers.get('anthropic-beta')).toBeNull()
    expect(sent[0].body).not.toHaveProperty('fallbacks')
  })

  it('never lets the environment decide where the key goes', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://somewhere-else.test')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'a-token-from-the-environment')
    vi.stubEnv('ANTHROPIC_API_KEY', 'a-key-from-the-environment')
    try {
      const sent: Pick<Sent, 'url' | 'headers'>[] = []
      const provider = anthropicApiProvider({
        apiKey: 'sk-ant-test-key',
        load: loadStub,
        fetch: async (input, init) => {
          sent.push({ url: String(input), headers: new Headers(init?.headers) })
          return stream([start()], text(0, 'x'), finish('end_turn'))()
        }
      })
      await provider.run(turn(), () => {}, new AbortController().signal)
      expect(sent[0].url.startsWith('https://api.anthropic.com/v1/messages')).toBe(true)
      expect(sent[0].headers.get('authorization')).toBe('Bearer sk-ant-test-key')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('reasoning', () => {
  it('shows the summary, one paragraph per thought', async () => {
    const { run, events } = setup(
      stream(
        [start()],
        thought(0, 'Checking the units.'),
        thought(1, 'Then converting.'),
        text(2, 'Answer.'),
        finish('end_turn', { output_tokens: 40, output_tokens_details: { thinking_tokens: 25 } })
      )
    )
    const result = await run(turn())
    const shown = events.flatMap((e) => (e.kind === 'thinking' ? [e.delta] : []))
    expect(shown).toEqual(['Checking the units.', '\n\nThen converting.'])
    expect(result.parts.thinking?.text).toBe('Checking the units.\n\nThen converting.')
    expect(result.parts.thinking?.ms).toBeGreaterThanOrEqual(0)
    expect(result.text).toBe('Answer.')
    expect(result.usage).toMatchObject({ output: 40, reasoning: 25 })
  })

  it('says nothing about reasoning that came back empty', async () => {
    const { run, events } = setup(
      stream([start()], thought(0, ''), text(1, 'Hi.'), finish('end_turn'))
    )
    const result = await run(turn())
    expect(result.parts).toEqual({})
    expect(events.some((e) => e.kind === 'thinking')).toBe(false)
  })
})

describe('searching the web', () => {
  const A = 'https://en.wikipedia.org/wiki/Claude_Shannon'
  const B = 'https://www.britannica.com/biography/Claude-Shannon'
  const C = 'https://example.com/shannon'
  const cite = (n: number, url: string): string => ` [${n}](<${url}> "cite")`

  const searched: Ev[] = [
    start(),
    ...text(0, "I'll look that up."),
    ...search(1, 'srvtoolu_1', 'claude shannon birth date'),
    ...results(2, 'srvtoolu_1', [
      [A, 'Wikipedia'],
      [B, 'Britannica'],
      [C, 'Elsewhere']
    ]),
    ...citing(3, 'Claude Shannon was born on April 30, 1916', B, 'Britannica'),
    ...text(4, ' in Petoskey, Michigan.'),
    ...citing(5, ' He founded information theory', A, 'Wikipedia'),
    ...finish('end_turn', { output_tokens: 90, server_tool_use: { web_search_requests: 1 } })
  ]

  it('shows the search, puts citations after their claims, and lists the pages', async () => {
    const { run, events } = setup(stream(searched))
    const result = await run(turn(opus, { settings: { ...turn().settings, webSearch: true } }))
    expect(result.text).toBe(
      "I'll look that up.\n\n" +
        'Claude Shannon was born on April 30, 1916' +
        cite(1, B) +
        ' in Petoskey, Michigan.' +
        ' He founded information theory' +
        cite(2, A)
    )
    expect(spoken(events)).toBe(result.text)
    // Cited pages come first, in the order cited, so the chips count from 1;
    // the pages the search found and the reply never cited follow.
    expect(result.parts.sources).toEqual([
      { url: B, title: 'Britannica' },
      { url: A, title: 'Wikipedia' },
      { url: C, title: 'Elsewhere' }
    ])
    // The row names the query, and comes as soon as it is known.
    const row = events.findIndex((e) => e.kind === 'tool')
    expect(events[row]).toEqual({
      kind: 'tool',
      tool: { kind: 'search', label: 'Searching: claude shannon birth date' }
    })
    expect(events.slice(0, row).every((e) => e.kind === 'text')).toBe(true)
    expect(result.usage?.webSearches).toBe(1)
  })

  it('goes on in a new paragraph after a search, but not between a claim and its citation', async () => {
    const { run } = setup(stream(searched))
    const result = await run(turn())
    expect(result.text.split('\n\n')).toHaveLength(2)
  })

  it('links a source only once however often it is cited', async () => {
    const { run } = setup(
      stream(
        [start()],
        citing(0, 'One.', A, 'Wikipedia'),
        citing(1, ' Two.', A, 'Wikipedia'),
        finish('end_turn')
      )
    )
    const result = await run(turn())
    expect(result.parts.sources).toEqual([{ url: A, title: 'Wikipedia' }])
    expect(result.text).toBe(`One.${cite(1, A)} Two.${cite(1, A)}`)
  })

  it('gives a claim one chip per source, however many of its citations point there', async () => {
    const twice = (url: string): Ev => ({
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url,
        title: 'T',
        encrypted_index: 'i',
        cited_text: 'c'
      }
    })
    const { run } = setup(
      stream(
        [start()],
        [open(0, { type: 'text', text: '' })],
        [delta(0, { type: 'text_delta', text: 'Claim.' }), delta(0, twice(A)), delta(0, twice(B))],
        [delta(0, twice(A)), close(0)],
        finish('end_turn')
      )
    )
    const result = await run(turn())
    // Two sources, each once: " [1][2]".
    expect(result.text).toBe(`Claim.${cite(1, A)}${cite(2, B).slice(1)}`)
  })

  it('starts the words after a search flush left, whatever space they began with', async () => {
    const { run } = setup(
      stream(
        [start()],
        text(0, 'Let me look.'),
        search(1, 'srv_1', 'anything'),
        text(2, '  Found it.'),
        finish('end_turn')
      )
    )
    expect((await run(turn())).text).toBe('Let me look.\n\nFound it.')
  })

  it('keeps a long query to a line in the search row', async () => {
    const query = 'what '.repeat(30).trim()
    const { run, events } = setup(
      stream([start()], search(0, 'srv_1', query), text(1, 'x'), finish('end_turn'))
    )
    await run(turn())
    const row = events.find((e) => e.kind === 'tool')
    const label = row?.kind === 'tool' ? row.tool.label : ''
    expect(label).toBe(`Searching: ${query.slice(0, 79)}…`)
    expect(label.length).toBe('Searching: '.length + 80)
  })

  it('keeps an odd URL from breaking its chip', async () => {
    const odd = 'https://example.com/a b<c>'
    const { run } = setup(stream([start()], citing(0, 'Claim.', odd, 'Odd'), finish('end_turn')))
    const result = await run(turn())
    expect(result.text).toBe('Claim. [1](<https://example.com/a%20b%3Cc%3E> "cite")')
  })

  it('treats a search that failed as no sources', async () => {
    const { run } = setup(
      stream(
        [start()],
        search(0, 'srv_1', 'something odd'),
        [
          open(1, {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
          }),
          close(1)
        ],
        text(2, 'I could not search.'),
        finish('end_turn')
      )
    )
    const result = await run(turn())
    expect(result.parts).toEqual({})
    expect(result.text).toBe('I could not search.')
  })
})

describe('a search that pauses the turn', () => {
  it('is sent back as it was, with nothing added, and the answer carries on', async () => {
    const page = 'https://example.com/a'
    const { run, sent } = setup(
      stream(
        [start()],
        text(0, 'Searching now.'),
        search(1, 'srv_1', 'topic a'),
        results(2, 'srv_1', [[page, 'A']]),
        finish('pause_turn', { output_tokens: 20, server_tool_use: { web_search_requests: 1 } })
      ),
      stream(
        [start()],
        text(0, 'Here is what I found.'),
        finish('end_turn', { output_tokens: 30, server_tool_use: { web_search_requests: 1 } })
      )
    )
    const result = await run(turn())
    expect(sent).toHaveLength(2)
    expect(sent[1].body.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching now.' },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'topic a' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [
              {
                type: 'web_search_result',
                url: page,
                title: 'A',
                encrypted_content: 'enc-A',
                page_age: null
              }
            ]
          }
        ]
      }
    ])
    expect(result.text).toBe('Searching now.\n\nHere is what I found.')
    expect(result.usage).toMatchObject({ output: 50, webSearches: 2 })
    expect(result.calls).toHaveLength(2)
    expect(result.parts.sources).toEqual([{ url: page, title: 'A' }])
  })

  it('goes on in a new paragraph when a pause came right after it spoke', async () => {
    const { run } = setup(
      stream([start()], text(0, 'First part.'), finish('pause_turn')),
      stream([start()], text(0, 'Second part.'), finish('end_turn'))
    )
    expect((await run(turn())).text).toBe('First part.\n\nSecond part.')
  })
})

describe('Orcha’s own tools', () => {
  const recall: ClientTool = {
    name: 'recall',
    description: 'Look something up in memory',
    schema: { type: 'object', properties: { topic: { type: 'string' } } }
  }
  const withTools = (model: ChatModel = opus): ProviderTurn => turn(model, { tools: [recall] })
  const asksForTool = (): Ev[][] => [
    [start()],
    thought(0, 'I should look in memory.', 'signature-1'),
    text(1, 'One moment.'),
    toolCall(2, 'toolu_1', 'recall', { topic: 'cats' }),
    finish('tool_use', { output_tokens: 30 })
  ]
  // The assistant and user messages a second call carries.
  const secondCall = (sent: Sent[]): { role: string; content: Ev[] }[] =>
    sent[1].body.messages as { role: string; content: Ev[] }[]

  it('are called, and answered, before the reply goes on', async () => {
    const { run, sent } = setup(
      stream(...asksForTool()),
      stream([start()], text(0, 'You like cats.'), finish('end_turn', { output_tokens: 8 }))
    )
    const calls: unknown[] = []
    const runTool: ToolRunner = async (call) => {
      calls.push(call)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return `found ${(call.input as { topic: string }).topic}`
    }
    const result = await run(withTools(), runTool)
    expect(calls).toEqual([{ name: 'recall', input: { topic: 'cats' } }])
    // What it said and did goes back as it was (signature and all), then the answer.
    expect(sent[1].body.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should look in memory.', signature: 'signature-1' },
          { type: 'text', text: 'One moment.' },
          { type: 'tool_use', id: 'toolu_1', name: 'recall', input: { topic: 'cats' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found cats' }]
      }
    ])
    // The same tools, in both calls.
    expect(sent[0].body.tools).toEqual([
      { name: 'recall', description: recall.description, input_schema: recall.schema }
    ])
    expect(sent[1].body.tools).toEqual(sent[0].body.tools)
    expect(result.text).toBe('One moment.\n\nYou like cats.')
    expect(result.usage?.output).toBe(38)
    expect(result.stop).toBe('end')
  })

  it('answer several calls in one message, one after the other', async () => {
    const order: string[] = []
    const { run, sent } = setup(
      stream(
        [start()],
        toolCall(0, 'toolu_a', 'recall', { topic: 'a' }),
        toolCall(1, 'toolu_b', 'recall', { topic: 'b' }),
        finish('tool_use')
      ),
      stream([start()], text(0, 'Done.'), finish('end_turn'))
    )
    await run(withTools(), async ({ input }) => {
      const topic = (input as { topic: string }).topic
      order.push(`start ${topic}`)
      await new Promise((resolve) => setTimeout(resolve, topic === 'a' ? 15 : 1))
      order.push(`end ${topic}`)
      return topic.toUpperCase()
    })
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
    expect(secondCall(sent)[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' }
    ])
  })

  it('that fail tell Claude, and the turn goes on', async () => {
    const { run, sent } = setup(
      stream(...asksForTool()),
      stream([start()], text(0, 'Never mind.'), finish('end_turn'))
    )
    const result = await run(withTools(), async () => {
      throw new Error('Memory is switched off.')
    })
    expect(secondCall(sent)[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'Memory is switched off.',
        is_error: true
      }
    ])
    expect(result.text).toBe('One moment.\n\nNever mind.')
  })

  it('are not offered when nothing can answer them', async () => {
    const quiet = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    await quiet.run(withTools())
    expect(quiet.sent[0].body).not.toHaveProperty('tools')

    const unable = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    await unable.run(withTools(chatModel('claude-opus-5-5', { tools: false })), async () => 'x')
    expect(unable.sent[0].body).not.toHaveProperty('tools')
  })

  it('are cut off after eight calls to the model', async () => {
    const { run, sent } = setup(stream(...asksForTool()))
    let answered = 0
    const result = await run(withTools(), async () => String(++answered))
    expect(sent).toHaveLength(8)
    // The last call's tool use is not run: there'd be no call left to hear it.
    expect(answered).toBe(7)
    expect(result.stop).toBe('end')
    expect(result.calls).toHaveLength(8)
    expect(result.text.split('One moment.')).toHaveLength(9)
  })

  it('go back without empty text blocks, which the API refuses', async () => {
    const { run, sent } = setup(
      stream(
        [start()],
        text(0),
        text(1, '  '),
        toolCall(2, 'toolu_1', 'recall', { topic: 'x' }),
        finish('tool_use')
      ),
      stream([start()], text(0, 'ok'), finish('end_turn'))
    )
    await run(withTools(), async () => 'fine')
    expect(secondCall(sent)[1].content.map((b) => b.type)).toEqual(['tool_use'])
  })

  it('that Claude calls anyway, with nothing to answer them, end the turn where it is', async () => {
    const { run, sent } = setup(stream(...asksForTool()))
    const result = await run(withTools())
    expect(sent).toHaveLength(1)
    expect(result.text).toBe('One moment.')
  })

  it('stop the turn if it was stopped while one ran', async () => {
    const { run } = setup(stream(...asksForTool()))
    const stop = new AbortController()
    const err = await rejection(
      run(
        withTools(),
        async () => {
          stop.abort()
          return 'too late'
        },
        stop.signal
      )
    )
    expect(err).toBeInstanceOf(TurnStopped)
    expect((err as TurnStopped).partial.text).toBe('One moment.')
  })
})

describe('a refusal', () => {
  const declined = (model: string, extra: Ev = {}): Ev[][] => [
    [start({ model, usage: { input_tokens: 412 } })],
    finish(
      'refusal',
      { input_tokens: 412, output_tokens: 0 },
      {
        stop_details: {
          type: 'refusal',
          category: 'cyber',
          explanation: 'This request was declined because it could enable cyber harm.',
          recommended_model: null,
          ...extra
        }
      }
    )
  ]

  it('that stands is an error that carries its category and what it cost', async () => {
    const { run } = setup(stream(...declined('claude-haiku-5-5')))
    const err = await providerError(run(turn(haiku)))
    expect(err).toBeInstanceOf(RefusalError)
    const refusal = err as RefusalError
    expect(refusal.code).toBe('refused')
    expect(refusal.category).toBe('cyber')
    expect(refusal.recommendedModel).toBeNull()
    expect(refusal.usage).toMatchObject({ input: 412, output: 0 })
    expect(refusal.model).toBe('claude-haiku-5-5')
    expect(refusal.message).toBe(
      'Claude declined to answer this one. This request was declined because it could enable cyber harm. Try rephrasing it, or ask another model.'
    )
  })

  it('names the model the API suggests when it could not make the fallback itself', async () => {
    const { run } = setup(
      stream(...declined('claude-opus-5-5', { recommended_model: 'claude-opus-4-8' }))
    )
    const err = (await providerError(run(turn()))) as RefusalError
    expect(err.recommendedModel).toBe('claude-opus-4-8')
  })

  it('answered by a fallback model is an ordinary reply, priced model by model', async () => {
    const iterations = [
      {
        type: 'message',
        model: 'claude-opus-5-5',
        input_tokens: 535,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      },
      {
        type: 'fallback_message',
        model: 'claude-opus-4-8',
        input_tokens: 412,
        output_tokens: 264,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    ]
    const { run } = setup(
      stream(
        [start({ model: 'claude-opus-4-8' })],
        handoff(0, 'claude-opus-5-5', 'claude-opus-4-8'),
        text(1, 'Hi! How can I help you today?'),
        finish('end_turn', { input_tokens: 412, output_tokens: 264, iterations })
      )
    )
    const result = await run(turn())
    expect(result.text).toBe('Hi! How can I help you today?')
    expect(result.stop).toBe('end')
    expect(result.model).toBe('claude-opus-4-8')
    // Every attempt is billed: the declined one at its model's rates too.
    expect(result.usage).toMatchObject({ input: 535 + 412, output: 264 })
    expect(result.calls.map((c) => [c.model, c.usage.input, c.usage.output])).toEqual([
      ['claude-opus-5-5', 535, 0],
      ['claude-opus-4-8', 412, 264]
    ])
  })

  it('part-way through a reply carries on from the words already shown', async () => {
    const { run, events } = setup(
      stream(
        [start()],
        text(0, 'The answer is'),
        handoff(1, 'claude-opus-5-5', 'claude-opus-4-8'),
        text(2, ' 42.'),
        finish('end_turn')
      )
    )
    const result = await run(turn())
    expect(result.text).toBe('The answer is 42.')
    expect(spoken(events)).toBe('The answer is 42.')
    // The model the stream began with is not the one that finished it.
    expect(result.model).toBe('claude-opus-4-8')
  })

  it('goes back to Claude, on a later call of the turn, without what the declining model left', async () => {
    const recall: ClientTool = { name: 'recall', description: 'd', schema: { type: 'object' } }
    const { run, sent } = setup(
      stream(
        [start()],
        thought(0, 'Thinking that the first model did.'),
        handoff(1, 'claude-opus-5-5', 'claude-opus-4-8'),
        text(2, 'Let me check.'),
        toolCall(3, 'toolu_1', 'recall', { topic: 'x' }),
        finish('tool_use')
      ),
      stream([start()], text(0, 'Done.'), finish('end_turn'))
    )
    await run(turn(opus, { tools: [recall] }), async () => 'fine')
    const echoed = (sent[1].body.messages as { content: Ev[] }[])[1].content
    expect(echoed.map((b) => b.type)).toEqual(['fallback', 'text', 'tool_use'])
  })
})

describe('stopping a reply', () => {
  // Some words, then nothing more: the connection stays open until the client lets go.
  const holding: Answer = (signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const first = sse([
          start({ usage: { input_tokens: 777 } }),
          ...text(0, 'Hello').slice(0, 2)
        ])
        controller.enqueue(new TextEncoder().encode(first))
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('', 'AbortError'))
        )
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  it('keeps the words so far and what the call has cost', async () => {
    const { provider } = setup(holding)
    const stop = new AbortController()
    const err = await rejection(
      provider.run(
        turn(),
        (e) => {
          if (e.kind === 'text') stop.abort()
        },
        stop.signal
      )
    )
    expect(err).toBeInstanceOf(TurnStopped)
    const partial = (err as TurnStopped).partial as ApiTurnResult
    expect(partial.text).toBe('Hello')
    // The prompt is known from the start of the call, and is billed.
    expect(partial.usage?.input).toBe(777)
    expect(partial.calls).toHaveLength(1)
    expect(partial.model).toBe('claude-opus-5-5')
  })

  it('before anything has arrived leaves an empty reply', async () => {
    const { run } = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    const stop = new AbortController()
    stop.abort()
    const err = await rejection(run(turn(), undefined, stop.signal))
    expect(err).toBeInstanceOf(TurnStopped)
    expect((err as TurnStopped).partial).toMatchObject({ text: '', usage: null })
  })
})
