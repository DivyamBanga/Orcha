import { describe, expect, it } from 'vitest'
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatModel, TurnSettings } from '../../../shared/ai'
import { specFor } from '../../../shared/models'
import type { ChatFile } from '../../../shared/types'
import {
  ProviderError,
  TurnStopped,
  type ClientTool,
  type FileLoader,
  type ProviderTurn,
  type StreamEvent
} from '../provider'
import {
  Reply,
  claudePlanProvider,
  optionsFor,
  planError,
  promptFor,
  reasoningFor,
  tokenUsage,
  zodShape,
  type PlanSdk,
  type Placement
} from './claudePlan'

// A catalog entry for a Max-plan model, made from the model facts.
function planModel(id: string): ChatModel {
  const s = specFor(id)!
  return {
    id: `plan:${id}`,
    route: 'plan',
    apiModel: id,
    label: s.label,
    description: s.description,
    spec: id,
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
    price: null,
    ready: true
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

const image: ChatFile = {
  hash: 'a'.repeat(64),
  name: 'shot.png',
  mime: 'image/png',
  bytes: 9,
  kind: 'image'
}

const load: FileLoader = (f) =>
  f.kind === 'text' ? { text: `contents of ${f.name}` } : { base64: `B64${f.kind}` }

const turn = (over: Partial<ProviderTurn> = {}): ProviderTurn => ({
  model: planModel('claude-opus-5-5'),
  system: 'SYSTEM',
  history: [{ role: 'user', text: 'hi', files: [] }],
  settings: settings(),
  tools: [],
  ...over
})

const MEMORY_TOOL: ClientTool = {
  name: 'memory',
  description: 'Save or remove a memory.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget'] },
      text: { type: 'string', description: 'One short sentence.' },
      id: { type: 'integer' }
    },
    required: ['action']
  }
}

const fresh: Placement = { id: 'sess-1', at: null, fresh: true }

describe('reasoningFor', () => {
  const r = (
    id: string,
    thinking: boolean,
    effort: TurnSettings['effort'] = null
  ): ReturnType<typeof reasoningFor> => reasoningFor(planModel(id), { thinking, effort })

  it('thinks adaptively, with the model default effort, when on', () => {
    expect(r('claude-opus-5-5', true)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'medium'
    })
  })

  it('keeps the effort asked for', () => {
    expect(r('claude-opus-5-5', true, 'max').effort).toBe('max')
    expect(r('claude-opus-5-5', true, 'xhigh').effort).toBe('xhigh')
  })

  it('turns thinking off explicitly where the API allows it, capping effort', () => {
    expect(r('claude-haiku-4-5', false).thinking).toEqual({ type: 'disabled' })
    expect(r('claude-opus-5', false, 'max')).toEqual({
      thinking: { type: 'disabled' },
      effort: 'high'
    })
  })

  it('gives the budget-only model a fixed budget when on, and no effort', () => {
    expect(r('claude-haiku-4-5', true)).toEqual({
      thinking: { type: 'enabled', budgetTokens: 8_000, display: 'summarized' }
    })
  })

  it('cannot switch thinking off for between_tools and Haiku 5.5: lowest effort, reasoning hidden', () => {
    for (const id of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(r(id, false, 'max')).toEqual({
        thinking: { type: 'adaptive', display: 'omitted' },
        effort: 'low'
      })
    }
  })

  it('thinks always on models without a switch, whatever the switch says', () => {
    expect(r('claude-opus-5-5', false).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized'
    })
  })
})

