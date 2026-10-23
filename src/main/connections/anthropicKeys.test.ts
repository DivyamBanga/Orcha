import { describe, expect, it } from 'vitest'
import { ProviderError } from '../chat/provider'
import { listModels, testKey } from './anthropicKeys'

const KEY = 'sk-ant-api03-secret-key-value'

interface Seen {
  url: string
  method: string
  headers: Headers
}

// A fetch that answers in order and notes what it was asked.
function answering(...answers: (() => Response)[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  let n = 0
  return {
    seen,
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers)
      })
      return answers[Math.min(n++, answers.length - 1)]()
    }
  }
}

const json =
  (status: number, body: object, headers: Record<string, string> = {}) =>
  (): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_keys', ...headers }
    })

const failing = (type: string, message: string, details?: object): object => ({
  type: 'error',
  error: { type, message, ...(details ? { details } : {}) },
  request_id: 'req_keys'
})

const supported = { supported: true }
const unsupported = { supported: false }

// A model as the Models API describes it.
const model = (id: string, over: Record<string, unknown> = {}): object => ({
  type: 'model',
  id,
  display_name: `Claude ${id}`,
  created_at: '2026-08-01T00:00:00Z',
  lifecycle: 'active',
  deprecated_at: null,
  retires_at: null,
  line: 'opus',
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    batch: supported,
    citations: supported,
    code_execution: supported,
    context_management: { supported: true },
    image_input: supported,
    pdf_input: supported,
    server_tools: { supported: true, web_search: supported, code_execution: supported },
    structured_outputs: supported,
    effort: {
      supported: true,
      low: supported,
      medium: supported,
      high: supported,
      max: supported,
      xhigh: supported
    },
    thinking: {
      supported: true,
      types: {
        adaptive: supported,
        enabled: unsupported,
        disabled: unsupported,
        between_tools: unsupported
      }
    }
  },
  ...over
})

const page = (data: object[], more: { has_more: boolean; last_id: string | null }): object => ({
  data,
  has_more: more.has_more,
  first_id: (data[0] as { id?: string } | undefined)?.id ?? null,
  last_id: more.last_id
})

