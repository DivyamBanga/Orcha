import { describe, expect, it } from 'vitest'
import { requestFor as claudeRequest } from './anthropic'
import { requestBody as responsesBody } from './responses'
import { mediaHeader, type FileLoader, type TurnInput } from './adapter'
import type { CatalogModel, ChatFile } from '../../shared/types'

// Files read back as fixed stand-ins.
const load: FileLoader = (f) =>
  f.kind === 'text' ? { text: `contents of ${f.name}` } : { base64: `B64${f.kind}` }
const requestFor = (t: TurnInput): ReturnType<typeof claudeRequest> => claudeRequest(t, load)
const requestBody = (t: TurnInput): string => responsesBody(t, load)

const file = (kind: ChatFile['kind'], name: string, mime: string, bytes = 300): ChatFile => ({
  hash: 'a'.repeat(64),
  name,
  mime,
  bytes,
  kind
})
const withFiles: TurnInput['history'] = [
  {
    role: 'user',
    text: 'What do these say?',
    files: [
      file('image', 'shot.png', 'image/png'),
      file('pdf', 'paper.pdf', 'application/pdf', 3000),
      file('text', 'notes.md', 'text/markdown')
    ]
  }
]

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
    { role: 'user', text: 'again', files: [] }
  ],
  thinking: false,
  webSearch: false,
  ...over
})

describe('Claude requests', () => {
  it('sends history as plain text, skips empty replies, caches system and tail', () => {
    const p = requestFor(turn({}))
    expect(p.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' }
    ])
    expect(p.system).toEqual([
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }
    ])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.tools).toBeUndefined()
  })

  it('maps the thinking toggle per model', () => {
    expect(requestFor(turn({ thinking: true })).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized'
    })
    expect(requestFor(turn({ thinking: false })).thinking).toEqual({ type: 'disabled' })

    const opus = requestFor(turn({ model: model({ id: 'claude-opus-5-5', thinking: 'always' }) }))
    expect(opus.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(opus.output_config).toEqual({ effort: 'low' })
    expect(opus.fallbacks).toEqual([{ model: 'claude-opus-4-8' }])

    const haiku = model({ id: 'claude-haiku-4-5', thinking: 'budget' })
    expect(requestFor(turn({ model: haiku, thinking: false })).thinking).toBeUndefined()
    expect(requestFor(turn({ model: haiku, thinking: true })).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 8000
    })
  })

  it('adds the model’s own web search tool', () => {
    expect(requestFor(turn({ webSearch: true })).tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
    ])
  })
})

describe('Azure (Responses) requests', () => {
  const gpt = model({
    id: 'gpt-6-sol',
    provider: 'azure',
    pool: 'sol',
    thinking: 'reasoning',
    webSearch: 'web_search'
  })

  it('puts "model" first so the relay never parses the body', () => {
    expect(requestBody(turn({ model: gpt }))).toMatch(/^\{"model":"gpt-6-sol",/)
  })

  it('sends the system prompt as a developer message and history as text', () => {
    const body = JSON.parse(requestBody(turn({ model: gpt, thinking: true, webSearch: true })))
    expect(body.store).toBe(false)
    expect(body.input[0]).toEqual({ role: 'developer', content: 'SYSTEM' })
    expect(body.input.slice(1)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'again' }] }
    ])
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.tools).toEqual([{ type: 'web_search' }])
  })
})

describe('attached files', () => {
  it('go to Claude before the text: image, PDF document, text inline', () => {
    const content = requestFor(turn({ history: withFiles })).messages[0].content
    expect(content).toEqual([
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

  it('go to GPT as data URLs and inline text', () => {
    const gpt = model({ id: 'gpt-6-sol', provider: 'azure', pool: 'sol', thinking: 'reasoning' })
    const body = JSON.parse(requestBody(turn({ model: gpt, history: withFiles })))
    expect(body.input[1].content).toEqual([
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

  it('tell the relay how much media a request carries', () => {
    expect(mediaHeader(withFiles)).toEqual({ 'x-orcha-media': '2,4400' })
    expect(mediaHeader(turn({}).history)).toEqual({})
  })
})