describe('optionsFor', () => {
  it('isolates the run from this computer and allows nothing by default', () => {
    const o = optionsFor(turn(), fresh)
    expect(o).toMatchObject({
      model: 'claude-opus-5-5',
      systemPrompt: 'SYSTEM',
      settingSources: [],
      strictMcpConfig: true,
      verbatimPrompts: true,
      permissionMode: 'dontAsk',
      tools: [],
      allowedTools: [],
      sessionId: 'sess-1'
    })
    expect(o.resume).toBeUndefined()
  })

  it('allows WebSearch only when the chat asks and the model can', () => {
    const on = optionsFor(turn({ settings: settings({ webSearch: true }) }), fresh)
    expect(on.tools).toEqual(['WebSearch'])
    expect(on.allowedTools).toEqual(['WebSearch'])
    const none = { ...planModel('claude-opus-5-5'), webSearch: false }
    const off = optionsFor(turn({ model: none, settings: settings({ webSearch: true }) }), fresh)
    expect(off.tools).toEqual([])
  })

  it('allows the in-process tools by their mcp names', () => {
    const o = optionsFor(turn({ tools: [MEMORY_TOOL] }), fresh)
    expect(o.allowedTools).toEqual(['mcp__orcha__memory'])
  })

  it('resumes a session at a message, or from its newest', () => {
    const at = optionsFor(turn(), { id: 's', at: 'm1', fresh: false })
    expect(at).toMatchObject({ resume: 's', resumeSessionAt: 'm1' })
    expect(at.sessionId).toBeUndefined()
    const newest = optionsFor(turn(), { id: 's', at: null, fresh: false })
    expect(newest.resume).toBe('s')
    expect(newest.resumeSessionAt).toBeUndefined()
  })

  it('incognito writes nothing and names no session', () => {
    const o = optionsFor(turn({ incognito: true }), fresh)
    expect(o.persistSession).toBe(false)
    expect(o.sessionId).toBeUndefined()
    expect(o.resume).toBeUndefined()
  })
})

describe('promptFor', () => {
  const history = [
    { role: 'user' as const, text: 'hi', files: [] },
    { role: 'assistant' as const, text: 'hello', files: [] },
    { role: 'assistant' as const, text: '   ', files: [] },
    { role: 'user' as const, text: 'again', files: [image] }
  ]
  const blocks = (m: SDKUserMessage): { type: string; text?: string }[] =>
    m.message.content as { type: string; text?: string }[]

  it('sends only the new message when resuming', () => {
    const b = blocks(promptFor(history, load, true))
    expect(b.map((x) => x.type)).toEqual(['image', 'text'])
    expect(b[1].text).toBe('again')
  })

  it('writes the conversation out first when the session starts afresh', () => {
    const b = blocks(promptFor(history, load, false))
    expect(b[0].text).toContain(
      '<conversation_so_far>\nThem: hi\n\nYou: hello\n</conversation_so_far>'
    )
    expect(b.map((x) => x.type)).toEqual(['text', 'image', 'text'])
  })

  it('puts text files inline and PDFs as documents', () => {
    const files: ChatFile[] = [
      { ...image, name: 'a.txt', kind: 'text' },
      { ...image, name: 'b.pdf', kind: 'pdf', mime: 'application/pdf' }
    ]
    const b = blocks(promptFor([{ role: 'user', text: '', files }], load, true))
    expect(b[0].text).toContain('contents of a.txt')
    expect(b[1].type).toBe('document')
    expect(b).toHaveLength(2)
  })
})

describe('zodShape', () => {
  it('makes required fields required and the rest optional', () => {
    const shape = zodShape(MEMORY_TOOL.schema)
    expect(shape.action.safeParse('remember').success).toBe(true)
    expect(shape.action.safeParse('nope').success).toBe(false)
    expect(shape.action.safeParse(undefined).success).toBe(false)
    expect(shape.id.safeParse(undefined).success).toBe(true)
    expect(shape.id.safeParse(1.5).success).toBe(false)
  })
})

const asResult = (r: object): SDKResultMessage => r as unknown as SDKResultMessage

const baseResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 200,
    cache_read_input_tokens: 5_000,
    cache_creation_input_tokens: 1_000,
    cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
    output_tokens_details: { thinking_tokens: 50 },
    server_tool_use: { web_search_requests: 1 }
  }
}

