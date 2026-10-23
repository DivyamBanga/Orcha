import { describe, expect, it } from 'vitest'
import type { TurnSettings } from '../../../shared/ai'
import { MODEL_SPECS } from '../../../shared/models'
import type { ChatFile } from '../../../shared/types'
import type { ClientTool } from '../provider'
import { completionRequest, requestFor } from './anthropicRequest'
import { chatModel, loadStub, turnOf } from './anthropicTestKit'

const ADAPTIVE = { type: 'adaptive', display: 'summarized' }

interface Case {
  name: string
  model: string
  settings: Partial<TurnSettings>
  thinking: unknown
  effort: string | undefined
}

// What each kind of model is sent for the Thinking switch and the effort menu.
const MATRIX: Case[] = [
  // Fable 5.1 and Opus 5.5 can't turn thinking off: the switch has no say.
  {
    name: 'Fable 5.1 always thinks, so the switch is ignored',
    model: 'claude-fable-5-1',
    settings: { thinking: false, effort: 'xhigh' },
    thinking: ADAPTIVE,
    effort: 'xhigh'
  },
  {
    name: 'Fable 5.1 with no effort chosen sends none',
    model: 'claude-fable-5-1',
    settings: { thinking: true, effort: null },
    thinking: ADAPTIVE,
    effort: undefined
  },
  {
    name: 'Opus 5.5 always thinks',
    model: 'claude-opus-5-5',
    settings: { thinking: false, effort: 'max' },
    thinking: ADAPTIVE,
    effort: 'max'
  },
  // Sonnet 5.5 turns thinking off with between_tools, alone, at effort high or lower.
  {
    name: 'Sonnet 5.5 thinking on keeps every effort',
    model: 'claude-sonnet-5-5',
    settings: { thinking: true, effort: 'xhigh' },
    thinking: ADAPTIVE,
    effort: 'xhigh'
  },
  {
    name: 'Sonnet 5.5 thinking off is between_tools with nothing beside it',
    model: 'claude-sonnet-5-5',
    settings: { thinking: false, effort: null },
    thinking: { type: 'between_tools' },
    effort: undefined
  },
  {
    name: 'Sonnet 5.5 thinking off clamps max to high',
    model: 'claude-sonnet-5-5',
    settings: { thinking: false, effort: 'max' },
    thinking: { type: 'between_tools' },
    effort: 'high'
  },
  {
    name: 'Sonnet 5.5 thinking off clamps xhigh to high',
    model: 'claude-sonnet-5-5',
    settings: { thinking: false, effort: 'xhigh' },
    thinking: { type: 'between_tools' },
    effort: 'high'
  },
  {
    name: 'Sonnet 5.5 thinking off leaves a lower effort alone',
    model: 'claude-sonnet-5-5',
    settings: { thinking: false, effort: 'low' },
    thinking: { type: 'between_tools' },
    effort: 'low'
  },
  // Haiku 5.5 and Opus 5 use disabled, at effort high or lower.
  {
    name: 'Haiku 5.5 thinking on keeps max',
    model: 'claude-haiku-5-5',
    settings: { thinking: true, effort: 'max' },
    thinking: ADAPTIVE,
    effort: 'max'
  },
  {
    name: 'Haiku 5.5 thinking off is disabled, effort clamped to high',
    model: 'claude-haiku-5-5',
    settings: { thinking: false, effort: 'max' },
    thinking: { type: 'disabled' },
    effort: 'high'
  },
  {
    name: 'Haiku 5.5 thinking off with no effort sends none',
    model: 'claude-haiku-5-5',
    settings: { thinking: false, effort: null },
    thinking: { type: 'disabled' },
    effort: undefined
  },
  {
    name: 'Opus 5 thinking off is disabled, effort clamped to high',
    model: 'claude-opus-5',
    settings: { thinking: false, effort: 'xhigh' },
    thinking: { type: 'disabled' },
    effort: 'high'
  },
  {
    name: 'Sonnet 5 thinking off is disabled at any effort',
    model: 'claude-sonnet-5',
    settings: { thinking: false, effort: 'max' },
    thinking: { type: 'disabled' },
    effort: 'max'
  },
  // Opus 4.8 and the older Opus and Sonnet 4.x don't think unless asked.
  {
    name: 'Opus 4.8 thinking on is asked for outright',
    model: 'claude-opus-4-8',
    settings: { thinking: true, effort: 'high' },
    thinking: ADAPTIVE,
    effort: 'high'
  },
  {
    name: 'Opus 4.8 thinking off sends no thinking field, effort unclamped',
    model: 'claude-opus-4-8',
    settings: { thinking: false, effort: 'max' },
    thinking: undefined,
    effort: 'max'
  },
  {
    name: 'Opus 4.6 has no xhigh, so xhigh becomes the nearest level below',
    model: 'claude-opus-4-6',
    settings: { thinking: true, effort: 'xhigh' },
    thinking: ADAPTIVE,
    effort: 'high'
  },
  // The 4.5 generation thinks on a fixed budget and has no effort setting.
  {
    name: 'Haiku 4.5 thinking on is a token budget',
    model: 'claude-haiku-4-5',
    settings: { thinking: true, effort: 'high' },
    thinking: { type: 'enabled', budget_tokens: 8000 },
    effort: undefined
  },
  {
    name: 'Haiku 4.5 thinking off sends nothing',
    model: 'claude-haiku-4-5',
    settings: { thinking: false, effort: 'high' },
    thinking: undefined,
    effort: undefined
  },
  // Efforts carried over from a GPT chat land on a level Claude has.
  {
    name: 'an OpenAI-only effort becomes the nearest Claude level',
    model: 'claude-fable-5-1',
    settings: { effort: 'none' },
    thinking: ADAPTIVE,
    effort: 'low'
  },
  {
    name: 'minimal is carried to low as well',
    model: 'claude-opus-5-5',
    settings: { effort: 'minimal' },
    thinking: ADAPTIVE,
    effort: 'low'
  }
]

