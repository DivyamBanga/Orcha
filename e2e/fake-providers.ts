// One local HTTP server that speaks enough of Anthropic Messages (SSE), Azure
// Responses (SSE) and Ollama (NDJSON) for the app to chat end to end without a
// key or a network. What it answers is chosen by markers in the last user
// message, so a test says what it wants by what it types:
//
//   ORCHA_THINK      the reply is preceded by reasoning
//   ORCHA_SLOW       chunks arrive 250 ms apart (time to hit Stop)
//   ORCHA_LONG       a long multi-paragraph reply
//   ORCHA_ERROR_401  rejected key
//   ORCHA_ERROR_429  rate limited (retry-after: 1)
//   ORCHA_ERROR_529  overloaded
//   ORCHA_ERROR_500  server error
//   ORCHA_NO_CREDIT  out of credit (Anthropic's 'usage limits' 400)
//
// With no marker the reply is `Fake reply: <prompt>`. Every request is kept in
// `requests` so a test can check what the app actually sent.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ProviderKind = 'anthropic' | 'azure' | 'ollama'

export interface RecordedRequest {
  provider: ProviderKind
  method: string
  path: string
  body: unknown
}

export interface FakeProviders {
  /** http://127.0.0.1:<port> */
  url: string
  anthropicUrl: string
  azureUrl: string
  ollamaUrl: string
  requests: RecordedRequest[]
  /** Values for the ORCHA_E2E_*_URL variables. */
  env: Record<string, string>
  close(): Promise<void>
}

export const MARKERS = {
  think: 'ORCHA_THINK',
  slow: 'ORCHA_SLOW',
  long: 'ORCHA_LONG',
  error401: 'ORCHA_ERROR_401',
  error429: 'ORCHA_ERROR_429',
  error529: 'ORCHA_ERROR_529',
  error500: 'ORCHA_ERROR_500',
  noCredit: 'ORCHA_NO_CREDIT'
} as const