describe('tokenUsage', () => {
  it("falls back to the main loop's usage with exclusive buckets", () => {
    expect(tokenUsage(asResult(baseResult))).toEqual({
      input: 10,
      cacheRead: 5_000,
      cacheWrite5m: 400,
      cacheWrite1h: 600,
      cacheWrite: 0,
      output: 200,
      reasoning: 50,
      webSearches: 1,
      longContext: false
    })
  })

  it('sums the per-turn tally across models when Claude Code gives it', () => {
    const usage = tokenUsage(
      asResult({
        ...baseResult,
        model_usage_since_last_result: {
          a: {
            inputTokens: 5,
            outputTokens: 100,
            cacheReadInputTokens: 1_000,
            cacheCreationInputTokens: 400,
            webSearchRequests: 2,
            thinkingTokens: 30
          },
          b: {
            inputTokens: 7,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0
          }
        }
      })
    )
    expect(usage).toMatchObject({
      input: 12,
      output: 120,
      cacheRead: 1_000,
      cacheWrite5m: 400,
      cacheWrite1h: 0,
      reasoning: 30,
      webSearches: 2
    })
  })
})

describe('planError', () => {
  it('maps sign-in problems to auth with the plain message', () => {
    const e = planError({ text: 'Not logged in · Please run /login' })
    expect(e.code).toBe('auth')
    expect(e.message).toMatch(/isn’t signed in/)
    expect(planError({ text: 'x', kind: 'authentication_failed' }).code).toBe('auth')
  })

  it('maps the plan limit to rate-limit with the reset time', () => {
    const e = planError(
      {
        text: "You've hit your limit",
        kind: 'rate_limit',
        limit: { status: 'rejected', resetsAt: 1_090 } as never
      },
      1_000_000
    )
    expect(e.code).toBe('rate-limit')
    expect(e.retryAfterMs).toBe(90_000)
    expect(planError({ text: 'slow down', status: 429 }).retryAfterMs).toBeNull()
  })

  it('maps the rest', () => {
    expect(planError({ text: 'x', kind: 'billing_error' }).code).toBe('no-credit')
    expect(planError({ text: 'x', status: 529 }).code).toBe('overloaded')
    expect(planError({ text: 'x', kind: 'model_not_found' }).code).toBe('not-found')
    expect(planError({ text: 'Prompt is too long' }).code).toBe('context-full')
    expect(planError({ text: 'x', kind: 'invalid_request' }).code).toBe('bad-request')
    expect(planError({ text: 'fetch failed' }).code).toBe('unreachable')
    expect(planError({ text: 'huh' }).code).toBe('unknown')
  })
})

// ---- a whole reply, with Claude Code stood in for ----

const init = (apiKeySource: string): SDKMessage =>
  ({ type: 'system', subtype: 'init', apiKeySource }) as unknown as SDKMessage
const stream = (event: object): SDKMessage =>
  ({ type: 'stream_event', parent_tool_use_id: null, event }) as unknown as SDKMessage
const text = (t: string): SDKMessage =>
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })
const thinkingDelta = (t: string): SDKMessage =>
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } })
const assistant = (uuid: string): SDKMessage =>
  ({
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { model: 'claude-opus-5-5', content: [] }
  }) as unknown as SDKMessage
const done = (over: object = {}): SDKMessage => asResult({ ...baseResult, ...over }) as SDKMessage

