import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { optionsFor, promptFor, zodShape } from './claudeMax'
import type { ClientTool, FileLoader, TurnInput } from './adapter'
import type { CatalogModel } from '../../shared/types'

// The memory tool's shape (memory.ts needs the database, so not imported).
const MEMORY_TOOL: ClientTool = {
  name: 'memory',
  description: 'Save or remove a memory.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget'] },
      text: { type: 'string', description: 'For remember: one short sentence.' },
      id: { type: 'integer', description: 'For forget: the number of the memory.' }
    },
    required: ['action']
  }
}

const load: FileLoader = (f) =>
  f.kind === 'text' ? { text: `contents of ${f.name}` } : { base64: `B64${f.kind}` }

const model = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'claude-sonnet-5',
  label: 'Sonnet 5',
  description: '',
  pool: 'claude',
  provider: 'anthropic',
  chat: true,
  codex: false,
  thinking: 'toggle',
  webSearch: 'web_search_20260209',
  vision: true,
  pdfPages: 600,
  rates: { in: 2, out: 10, cacheRead: 0.2 },
  ...over
})

const turn = (over: Partial<TurnInput>): TurnInput => ({
  model: model({}),
  system: 'SYSTEM',
  history: [
    { role: 'user', text: 'hi', files: [] },
    { role: 'assistant', text: 'hello', files: [] },
    { role: 'assistant', text: '   ', files: [] },
    {
      role: 'user',
      text: 'again',
      files: [
        { hash: 'a'.repeat(64), name: 'shot.png', mime: 'image/png', bytes: 9, kind: 'image' }
      ]
    }
  ],
  thinking: false,
  webSearch: false,
  ...over
})

const FRESH = { id: 'S1', at: null, fresh: true }

describe('Claude on the host’s plan', () => {
  it('starts a session under the id it was given, with nothing of the machine’s setup', () => {
    const o = optionsFor(turn({}), { id: 'S1', at: null, fresh: true })
    expect(o.sessionId).toBe('S1')
    expect(o.resume).toBeUndefined()
    expect(o.settingSources).toEqual([])
    expect(o.tools).toEqual([])
    expect(o.permissionMode).toBe('dontAsk')
    expect(o.systemPrompt).toBe('SYSTEM')
    expect(o.model).toBe('claude-sonnet-5')
  })

  it('carries on a session from the reply before', () => {
    const o = optionsFor(turn({}), { id: 'S1', at: 'U9', fresh: false })
    expect(o.resume).toBe('S1')
    expect(o.resumeSessionAt).toBe('U9')
    expect(o.sessionId).toBeUndefined()
  })

  it('carries on a copy of an earlier branch from its end', () => {
    const o = optionsFor(turn({}), { id: 'F1', at: null, fresh: false })
    expect(o.resume).toBe('F1')
    expect(o.resumeSessionAt).toBeUndefined()
    expect(o.sessionId).toBeUndefined()
  })

  it('offers web search only when asked and the model has it, and the memory tool by name', () => {
    const tools = [MEMORY_TOOL]
    expect(optionsFor(turn({ webSearch: true, tools }), FRESH)).toMatchObject({
      tools: ['WebSearch'],
      allowedTools: ['WebSearch', 'mcp__orcha__memory']
    })
    expect(
      optionsFor(turn({ webSearch: true, model: model({ webSearch: null }) }), FRESH).tools
    ).toEqual([])
  })

  it('maps thinking like the API does', () => {
    expect(optionsFor(turn({ thinking: true }), FRESH).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized'
    })
    expect(optionsFor(turn({}), FRESH).thinking).toEqual({ type: 'disabled' })
    const always = optionsFor(turn({ model: model({ thinking: 'always' }) }), FRESH)
    expect(always.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(always.effort).toBe('low')
    expect(
      optionsFor(turn({ model: model({ thinking: 'always' }), thinking: true }), FRESH).effort
    ).toBe('high')
    expect(
      optionsFor(turn({ model: model({ thinking: 'budget' }), thinking: true }), FRESH).thinking
    ).toEqual({ type: 'enabled', budgetTokens: 8000, display: 'summarized' })
  })

  it('sends only the new message when carrying on a session', () => {
    const p = promptFor(turn({}), load, true)
    expect(p.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64image' } },
      { type: 'text', text: 'again' }
    ])
  })

  it('writes out the conversation so far when starting afresh', () => {
    const content = promptFor(turn({}), load, false).message.content as {
      type: string
      text?: string
    }[]
    expect(content[0].text).toContain(
      '<conversation_so_far>\nThem: hi\n\nYou: hello\n</conversation_so_far>'
    )
    expect(content.slice(1).map((b) => b.type)).toEqual(['image', 'text'])
    // A first message has nothing before it.
    const first = promptFor(
      turn({ history: [{ role: 'user', text: 'hi', files: [] }] }),
      load,
      false
    )
    expect(first.message.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('turns the memory tool’s JSON Schema into the shape the SDK checks input with', () => {
    const schema = z.object(zodShape(MEMORY_TOOL.schema))
    expect(schema.safeParse({ action: 'remember', text: 'Likes tea.' }).success).toBe(true)
    expect(schema.safeParse({ action: 'forget', id: 3 }).success).toBe(true)
    expect(schema.safeParse({ action: 'shout' }).success).toBe(false)
    expect(schema.safeParse({ action: 'forget', id: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ text: 'no action' }).success).toBe(false)
  })
})