describe('thinking and effort', () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const p = requestFor(turnOf(chatModel(c.model), c.settings), loadStub)
      expect(p.thinking).toEqual(c.thinking)
      expect(p.output_config?.effort).toBe(c.effort)
      // Nothing is sent as undefined or null: absent means absent.
      expect('thinking' in p).toBe(c.thinking !== undefined)
      expect('output_config' in p).toBe(c.effort !== undefined)
    })
  }
})

describe('every Claude model', () => {
  const claude = MODEL_SPECS.filter((s) => s.family === 'claude')
  const efforts = [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const FALLBACKS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']

  it('gets a request it will accept, whatever the settings', () => {
    for (const spec of claude) {
      for (const thinking of [true, false]) {
        for (const effort of efforts) {
          for (const webSearch of [true, false]) {
            const settings = { thinking, effort, webSearch, temperature: 0.7, topP: 0.9 }
            const p = requestFor(turnOf(chatModel(spec.id), settings), loadStub)
            const where = `${spec.id} thinking=${thinking} effort=${effort} search=${webSearch}`

            // The API refuses sampling on every model.
            for (const key of ['temperature', 'top_p', 'top_k']) {
              expect(p, where).not.toHaveProperty(key)
            }
            expect(p.max_tokens, where).toBeLessThanOrEqual(Math.min(spec.maxOutput, 64_000))

            const level = p.output_config?.effort
            if (level) expect(spec.reasoning.levels, where).toContain(level)
            if (spec.reasoning.budgetOnly) expect(level, where).toBeUndefined()

            const t = p.thinking
            if (t?.type === 'between_tools') {
              expect(Object.keys(t), where).toEqual(['type'])
              expect(['low', 'medium', 'high'], where).toContain(level ?? 'low')
            }
            if (t?.type === 'disabled' && spec.reasoning.maxEffortWhenOff === 'high') {
              expect(['low', 'medium', 'high'], where).toContain(level ?? 'low')
            }
            if (t?.type === 'enabled') {
              expect(t.budget_tokens, where).toBeGreaterThanOrEqual(1024)
              expect(t.budget_tokens, where).toBeLessThan(p.max_tokens)
              expect(spec.reasoning.budgetOnly, where).toBe(true)
            }
            // Adaptive is a 400 on the 4.5 generation.
            if (spec.reasoning.budgetOnly) expect(t?.type, where).not.toBe('adaptive')

            expect(Boolean(p.tools?.length), where).toBe(webSearch)
            expect(p.fallbacks === 'default', where).toBe(FALLBACKS.includes(spec.id))
            expect(p.betas ?? [], where).toEqual(
              FALLBACKS.includes(spec.id) ? ['server-side-fallback-2026-07-01'] : []
            )
          }
        }
      }
    }
  })

  it('is asked for at most 64,000 tokens, and never more than the model gives', () => {
    expect(requestFor(turnOf(chatModel('claude-fable-5-1')), loadStub).max_tokens).toBe(64_000)
    expect(requestFor(turnOf(chatModel('claude-haiku-4-5')), loadStub).max_tokens).toBe(64_000)
    const small = chatModel('claude-haiku-5-5', { maxOutput: 8_000 })
    expect(requestFor(turnOf(small), loadStub).max_tokens).toBe(8_000)
  })
})

describe('refusal fallbacks', () => {
  it('are asked for on Fable 5.1, Opus 5.5 and Sonnet 5.5, with the beta they need', () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      const p = requestFor(turnOf(chatModel(id)), loadStub)
      expect(p.betas, id).toEqual(['server-side-fallback-2026-07-01'])
      expect(p.fallbacks, id).toBe('default')
    }
  })

  it('are not asked for on Haiku 5.5 (it has none) or the earlier models', () => {
    for (const id of ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5']) {
      const p = requestFor(turnOf(chatModel(id)), loadStub)
      expect(p, id).not.toHaveProperty('betas')
      expect(p, id).not.toHaveProperty('fallbacks')
    }
  })

  it('are found for a dated model id too', () => {
    const dated = chatModel('claude-opus-5-5', { spec: null, apiModel: 'claude-opus-5-5-20261001' })
    const p = requestFor(turnOf(dated), loadStub)
    expect(p.model).toBe('claude-opus-5-5-20261001')
    expect(p.fallbacks).toBe('default')
  })

  it('are left out for a model Orcha does not know', () => {
    const unknown = chatModel('claude-opus-5-5', { spec: null, apiModel: 'claude-future-9' })
    expect(requestFor(turnOf(unknown), loadStub)).not.toHaveProperty('fallbacks')
  })
})