describe('Reply', () => {
  it('streams text and thinking, notes the last message, and reports usage', () => {
    const events: StreamEvent[] = []
    let now = 0
    const reply = new Reply(
      (e) => events.push(e),
      () => now
    )
    reply.handle(init('none'))
    now = 120
    reply.handle(stream({ type: 'message_start' }))
    reply.handle(thinkingDelta('hm'))
    now = 500
    reply.handle(text('Hello'))
    reply.handle(assistant('m9'))
    reply.handle(done())
    const result = reply.finish()
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'text'])
    expect(result).toMatchObject({
      text: 'Hello',
      stop: 'end',
      ttftMs: 120,
      model: 'claude-opus-5-5',
      parts: { thinking: { text: 'hm', ms: 380 } }
    })
    expect(result.usage?.output).toBe(200)
    expect(reply.at).toBe('m9')
  })

  it('starts a later model call on a new paragraph', () => {
    const reply = new Reply(() => {})
    reply.handle(stream({ type: 'message_start' }))
    reply.handle(text('One.'))
    reply.handle(stream({ type: 'message_start' }))
    reply.handle(text('  Two.'))
    expect(reply.text).toBe('One.\n\nTwo.')
  })

  it('collects search sources once each', () => {
    const reply = new Reply(() => {})
    const results = {
      results: [{ content: [{ title: 'A', url: 'https://a' }, { url: 'https://a' }] }, 'summary'],
      searchCount: 1
    }
    reply.handle({ type: 'user', tool_use_result: results } as unknown as SDKMessage)
    reply.handle(done())
    expect(reply.finish().parts.sources).toEqual([{ url: 'https://a', title: 'A' }])
  })

  it('refuses when Claude Code is on an API key', () => {
    const reply = new Reply(() => {})
    expect(() => reply.handle(init('ANTHROPIC_API_KEY'))).toThrowError(
      expect.objectContaining({ code: 'auth' })
    )
    expect(() => reply.handle(init('none'))).not.toThrow()
  })

  it('keeps a cut-off or declined reply, and fails on a real error', () => {
    const cut = new Reply(() => {})
    cut.handle(text('partial'))
    cut.handle(done({ stop_reason: 'max_tokens' }))
    expect(cut.finish().stop).toBe('max-tokens')

    const refused = new Reply(() => {})
    refused.handle(done({ stop_reason: 'refusal' }))
    expect(refused.finish().stop).toBe('refusal')

    const failed = new Reply(() => {})
    failed.handle(done({ is_error: true, result: 'API Error: Overloaded', api_error_status: 529 }))
    expect(() => failed.finish()).toThrowError(expect.objectContaining({ code: 'overloaded' }))

    const turns = new Reply(() => {})
    turns.handle(
      asResult({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: [],
        usage: baseResult.usage
      }) as SDKMessage
    )
    expect(() => turns.finish()).toThrow(/more steps/)
  })

  it('uses the plan limit news when the run ends with no result', () => {
    const reply = new Reply(() => {})
    reply.handle({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 2 }
    } as unknown as SDKMessage)
    reply.handle({
      type: 'assistant',
      uuid: 'e',
      parent_tool_use_id: null,
      error: 'rate_limit',
      message: { model: 'x', content: [{ type: 'text', text: "You've hit your limit" }] }
    } as unknown as SDKMessage)
    expect(() => reply.finish(1_000)).toThrowError(
      expect.objectContaining({ code: 'rate-limit', retryAfterMs: 1_000 })
    )
  })
})

// ---- the provider, end to end over a fake SDK ----

function fakeSdk(
  messages: SDKMessage[],
  over: Partial<PlanSdk> = {}
): { sdk: PlanSdk; calls: { options?: Record<string, unknown>; prompt: unknown }[] } {
  const calls: { options?: Record<string, unknown>; prompt: unknown }[] = []
  const sdk: PlanSdk = {
    query: (params) => {
      calls.push({ options: params.options as Record<string, unknown>, prompt: params.prompt })
      return (async function* () {
        for (const m of messages) yield m
      })()
    },
    getSessionMessages: async () => [],
    forkSession: async () => ({ sessionId: 'forked' }),
    deleteSession: async () => {},
    ...over
  }
  return { sdk, calls }
}

const dir = 'C:/tmp/orcha-plan-test'
const never = (): AbortSignal => new AbortController().signal