const THINKING = 'Let me think about that for a moment.'
const LONG = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog.`
).join('\n\n')

interface Plan {
  error?: { status: number; type: string; message: string; headers?: Record<string, string> }
  thinking?: string
  chunks: string[]
  delayMs: number
}

// ---------------------------------------------------------------- prompt

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = part as { text?: unknown; content?: unknown }
      return typeof p.text === 'string' ? p.text : textOf(p.content)
    })
    .join('\n')
}

function lastUserText(body: unknown): string {
  const b = (body ?? {}) as { messages?: unknown; input?: unknown }
  if (typeof b.input === 'string') return b.input
  const list = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] as { role?: string; content?: unknown }
    if (m.role === 'user') return textOf(m.content)
  }
  return ''
}

function plan(prompt: string): Plan {
  const has = (m: string): boolean => prompt.includes(m)
  const err = (
    status: number,
    type: string,
    message: string,
    headers?: Record<string, string>
  ): Plan => ({ error: { status, type, message, headers }, chunks: [], delayMs: 0 })
  if (has(MARKERS.error401)) return err(401, 'authentication_error', 'invalid x-api-key')
  if (has(MARKERS.error429)) {
    return err(429, 'rate_limit_error', 'Rate limited', { 'retry-after': '1' })
  }
  if (has(MARKERS.error529)) return err(529, 'overloaded_error', 'Overloaded')
  if (has(MARKERS.error500)) return err(500, 'api_error', 'Internal server error')
  if (has(MARKERS.noCredit)) {
    return err(400, 'invalid_request_error', 'You have reached your specified API usage limits.')
  }
  const text = has(MARKERS.long) ? LONG : `Fake reply: ${prompt.trim()}`
  // Word-sized chunks so streaming has something to stream.
  const chunks = text.match(/\S+\s*/g) ?? [text]
  return {
    thinking: has(MARKERS.think) ? THINKING : undefined,
    chunks,
    delayMs: has(MARKERS.slow) ? 250 : 0
  }
}

// ---------------------------------------------------------------- helpers

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

// Writes pieces with a pause between them, stopping quietly if the client
// went away (Stop in the app closes the connection).
async function stream(
  res: ServerResponse,
  pieces: string[],
  delayMs: number,
  contentType: string
): Promise<void> {
  let gone = false
  res.on('close', () => (gone = true))
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' })
  for (const piece of pieces) {
    if (gone) return
    res.write(piece)
    if (delayMs) await sleep(delayMs)
  }
  if (!gone) res.end()
}

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

// ---------------------------------------------------------------- Anthropic

function anthropicPieces(model: string, p: Plan): string[] {
  const out = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 1 }
      }
    })
  ]
  let index = 0
  if (p.thinking) {
    out.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: p.thinking }
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'fake-signature' }
      }),
      sse('content_block_stop', { type: 'content_block_stop', index })
    )
    index++
  }
  out.push(
    sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    })
  )
  for (const text of p.chunks) {
    out.push(
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
      })
    )
  }
  out.push(
    sse('content_block_stop', { type: 'content_block_stop', index }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: p.chunks.length + 3 }
    }),
    sse('message_stop', { type: 'message_stop' })
  )
  return out
}

// ---------------------------------------------------------------- Azure

function azurePieces(model: string, p: Plan): string[] {
  const base = { id: 'resp_fake', object: 'response', model, status: 'in_progress' }
  const out = [sse('response.created', { type: 'response.created', response: base })]
  let outputIndex = 0
  if (p.thinking) {
    out.push(
      sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { type: 'reasoning', id: 'rs_fake', summary: [] }
      }),
      sse('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_fake',
        output_index: outputIndex,
        summary_index: 0,
        delta: p.thinking
      }),
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'reasoning',
          id: 'rs_fake',
          summary: [{ type: 'summary_text', text: p.thinking }]
        }
      })
    )
    outputIndex++
  }
  out.push(
    sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: 'msg_fake', role: 'assistant', content: [] }
    })
  )
  for (const delta of p.chunks) {
    out.push(
      sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_fake',
        output_index: outputIndex,
        content_index: 0,
        delta
      })
    )
  }
  out.push(
    sse('response.completed', {
      type: 'response.completed',
      response: {
        ...base,
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_fake',
            role: 'assistant',
            content: [{ type: 'output_text', text: p.chunks.join('') }]
          }
        ],
        usage: { input_tokens: 12, output_tokens: p.chunks.length + 3, total_tokens: 15 }
      }
    })
  )
  return out
}

// ---------------------------------------------------------------- Ollama

function ollamaPieces(model: string, p: Plan): string[] {
  const at = (message: object, done = false, extra: object = {}): string =>
    JSON.stringify({ model, created_at: new Date().toISOString(), message, done, ...extra }) + '\n'
  const out: string[] = []
  if (p.thinking) out.push(at({ role: 'assistant', content: '', thinking: p.thinking }))
  for (const content of p.chunks) out.push(at({ role: 'assistant', content }))
  out.push(
    at({ role: 'assistant', content: '' }, true, {
      done_reason: 'stop',
      total_duration: 1_000_000,
      prompt_eval_count: 12,
      eval_count: p.chunks.length + 3
    })
  )
  return out
}

// ---------------------------------------------------------------- server

// The models a fake Anthropic key reaches, and the one deployment on the fake
// Azure resource.
const ANTHROPIC_MODELS = [
  {
    type: 'model',
    id: 'claude-haiku-5-5',
    display_name: 'Claude Haiku 5.5',
    created_at: '2026-09-01T00:00:00Z',
    max_input_tokens: 200_000,
    max_tokens: 64_000
  },
  {
    type: 'model',
    id: 'claude-sonnet-5-5',
    display_name: 'Claude Sonnet 5.5',
    created_at: '2026-09-01T00:00:00Z',
    max_input_tokens: 1_000_000,
    max_tokens: 64_000
  }
]
export const AZURE_DEPLOYED = ['gpt-6-sol']

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  requests: RecordedRequest[]
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const [, first, ...rest] = url.pathname.split('/')
  const provider = first as ProviderKind
  const path = '/' + rest.join('/')
  if (provider !== 'anthropic' && provider !== 'azure' && provider !== 'ollama') {
    return sendJson(res, 404, { error: 'unknown fake provider' })
  }
  const body = req.method === 'POST' ? await readBody(req) : null
  requests.push({ provider, method: req.method ?? 'GET', path, body })
  const model = (body as { model?: string } | null)?.model ?? 'fake-model'

  // What Settings asks when a key or Azure is added. A key with "bad" in it
  // is refused. (Anthropic's SDK sends its key as a bearer token since 1.0.)
  const key = String(
    req.headers['x-api-key'] ?? req.headers['api-key'] ?? req.headers.authorization ?? ''
  )
  if (provider !== 'ollama' && key.includes('bad')) {
    return sendJson(
      res,
      401,
      provider === 'azure'
        ? { error: { code: '401', message: 'Access denied due to invalid subscription key.' } }
        : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    )
  }
  if (provider === 'anthropic' && req.method === 'GET' && path === '/v1/models') {
    return sendJson(res, 200, {
      data: ANTHROPIC_MODELS,
      has_more: false,
      first_id: ANTHROPIC_MODELS[0].id,
      last_id: ANTHROPIC_MODELS[ANTHROPIC_MODELS.length - 1].id
    })
  }
  if (provider === 'azure') {
    if (req.method === 'GET' && path === '/openai/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [] })
    }
    // Only AZURE_DEPLOYED exists; anything else is the "no such deployment"
    // a probe looks for. A request that can't succeed (the probe's: not
    // streamed, too few output tokens) is refused as invalid, never answered.
    if (req.method === 'POST') {
      const named = (body as { model?: string } | null)?.model
      if (!named || !AZURE_DEPLOYED.includes(named)) {
        return sendJson(res, 404, {
          error: {
            code: 'DeploymentNotFound',
            message: 'The API deployment for this resource does not exist.'
          }
        })
      }
      if (!(body as { stream?: boolean }).stream) {
        return sendJson(res, 400, {
          error: { code: 'integer_below_min_value', message: 'max_output_tokens is too small.' }
        })
      }
    }
  }

  if (provider === 'ollama') {
    if (path === '/api/version') return sendJson(res, 200, { version: '0.30.3' })
    if (path === '/api/tags') {
      return sendJson(res, 200, {
        models: [
          {
            name: 'fake:latest',
            model: 'fake:latest',
            size: 1_000_000,
            details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_K_M' }
          }
        ]
      })
    }
    if (path === '/api/show') {
      return sendJson(res, 200, {
        capabilities: ['completion', 'tools', 'thinking'],
        details: { family: 'llama', parameter_size: '1B' },
        model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 }
      })
    }
    if (path !== '/api/chat') return sendJson(res, 404, { error: 'not found' })
  } else if (req.method !== 'POST' || !/\/(messages|responses)$/.test(path)) {
    return sendJson(res, 404, { error: 'not found' })
  }

  const p = plan(lastUserText(body))
  if (p.error) {
    const { status, type, message, headers } = p.error
    const payload =
      provider === 'ollama'
        ? { error: message }
        : provider === 'azure'
          ? { error: { code: type, message } }
          : { type: 'error', error: { type, message } }
    return sendJson(res, status, payload, headers)
  }
  if (provider === 'anthropic') {
    return stream(res, anthropicPieces(model, p), p.delayMs, 'text/event-stream')
  }
  if (provider === 'azure') {
    return stream(res, azurePieces(model, p), p.delayMs, 'text/event-stream')
  }
  return stream(res, ollamaPieces(model, p), p.delayMs, 'application/x-ndjson')
}

/** Starts the server on a free loopback port. */
export async function startFakeProviders(): Promise<FakeProviders> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    handle(req, res, requests).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'fake server failed' })
      else res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const anthropicUrl = `${url}/anthropic`
  const azureUrl = `${url}/azure`
  const ollamaUrl = `${url}/ollama`
  return {
    url,
    anthropicUrl,
    azureUrl,
    ollamaUrl,
    requests,
    env: {
      ORCHA_E2E_ANTHROPIC_URL: anthropicUrl,
      ORCHA_E2E_AZURE_URL: azureUrl,
      ORCHA_E2E_OLLAMA_URL: ollamaUrl
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
