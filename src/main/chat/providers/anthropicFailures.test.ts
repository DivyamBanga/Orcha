import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderError, TurnStopped } from '../provider'
import { anthropicApiProvider } from './anthropicApi'
import { RefusalError } from './anthropicErrors'
import {
  chatModel,
  errorBody,
  finish,
  httpError,
  loadStub,
  providerError,
  rejection,
  setup,
  sse,
  start,
  stream,
  text,
  thought,
  turnOf,
  type Answer
} from './anthropicTestKit'

// What happens when a call to Anthropic goes wrong, the odd one-off calls, and
// a real connection (the rest of the tests use a stand-in for fetch).

const turn = turnOf(chatModel('claude-opus-5-5'))
const haiku = chatModel('claude-haiku-5-5')

describe('when a call fails', () => {
  // The SDK retries the transient ones; a header from the stub keeps that quick.
  const quick = { 'retry-after-ms': '1' }

  const cases: {
    name: string
    answer: Answer
    code: string
    requests: number
    status?: number
    retryAfterMs?: number | null
    says?: RegExp
  }[] = [
    {
      name: 'a refused key',
      answer: httpError(401, errorBody('authentication_error', 'invalid x-api-key')),
      code: 'auth',
      requests: 1,
      status: 401,
      says: /didn't accept this API key/
    },
    {
      name: 'a key that may not do that',
      answer: httpError(403, errorBody('permission_error', 'Not allowed')),
      code: 'auth',
      requests: 1,
      says: /isn't allowed/
    },
    {
      name: 'no credit',
      answer: httpError(402, errorBody('billing_error', 'Your credit balance is too low')),
      code: 'no-credit',
      requests: 1,
      status: 402
    },
    {
      name: 'a limit the owner set',
      answer: httpError(
        400,
        errorBody(
          'invalid_request_error',
          'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'
        )
      ),
      code: 'no-credit',
      requests: 1,
      says: /regain access on 2026-11-01/
    },
    {
      name: 'a workspace limit the owner set',
      answer: httpError(
        400,
        errorBody(
          'invalid_request_error',
          'You have reached your specified workspace API usage limits.'
        )
      ),
      code: 'no-credit',
      requests: 1
    },
    {
      name: 'the monthly spend cap, which is never retried',
      answer: httpError(
        429,
        errorBody(
          'rate_limit_error',
          "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.",
          { error_code: 'enforced_spend_limit_reached' }
        )
      ),
      code: 'no-credit',
      requests: 1,
      status: 429,
      retryAfterMs: null,
      says: /regain access on 2026-09-01/
    },
    {
      name: 'a rate limit, which says when to come back and is not waited out',
      answer: httpError(
        429,
        errorBody('rate_limit_error', 'Number of requests has exceeded your limit'),
        { 'retry-after': '7' }
      ),
      code: 'rate-limit',
      requests: 1,
      status: 429,
      retryAfterMs: 7000,
      says: /Try again in 7 seconds/
    },
    {
      name: 'a rate limit with no wait given',
      answer: httpError(429, errorBody('rate_limit_error', 'Slow down')),
      code: 'rate-limit',
      requests: 1,
      retryAfterMs: null,
      says: /Wait a little/
    },
    {
      name: 'a model the key can’t use',
      answer: httpError(404, errorBody('not_found_error', 'model: claude-opus-5-5')),
      code: 'not-found',
      requests: 1,
      says: /“claude-opus-5-5”/
    },
    {
      name: 'a request too big to send',
      answer: httpError(413, errorBody('request_too_large', 'Request exceeds the maximum size')),
      code: 'bad-request',
      requests: 1,
      says: /too much to send/
    },
    {
      name: 'a chat too long for the model',
      answer: httpError(
        400,
        errorBody('invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum')
      ),
      code: 'context-full',
      requests: 1
    },
    {
      name: 'any other bad request, with its request id',
      answer: httpError(400, errorBody('invalid_request_error', 'messages.1: something is wrong')),
      code: 'bad-request',
      requests: 1,
      says: /something is wrong.*req_err/
    },
    {
      name: 'an overloaded API, retried first',
      answer: httpError(529, errorBody('overloaded_error', 'Overloaded'), quick),
      code: 'overloaded',
      requests: 3,
      status: 529
    },
    {
      name: 'a server error, retried first',
      answer: httpError(500, errorBody('api_error', 'Internal server error'), quick),
      code: 'overloaded',
      requests: 3,
      says: /HTTP 500/
    },
    {
      name: 'an error sent in the middle of a reply',
      answer: stream([start()], text(0, 'par'), [
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      ]),
      code: 'overloaded',
      requests: 1
    }
  ]

  for (const c of cases) {
    it(`turns ${c.name} into '${c.code}'`, async () => {
      const { run, sent } = setup(c.answer)
      const err = await providerError(run(turn))
      expect(err.code).toBe(c.code)
      expect(sent).toHaveLength(c.requests)
      if (c.status !== undefined) expect(err.status).toBe(c.status)
      if (c.retryAfterMs !== undefined) expect(err.retryAfterMs).toBe(c.retryAfterMs)
      if (c.says) expect(err.message).toMatch(c.says)
    })
  }

  it('turns a connection that can’t be made into unreachable, after trying again', async () => {
    const { run, sent } = setup(() => {
      throw new TypeError('fetch failed')
    })
    const err = await providerError(run(turn))
    expect(err.code).toBe('unreachable')
    expect(err.message).toMatch(/Check your internet connection/)
    expect(sent).toHaveLength(3)
  })

  it('turns a connection that breaks in the middle of a reply into unreachable', async () => {
    const breaking: Answer = () => {
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(new TypeError('terminated'))
          sent = true
          controller.enqueue(
            new TextEncoder().encode(sse([start(), ...text(0, 'Half').slice(0, 2)]))
          )
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const { run, sent } = setup(breaking)
    const err = await providerError(run(turn))
    expect(err.code).toBe('unreachable')
    expect(err.message).toMatch(/broke before the reply finished/)
    // Words already shown can't be taken back, so it is not tried again.
    expect(sent).toHaveLength(1)
  })

  it('carries on as if nothing happened when the retry gets through', async () => {
    const { run, sent } = setup(
      httpError(529, errorBody('overloaded_error', 'Overloaded'), quick),
      stream([start()], text(0, 'Fine.'), finish('end_turn'))
    )
    const result = await run(turn)
    expect(result.text).toBe('Fine.')
    expect(sent).toHaveLength(2)
  })

  it('is not mistaken for a stop the person asked for', async () => {
    const { run } = setup(httpError(401, errorBody('authentication_error', 'invalid x-api-key')))
    expect(await rejection(run(turn))).not.toBeInstanceOf(TurnStopped)
  })
})

describe('one-off answers', () => {
  it('return the text and what it cost', async () => {
    const { provider, sent } = setup(
      stream(
        [start({ model: 'claude-haiku-5-5', usage: { input_tokens: 30 } })],
        text(0, '  Plan the garden  '),
        finish('end_turn', { input_tokens: 30, output_tokens: 6 })
      )
    )
    const reply = await provider.complete(haiku, 'You name chats.', 'Name this', { maxOutput: 40 })
    expect(reply.text).toBe('Plan the garden')
    expect(reply.usage).toMatchObject({ input: 30, output: 6 })
    expect(sent[0].body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 40,
      stream: true,
      system: 'You name chats.',
      messages: [{ role: 'user', content: 'Name this' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' }
    })
  })

  it('leave out the reasoning a model could not leave off', async () => {
    const { provider } = setup(
      stream([start()], thought(0, 'hmm'), text(1, 'A title'), finish('end_turn'))
    )
    expect((await provider.complete(chatModel('claude-opus-5-5'), 's', 'p')).text).toBe('A title')
  })

  it('fail the way a turn does', async () => {
    const refused = setup(httpError(401, errorBody('authentication_error', 'invalid x-api-key')))
    expect((await providerError(refused.provider.complete(haiku, 's', 'p'))).code).toBe('auth')

    const declined = setup(
      stream(
        [start()],
        finish('refusal', {}, { stop_details: { type: 'refusal', category: null } })
      )
    )
    const sonnet = chatModel('claude-sonnet-5-5')
    expect(await providerError(declined.provider.complete(sonnet, 's', 'p'))).toBeInstanceOf(
      RefusalError
    )
  })

  it('stop quietly when asked to', async () => {
    const { provider } = setup(stream([start()], text(0, 'x'), finish('end_turn')))
    const stop = new AbortController()
    stop.abort()
    const err = await rejection(provider.complete(haiku, 's', 'p', { signal: stop.signal }))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ProviderError)
  })
})

describe('over a real connection', () => {
  let server: Server | null = null
  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = null
  })

  async function serve(
    handle: (req: IncomingMessage, body: string, res: ServerResponse) => void
  ): Promise<string> {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => handle(req, body, res))
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  it('streams a reply from a server on this machine', async () => {
    let seen: { headers: IncomingMessage['headers']; url?: string } | null = null
    const baseURL = await serve((req, _body, res) => {
      seen = { headers: req.headers, url: req.url }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_local' })
      res.end(sse([start(), ...text(0, 'Hello ', 'there'), ...finish('end_turn')]))
    })
    const provider = anthropicApiProvider({ apiKey: 'sk-ant-local', load: loadStub, baseURL })
    const result = await provider.run(turn, () => {}, new AbortController().signal)
    expect(result.text).toBe('Hello there')
    expect(seen!.url).toBe('/v1/messages?beta=true')
    expect(seen!.headers.authorization).toBe('Bearer sk-ant-local')
    expect(seen!.headers['anthropic-version']).toBe('2026-10-21')
  })

  it('lets go of the connection when stopped', async () => {
    let closed: () => void = () => {}
    const gone = new Promise<void>((done) => (closed = done))
    const baseURL = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse([start({ usage: { input_tokens: 321 } }), ...text(0, 'Hello').slice(0, 2)]))
      res.on('close', closed)
    })
    const provider = anthropicApiProvider({ apiKey: 'sk-ant-local', load: loadStub, baseURL })
    const stop = new AbortController()
    const err = await rejection(
      provider.run(
        turn,
        (e) => {
          if (e.kind === 'text') stop.abort()
        },
        stop.signal
      )
    )
    expect(err).toBeInstanceOf(TurnStopped)
    const partial = (err as TurnStopped).partial
    expect(partial.text).toBe('Hello')
    expect(partial.usage?.input).toBe(321)
    await gone
  })
})
