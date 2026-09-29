import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicMeter, peekModel, responsesMeter, type Meter } from '../src/meter.ts'

const enc = new TextEncoder()

// Feeds `text` in fixed-size byte chunks, so markers and multi-byte characters
// land across chunk boundaries the way real network reads split them.
function feed(meter: Meter, text: string, size: number): void {
  const bytes = enc.encode(text)
  for (let i = 0; i < bytes.length; i += size) meter.push(bytes.slice(i, i + size))
}

const sse = (events: [string, unknown][]): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const anthropicStream = (withFinal: boolean): string =>
  sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5',
          content: [],
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 30000,
            cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1500 },
            output_tokens: 1,
            service_tier: 'standard'
          }
        }
      }
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...Array.from({ length: 40 }, (): [string, unknown] => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello wörld, ✓ fine. ' } }
    ]),
    ...(withFinal
      ? ([
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 350, server_tool_use: { web_search_requests: 2 } }
            }
          ],
          ['message_stop', { type: 'message_stop' }]
        ] as [string, unknown][])
      : [])
  ])

test('anthropic: exact usage from message_start + message_delta across tiny chunks', () => {
  for (const size of [1, 7, 64, 100_000]) {
    const meter = anthropicMeter('text/event-stream; charset=utf-8')
    feed(meter, anthropicStream(true), size)
    const u = meter.finish(false)!
    assert.equal(u.model, 'claude-sonnet-5')
    assert.equal(u.inputTokens, 12)
    assert.equal(u.cachedTokens, 30000)
    assert.equal(u.cacheWrite5mTokens, 500)
    assert.equal(u.cacheWrite1hTokens, 1500)
    assert.equal(u.outputTokens, 350)
    assert.equal(u.webSearches, 2)
    assert.equal(u.serviceTier, 'standard')
    assert.equal(u.estimated, false)
  }
})

test('anthropic: interrupted reply keeps exact input and estimates output', () => {
  const meter = anthropicMeter('text/event-stream')
  feed(meter, anthropicStream(false), 13)
  const u = meter.finish(true)!
  assert.equal(u.inputTokens, 12)
  assert.equal(u.cachedTokens, 30000)
  assert.equal(u.estimated, true)
  // 40 deltas of ~21 visible chars ≈ 230 tokens; the estimate should be in range.
  assert.ok(u.outputTokens > 100 && u.outputTokens < 600, `got ${u.outputTokens}`)
})

test('anthropic: non-streaming JSON body', () => {
  const meter = anthropicMeter('application/json')
  feed(
    meter,
    JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }),
    5
  )
  const u = meter.finish(false)!
  assert.equal(u.model, 'claude-haiku-4-5-20251001')
  assert.equal(u.inputTokens, 50)
  assert.equal(u.outputTokens, 9)
})

test('anthropic: stream that never started is not billed', () => {
  const meter = anthropicMeter('text/event-stream')
  assert.equal(meter.finish(true), null)
})

const responsesStream = (withFinal: boolean): string =>
  sse([
    [
      'response.created',
      { type: 'response.created', response: { id: 'r1', status: 'in_progress', model: 'gpt-6-sol', usage: null } }
    ],
    ...Array.from({ length: 30 }, (): [string, unknown] => [
      'response.output_text.delta',
      { type: 'response.output_text.delta', delta: 'some "usage":{ text ', obfuscation: 'abc' }
    ]),
    ['response.web_search_call.completed', { type: 'response.web_search_call.completed', item_id: 'ws_1' }],
    ['response.web_search_call.completed', { type: 'response.web_search_call.completed', item_id: 'ws_2' }],
    ...(withFinal
      ? ([
          [
            'response.completed',
            {
              type: 'response.completed',
              response: {
                id: 'r1',
                status: 'completed',
                model: 'gpt-6-sol',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(50_000) }] }],
                tools: [{ type: 'function', name: 'shell', description: 'd'.repeat(20_000) }],
                service_tier: 'default',
                usage: {
                  input_tokens: 100_000,
                  input_tokens_details: { cached_tokens: 90_000 },
                  output_tokens: 1200,
                  output_tokens_details: { reasoning_tokens: 800 },
                  total_tokens: 101_200
                },
                user: null,
                metadata: {}
              }
            }
          ]
        ] as [string, unknown][])
      : [])
  ])

test('responses: exact usage from response.completed, big echoed output', () => {
  for (const size of [3, 997, 1_000_000]) {
    const meter = responsesMeter('text/event-stream', { model: 'gpt-6-sol', requestBytes: 400_000 })
    feed(meter, responsesStream(true), size)
    const u = meter.finish(false)!
    assert.equal(u.inputTokens, 10_000)
    assert.equal(u.cachedTokens, 90_000)
    assert.equal(u.outputTokens, 1200)
    assert.equal(u.reasoningTokens, 800)
    assert.equal(u.webSearches, 2)
    assert.equal(u.serviceTier, 'default')
    assert.equal(u.estimated, false)
  }
})

test('responses: interrupted reply is estimated from request size', () => {
  const meter = responsesMeter('text/event-stream', { model: 'gpt-6-astra', requestBytes: 40_000 })
  feed(meter, responsesStream(false), 11)
  const u = meter.finish(true)!
  assert.equal(u.estimated, true)
  assert.equal(u.inputTokens, 10_000)
  assert.equal(u.cachedTokens, 0)
  assert.ok(u.outputTokens > 0)
})