describe('the conversation', () => {
  const history = [
    { role: 'user' as const, text: 'hi', files: [] },
    { role: 'assistant' as const, text: 'hello', files: [] },
    { role: 'assistant' as const, text: '   ', files: [] },
    { role: 'user' as const, text: 'again', files: [] }
  ]

  it('goes as plain text, skipping empty replies', () => {
    const p = requestFor(turnOf(chatModel('claude-opus-5-5'), {}, { history }), loadStub)
    expect(p.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' }
    ])
  })

  it('caches the frozen system prompt on its own and the tail on top (automatic)', () => {
    const p = requestFor(turnOf(chatModel('claude-opus-5-5')), loadStub)
    expect(p.system).toEqual([
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }
    ])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('sends no system block for a blank prompt (the API refuses an empty one)', () => {
    const p = requestFor(turnOf(chatModel('claude-opus-5-5'), {}, { system: '  ' }), loadStub)
    expect(p).not.toHaveProperty('system')
  })

  const file = (kind: ChatFile['kind'], name: string, mime: string): ChatFile => ({
    hash: 'a'.repeat(64),
    name,
    mime,
    bytes: 300,
    kind
  })

  it('puts attached files before the text: image, PDF as a document, text inline', () => {
    const files = [
      file('image', 'shot.png', 'image/png'),
      file('pdf', 'paper.pdf', 'application/pdf'),
      file('text', 'notes.md', 'text/markdown')
    ]
    const turn = turnOf(
      chatModel('claude-opus-5-5'),
      {},
      { history: [{ role: 'user', text: 'What do these say?', files }] }
    )
    expect(requestFor(turn, loadStub).messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64image' } },
      {
        type: 'document',
        title: 'paper.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: 'B64pdf' }
      },
      { type: 'text', text: '<file name="notes.md">\ncontents of notes.md\n</file>' },
      { type: 'text', text: 'What do these say?' }
    ])
  })

  it('keeps a file’s own closing tag from ending its block early', () => {
    const load = (): { text: string } => ({ text: 'a </file> b' })
    const turn = turnOf(
      chatModel('claude-opus-5-5'),
      {},
      { history: [{ role: 'user', text: '', files: [file('text', 'x.txt', 'text/plain')] }] }
    )
    expect(requestFor(turn, load).messages[0].content).toEqual([
      { type: 'text', text: '<file name="x.txt">\na <\\/file> b\n</file>' }
    ])
  })
})