describe('claudePlanProvider', () => {
  it('carries on a session at the message it reached and returns the new position', async () => {
    const { sdk, calls } = fakeSdk([init('none'), text('Hi'), assistant('m2'), done()], {
      getSessionMessages: async () => [{ uuid: 'm1' }]
    })
    const result = await claudePlanProvider({ load, dir, sdk }).run(
      turn({ session: { id: 's1', at: 'm1' } }),
      () => {},
      never()
    )
    expect(calls[0].options).toMatchObject({ resume: 's1', resumeSessionAt: 'm1', cwd: dir })
    expect(result.session).toEqual({ id: 's1', at: 'm2' })
  })

  it('forks from an earlier branch', async () => {
    const { sdk, calls } = fakeSdk([init('none'), text('Hi'), done()], {
      getSessionMessages: async () => [{ uuid: 'other' }]
    })
    const result = await claudePlanProvider({ load, dir, sdk }).run(
      turn({ session: { id: 's1', at: 'm1' } }),
      () => {},
      never()
    )
    expect(calls[0].options).toMatchObject({ resume: 'forked' })
    expect(result.session?.id).toBe('forked')
  })

  it('incognito keeps no session and starts fresh with the conversation written out', async () => {
    const { sdk, calls } = fakeSdk([init('none'), text('Hi'), done()])
    const result = await claudePlanProvider({ load, dir, sdk }).run(
      turn({
        incognito: true,
        session: { id: 's1', at: 'm1' },
        history: [
          { role: 'user', text: 'a', files: [] },
          { role: 'assistant', text: 'b', files: [] },
          { role: 'user', text: 'c', files: [] }
        ]
      }),
      () => {},
      never()
    )
    expect(calls[0].options).toMatchObject({ persistSession: false })
    expect(calls[0].options?.resume).toBeUndefined()
    expect(result.session).toBeUndefined()
    const first = await (calls[0].prompt as AsyncIterable<SDKUserMessage>)
      [Symbol.asyncIterator]()
      .next()
    expect(JSON.stringify(first.value.message.content)).toContain('conversation_so_far')
  })

  it("strips Claude and Anthropic variables from Claude Code's environment", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok'
    try {
      const { sdk, calls } = fakeSdk([init('none'), done()])
      await claudePlanProvider({ load, dir, sdk, binary: 'C:/claude.exe' }).run(
        turn(),
        () => {},
        never()
      )
      const env = calls[0].options?.env as Record<string, string>
      expect(Object.keys(env).some((k) => /^(CLAUDE|ANTHROPIC)/i.test(k))).toBe(false)
      expect(calls[0].options).toMatchObject({ pathToClaudeCodeExecutable: 'C:/claude.exe' })
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
  })

  it("deletes the session made for a failed reply, but never the chat's own", async () => {
    const deleted: string[] = []
    const { sdk } = fakeSdk([init('none'), done({ is_error: true, result: 'boom' })], {
      deleteSession: async (id) => void deleted.push(id)
    })
    const provider = claudePlanProvider({ load, dir, sdk })
    await expect(provider.run(turn(), () => {}, never())).rejects.toBeInstanceOf(ProviderError)
    expect(deleted).toHaveLength(1)

    deleted.length = 0
    await expect(
      provider.run(turn({ session: { id: 's1', at: null } }), () => {}, never())
    ).rejects.toBeInstanceOf(ProviderError)
    expect(deleted).toEqual([])
  })

  it('a stopped turn throws what had streamed', async () => {
    const ctl = new AbortController()
    const { sdk } = fakeSdk([init('none'), text('Half')])
    const err = await claudePlanProvider({ load, dir, sdk })
      .run(turn(), (e) => e.kind === 'text' && ctl.abort(), ctl.signal)
      .catch((e) => e)
    expect(err).toBeInstanceOf(TurnStopped)
    expect(err.partial.text).toBe('Half')
  })

  it('complete() makes one tool-less call with nothing kept', async () => {
    const { sdk, calls } = fakeSdk([init('none'), text(' A title '), done()])
    const out = await claudePlanProvider({ load, dir, sdk }).complete(
      planModel('claude-haiku-5-5'),
      'sys',
      'name this'
    )
    expect(out.text).toBe('A title')
    expect(out.usage?.output).toBe(200)
    expect(calls[0].prompt).toBe('name this')
    expect(calls[0].options).toMatchObject({
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      effort: 'low'
    })
  })
})