test('peekModel reads the first field without a full parse, falls back otherwise', () => {
  const big = { model: 'gpt-6-astra', input: 'y'.repeat(100_000) }
  assert.equal(peekModel(enc.encode(JSON.stringify(big)).buffer as ArrayBuffer), 'gpt-6-astra')
  const late = { input: [{ role: 'user', content: 'model' }], model: 'gpt-6-sol' }
  assert.equal(peekModel(enc.encode(JSON.stringify(late)).buffer as ArrayBuffer), 'gpt-6-sol')
  assert.equal(peekModel(enc.encode('not json').buffer as ArrayBuffer), null)
})

// The Workers free plan allows 10ms of CPU per request. Meter a long reply
// (~1.2 MB of SSE, a few thousand events, in realistic 1 KB network reads) and
// require it to stay far under that, leaving room for routing and auth.
test('cpu: metering a long reply stays well under the 10ms free-plan budget', () => {
  const longAnthropic = anthropicStream(false).replace(
    /(event: content_block_delta[\s\S]*?\n\n)/,
    (m) => m.repeat(9000)
  ) + anthropicStream(true).slice(anthropicStream(true).indexOf('event: message_delta'))
  const longResponses = responsesStream(true).replace(
    /(event: response\.output_text\.delta[\s\S]*?\n\n)/,
    (m) => m.repeat(9000)
  )
  const aBytes = enc.encode(longAnthropic)
  const rBytes = enc.encode(longResponses)
  const time = (fn: () => void): number => {
    fn() // warm the JIT, as a hot isolate would be
    return Math.min(...[0, 1, 2].map(() => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    }))
  }
  const anthropicMs = time(() => {
    const a = anthropicMeter('text/event-stream')
    for (let i = 0; i < aBytes.length; i += 1024) a.push(aBytes.subarray(i, i + 1024))
    assert.equal(a.finish(false)!.outputTokens, 350)
  })
  const responsesMs = time(() => {
    const r = responsesMeter('text/event-stream', { model: 'gpt-6-sol', requestBytes: 1 })
    for (let i = 0; i < rBytes.length; i += 1024) r.push(rBytes.subarray(i, i + 1024))
    assert.equal(r.finish(false)!.outputTokens, 1200)
  })
  const mb = (b: Uint8Array): string => (b.length / 1e6).toFixed(2)
  console.log(
    `  anthropic ${mb(aBytes)} MB: ${anthropicMs.toFixed(2)} ms; responses ${mb(rBytes)} MB: ${responsesMs.toFixed(2)} ms`
  )
  assert.ok(anthropicMs < 4 && responsesMs < 4, 'metering one long reply must stay under 4ms')
})

test('responses: cache writes and Azure tool_usage web search count', () => {
  const stream = sse([
    ['response.created', { type: 'response.created', response: { id: 'r', usage: null } }],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: 'r',
          usage: {
            input_tokens: 5000,
            input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1500 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 10 }
          },
          tool_usage: { web_search: { num_requests: 3 } }
        }
      }
    ]
  ])
  const meter = responsesMeter('text/event-stream', { model: 'gpt-6-sol', requestBytes: 1 })
  feed(meter, stream, 17)
  const u = meter.finish(false)!
  assert.equal(u.inputTokens, 500)
  assert.equal(u.cachedTokens, 3000)
  assert.equal(u.cacheWrite5mTokens, 1500)
  assert.equal(u.webSearches, 3)
  assert.equal(u.reasoningTokens, 10)
})

test('anthropic: iterations become separate lines; cache total moves in message_delta', () => {
  const stream = sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
            output_tokens: 1,
            speed: 'fast'
          }
        }
      }
    ],
    [
      'message_delta',
      {
        type: 'message_delta',
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 150,
          output_tokens: 70,
          iterations: [
            { type: 'compaction', model: 'claude-haiku-4-5', input_tokens: 400, output_tokens: 30 },
            { type: 'message', input_tokens: 20, cache_creation_input_tokens: 150, output_tokens: 70 }
          ]
        }
      }
    ]
  ])
  const meter = anthropicMeter('text/event-stream')
  feed(meter, stream, 9)
  const u = meter.finish(false)!
  assert.equal(u.speed, 'fast')
  assert.equal(u.lines.length, 2)
  assert.equal(u.lines[0].model, 'claude-haiku-4-5')
  assert.equal(u.lines[1].model, 'claude-opus-5-5')
  assert.equal(u.inputTokens, 420)
  assert.equal(u.outputTokens, 100)

  // Without iterations, a moved cache total lands on the TTL already in use.
  const plain = anthropicMeter('text/event-stream')
  feed(plain, stream.replace(/,"iterations":\[.*?\]\]?/, '').replace(/"iterations":\[[^\]]*\],?/, ''), 50)
  const p = plain.finish(false)!
  assert.equal(p.lines.length, 1)
  assert.equal(p.cacheWrite1hTokens, 150)
  assert.equal(p.cacheWrite5mTokens, 0)
})