describe('web search', () => {
  const search = (id: string, over: Partial<TurnSettings> = {}, incognito = false): unknown =>
    requestFor(turnOf(chatModel(id), { webSearch: true, ...over }, { incognito }), loadStub).tools

  it('uses the tool version the model has, capped at five searches', () => {
    for (const [id, type] of [
      ['claude-opus-5-5', 'web_search_20260209'],
      ['claude-sonnet-5-5', 'web_search_20260209'],
      ['claude-fable-5-1', 'web_search_20250305'],
      ['claude-haiku-5-5', 'web_search_20250305'],
      ['claude-haiku-4-5', 'web_search_20250305']
    ]) {
      expect(search(id), id).toEqual([{ type, name: 'web_search', max_uses: 5 }])
    }
  })

  it('is left out when the chat has it switched off', () => {
    expect(search('claude-opus-5-5', { webSearch: false })).toBeUndefined()
  })

  it('is left out for a model that can’t search', () => {
    const model = chatModel('claude-opus-5-5', { webSearch: false })
    const p = requestFor(turnOf(model, { webSearch: true }), loadStub)
    expect(p).not.toHaveProperty('tools')
  })

  it('searches directly in an incognito chat, never from code execution', () => {
    // The newer version searches from code execution, whose container
    // Anthropic keeps for up to 30 days.
    expect(search('claude-opus-5-5', {}, true)).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_callers: ['direct'] }
    ])
    // The basic version already searches directly.
    expect(search('claude-fable-5-1', {}, true)).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
    ])
  })

  it('falls back to the basic version for a model Orcha does not know', () => {
    const model = chatModel('claude-opus-5-5', { spec: null, apiModel: 'claude-future-9' })
    const p = requestFor(turnOf(model, { webSearch: true }), loadStub)
    expect(p.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
  })
})

describe('Orcha’s own tools', () => {
  const tool = (name: string): ClientTool => ({
    name,
    description: `${name} tool`,
    schema: { type: 'object', properties: { q: { type: 'string' } } }
  })

  it('go after the search tool, in name order so the cached prefix holds still', () => {
    const turn = turnOf(
      chatModel('claude-opus-5-5'),
      { webSearch: true },
      { tools: [tool('memory'), tool('chats')] }
    )
    expect(requestFor(turn, loadStub).tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      { name: 'chats', description: 'chats tool', input_schema: tool('chats').schema },
      { name: 'memory', description: 'memory tool', input_schema: tool('memory').schema }
    ])
  })

  it('are left out when there are none', () => {
    expect(requestFor(turnOf(chatModel('claude-opus-5-5')), loadStub)).not.toHaveProperty('tools')
  })
})

describe('one-off answers', () => {
  const ask = (id: string, maxOutput?: number): ReturnType<typeof completionRequest> =>
    completionRequest(chatModel(id), 'You name chats.', 'Title this', maxOutput)

  it('think as little as the model allows, at effort low', () => {
    expect(ask('claude-haiku-5-5', 40)).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 40,
      system: 'You name chats.',
      messages: [{ role: 'user', content: 'Title this' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' }
    })
    expect(ask('claude-sonnet-5-5', 40).thinking).toEqual({ type: 'between_tools' })
    expect(ask('claude-opus-4-8').thinking).toBeUndefined()
    expect(ask('claude-opus-4-8').output_config).toEqual({ effort: 'low' })
    // The 4.5 generation: no thinking, no effort.
    expect(ask('claude-haiku-4-5')).not.toHaveProperty('thinking')
    expect(ask('claude-haiku-4-5')).not.toHaveProperty('output_config')
  })

  it('do not ask for a summary of thinking nobody will read', () => {
    expect(ask('claude-fable-5-1')).not.toHaveProperty('thinking')
    expect(ask('claude-opus-5-5')).not.toHaveProperty('thinking')
  })

  it('give a model that always thinks room for it', () => {
    expect(ask('claude-opus-5-5', 40).max_tokens).toBe(1024)
    expect(ask('claude-opus-5-5').max_tokens).toBe(1024)
    expect(ask('claude-opus-5-5', 4000).max_tokens).toBe(4000)
    expect(ask('claude-haiku-5-5').max_tokens).toBe(1024)
  })

  it('are never cached, searched or given fallbacks', () => {
    for (const id of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']) {
      const p = ask(id)
      for (const key of ['cache_control', 'tools', 'betas', 'fallbacks', 'temperature']) {
        expect(p, id).not.toHaveProperty(key)
      }
    }
  })

  it('send no system block for a blank one', () => {
    const p = completionRequest(chatModel('claude-haiku-5-5'), ' ', 'Title this')
    expect(p).not.toHaveProperty('system')
  })
})