describe('testKey', () => {
  it('says a key that lists models is ok', async () => {
    const { fetch, seen } = answering(
      json(200, page([model('claude-opus-5-5')], { has_more: false, last_id: null }))
    )
    expect(await testKey(KEY, fetch)).toEqual({ health: 'ok', detail: null })
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('GET')
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/models?limit=1')
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  const verdicts: {
    name: string
    answer: () => Response
    health: string
    says: RegExp
  }[] = [
    {
      name: 'a key Anthropic refuses is invalid',
      answer: json(401, failing('authentication_error', 'invalid x-api-key')),
      health: 'invalid',
      says: /didn't accept this API key/
    },
    {
      name: 'a key that may not list models is invalid',
      answer: json(403, failing('permission_error', 'Not allowed')),
      health: 'invalid',
      says: /isn't allowed/
    },
    {
      name: 'a billing problem is no credit',
      answer: json(402, failing('billing_error', 'Your credit balance is too low')),
      health: 'no-credit',
      says: /out of credit/
    },
    {
      name: 'the monthly spend cap is no credit',
      answer: json(
        429,
        failing(
          'rate_limit_error',
          'You have reached your API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.',
          {
            error_code: 'enforced_spend_limit_reached'
          }
        )
      ),
      health: 'no-credit',
      says: /regain access on 2026-09-01/
    },
    {
      name: 'a limit the owner set is no credit',
      answer: json(
        400,
        failing(
          'invalid_request_error',
          'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'
        )
      ),
      health: 'no-credit',
      says: /specified API usage limits/
    },
    {
      name: 'a rate limit is rate limited',
      answer: json(429, failing('rate_limit_error', 'Slow down'), { 'retry-after': '30' }),
      health: 'rate-limited',
      says: /Try again in 30 seconds/
    },
    {
      name: 'a server error is unreachable',
      answer: json(500, failing('api_error', 'Internal server error')),
      health: 'unreachable',
      says: /problem on its side/
    },
    {
      name: 'an overloaded API is unreachable',
      answer: json(529, failing('overloaded_error', 'Overloaded')),
      health: 'unreachable',
      says: /overloaded/
    }
  ]

  for (const v of verdicts) {
    it(`calls ${v.name}, after one try`, async () => {
      const { fetch, seen } = answering(v.answer)
      const result = await testKey(KEY, fetch)
      expect(result.health).toBe(v.health)
      expect(result.detail).toMatch(v.says)
      // A check answers quickly rather than waiting out retries.
      expect(seen).toHaveLength(1)
    })
  }

  it('calls an unreachable network unreachable', async () => {
    const { fetch, seen } = answering(() => {
      throw new TypeError('fetch failed')
    })
    const result = await testKey(KEY, fetch)
    expect(result.health).toBe('unreachable')
    expect(result.detail).toMatch(/Check your internet connection/)
    expect(seen).toHaveLength(1)
  })

  it('never repeats the key in what it says', async () => {
    const { fetch } = answering(json(401, failing('authentication_error', 'invalid x-api-key')))
    expect(JSON.stringify(await testKey(KEY, fetch))).not.toContain(KEY)
  })
})

describe('listModels', () => {
  it('describes each model for the catalog, following the pages', async () => {
    const first = page(
      [
        model('claude-opus-5-5'),
        model('claude-haiku-4-5', {
          display_name: 'Claude Haiku 4.5',
          max_input_tokens: 200_000,
          max_tokens: 64_000,
          line: 'haiku'
        })
      ],
      { has_more: true, last_id: 'claude-haiku-4-5' }
    )
    const second = page([model('claude-sonnet-5-5')], {
      has_more: false,
      last_id: 'claude-sonnet-5-5'
    })
    const { fetch, seen } = answering(json(200, first), json(200, second))

    const models = await listModels(KEY, fetch)

    expect(seen).toHaveLength(2)
    expect(new URL(seen[0].url).searchParams.get('limit')).toBe('1000')
    expect(new URL(seen[1].url).searchParams.get('after_id')).toBe('claude-haiku-4-5')
    expect(models.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5',
      'claude-sonnet-5-5'
    ])
    expect(models[0]).toEqual({
      id: 'claude-opus-5-5',
      displayName: 'Claude claude-opus-5-5',
      maxInput: 1_000_000,
      maxOutput: 128_000,
      thinking: {
        supported: true,
        adaptive: true,
        enabled: false,
        disabled: false,
        betweenTools: false
      },
      efforts: ['low', 'medium', 'high', 'xhigh', 'max']
    })
    expect(models[1]).toMatchObject({
      displayName: 'Claude Haiku 4.5',
      maxInput: 200_000,
      maxOutput: 64_000
    })
  })

  it('reads which thinking settings and effort levels each model takes', async () => {
    const capabilities = (over: { effort?: object; thinking?: object }): object => ({
      ...(model('x') as { capabilities: object }).capabilities,
      ...over
    })
    const sonnet = model('claude-sonnet-5-5', {
      capabilities: capabilities({
        thinking: {
          supported: true,
          types: {
            adaptive: supported,
            enabled: unsupported,
            disabled: unsupported,
            between_tools: supported
          }
        }
      })
    })
    // No xhigh level reported at all, as on Opus 4.6.
    const opus46 = model('claude-opus-4-6', {
      capabilities: capabilities({
        effort: {
          supported: true,
          low: supported,
          medium: supported,
          high: supported,
          max: supported,
          xhigh: null
        }
      })
    })
    // The 4.5 generation: no effort, thinking only on a budget.
    const haiku45 = model('claude-haiku-4-5', {
      capabilities: capabilities({
        effort: {
          supported: false,
          low: unsupported,
          medium: unsupported,
          high: unsupported,
          max: unsupported,
          xhigh: null
        },
        thinking: {
          supported: true,
          types: {
            adaptive: unsupported,
            enabled: supported,
            disabled: supported,
            between_tools: unsupported
          }
        }
      })
    })
    const { fetch } = answering(
      json(200, page([sonnet, opus46, haiku45], { has_more: false, last_id: null }))
    )
    const [s, o, h] = await listModels(KEY, fetch)
    expect(s.thinking).toMatchObject({ adaptive: true, betweenTools: true, disabled: false })
    expect(o.efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(h.efforts).toEqual([])
    expect(h.thinking).toMatchObject({ adaptive: false, enabled: true, disabled: true })
  })

  it('copes with a model that reports no capabilities or limits', async () => {
    const bare = model('claude-mystery', {
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null
    })
    const { fetch } = answering(json(200, page([bare], { has_more: false, last_id: null })))
    expect(await listModels(KEY, fetch)).toEqual([
      {
        id: 'claude-mystery',
        displayName: 'Claude claude-mystery',
        maxInput: null,
        maxOutput: null,
        thinking: null,
        efforts: []
      }
    ])
  })

  it('fails with the reason when the key is refused', async () => {
    const { fetch } = answering(json(401, failing('authentication_error', 'invalid x-api-key')))
    const err = await listModels(KEY, fetch).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe('auth')
    expect((err as ProviderError).message).not.toContain(KEY)
  })
})
