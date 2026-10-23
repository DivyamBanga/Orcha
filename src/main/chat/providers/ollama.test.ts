import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalModel, TurnSettings } from '../../../shared/ai'
import type { ChatFile } from '../../../shared/types'
import {
  fakeOllama,
  json,
  ndjson,
  sleep,
  type FakeHandler,
  type FakeOllama,
  type FakeRequest
} from '../../connections/ollamaFake'
import {
  NO_USAGE,
  ProviderError,
  TurnStopped,
  type ClientTool,
  type FileLoader,
  type HistoryMessage,
  type Provider,
  type ProviderTurn,
  type StreamEvent,
  type ToolRunner
} from '../provider'
import {
  chatMessages,
  localChatModel,
  ollamaProvider,
  reasoningFor,
  thinkFor,
  toolProblems
} from './ollama'

// ---- the models and the turn ----

const local = (over: Partial<LocalModel> = {}): LocalModel => ({
  name: 'qwen3.5:4b',
  sizeBytes: 3389983735,
  family: 'qwen35',
  parameters: '4.7B',
  quantization: 'Q4_K_M',
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
  think: true,
  contextMax: 262144,
  context: 32768,
  loaded: false,
  ...over
})
const qwen = localChatModel(local())
const gptOss = localChatModel(
  local({
    name: 'gpt-oss:20b',
    capabilities: ['completion', 'tools', 'thinking'],
    think: ['low', 'medium', 'high']
  })
)
const llama = localChatModel(
  local({ name: 'llama3.2:3b', capabilities: ['completion', 'tools'], think: false })
)
const bare = localChatModel(local({ name: 'tiny:1b', capabilities: ['completion'], think: false }))

const settings: TurnSettings = {
  effort: null,
  thinking: false,
  webSearch: false,
  verbosity: null,
  temperature: null,
  topP: null,
  keyId: null
}
const thinking = { ...settings, thinking: true }

const user = (text: string, files: ChatFile[] = []): HistoryMessage => ({
  role: 'user',
  text,
  files
})
const reply = (text: string): HistoryMessage => ({ role: 'assistant', text, files: [] })
const turnOf = (over: Partial<ProviderTurn> = {}): ProviderTurn => ({
  model: qwen,
  system: 'SYSTEM',
  history: [user('hi'), reply('hello'), reply('   '), user('again')],
  settings,
  tools: [],
  ...over
})

const file = (
  kind: ChatFile['kind'],
  name: string,
  mime = 'application/octet-stream'
): ChatFile => ({
  hash: 'a'.repeat(64),
  name,
  mime,
  bytes: 300,
  kind
})
// Files read back as fixed stand-ins; a "scanned" PDF has no text.
const load: FileLoader = (f) => {
  if (f.kind === 'text') return { text: `contents of ${f.name}` }
  if (f.kind === 'pdf' && !f.name.startsWith('scanned')) return { text: `text of ${f.name}` }
  return { base64: `B64:${f.name}` }
}

// ---- a fake Ollama and the lines it streams ----

const at = '2026-10-23T01:40:00Z'
const chunk = (message: object, extra: object = {}): object => ({
  model: 'qwen3.5:4b',
  created_at: at,
  message: { role: 'assistant', content: '', ...message },
  done: false,
  ...extra
})
const said = (content: string): object => chunk({ content })
const thought = (text: string): object => chunk({ thinking: text })
const called = (name: string, args: unknown): object =>
  chunk({ tool_calls: [{ id: 'call_1', function: { index: 0, name, arguments: args } }] })
const finished = (extra: object = {}): object =>
  chunk(
    {},
    {
      done: true,
      done_reason: 'stop',
      total_duration: 3e9,
      load_duration: 5e6,
      prompt_eval_count: 30,
      prompt_eval_duration: 2e8,
      eval_count: 7,
      eval_duration: 4e8,
      ...extra
    }
  )

type Answer = object[] | ((req: FakeRequest, res: ServerResponse) => void | Promise<void>)

// Answers each chat request with the next of `answers` (the last one keeps
// answering when they run out), and says whether qwen3.5:4b is in memory.
function scripted(answers: Answer[], loaded = true, context = 32768): FakeHandler {
  let n = 0
  return (req, res) => {
    if (req.path === '/api/ps') {
      const models = loaded ? [{ name: 'qwen3.5:4b', context_length: context }] : []
      return json(res, 200, { models })
    }
    const answer = answers[Math.min(n++, answers.length - 1)]
    return typeof answer === 'function' ? answer(req, res) : ndjson(res, answer)
  }
}

const servers: FakeOllama[] = []
async function serve(handler: FakeHandler): Promise<FakeOllama> {
  const server = await fakeOllama(handler)
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

interface ChatBody {
  model: string
  messages: Record<string, unknown>[]
  tools?: unknown[]
  stream?: boolean
  think?: unknown
  keep_alive?: string
  options: Record<string, unknown>
}
const chats = (server: FakeOllama): ChatBody[] =>
  server.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as unknown as ChatBody)

const provider = (server: FakeOllama, thinkingBudget?: number): Provider =>
  ollamaProvider({ baseURL: server.url, load, contextFor: () => 32768, thinkingBudget })

async function run(
  server: FakeOllama,
  turn: ProviderTurn,
  o: { runTool?: ToolRunner; budget?: number; signal?: AbortSignal; using?: Provider } = {}
): Promise<{ result: Awaited<ReturnType<Provider['run']>>; events: StreamEvent[] }> {
  const events: StreamEvent[] = []
  const result = await (o.using ?? provider(server, o.budget)).run(
    turn,
    (e) => events.push(e),
    o.signal ?? new AbortController().signal,
    o.runTool
  )
  return { result, events }
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await sleep(10)
}

// A tool runner that remembers what it was asked.
const recorder =
  (calls: unknown[], answer = 'ran'): ToolRunner =>
  async (call) => {
    calls.push(call)
    return answer
  }

const memory: ClientTool = {
  name: 'memory',
  description: 'Save or remove a memory.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget'] },
      text: { type: 'string', description: 'For remember: one short sentence.' },
      id: { type: 'integer' }
    },
    required: ['action']
  }
}

// ---- tests ----

describe('what is sent to Ollama', () => {
  it('sends num_ctx and keep_alive with the conversation as visible text', async () => {
    const server = await serve(scripted([[said('Hello'), finished()]]))
    await run(server, turnOf())
    expect(chats(server)).toEqual([
      {
        model: 'qwen3.5:4b',
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'again' }
        ],
        stream: true,
        think: false,
        keep_alive: '5m',
        options: { num_ctx: 32768, temperature: 0.7, top_p: 0.8, num_predict: 8192 }
      }
    ])
  })

  it('uses the context it was told to, whatever the model’s own limit', async () => {
    const server = await serve(scripted([[said('Hello'), finished()]]))
    const using = ollamaProvider({
      baseURL: server.url,
      load,
      contextFor: (model) => (model === 'qwen3.5:4b' ? 16384 : 1)
    })
    await run(server, turnOf(), { using })
    expect(chats(server)[0].options.num_ctx).toBe(16384)
  })

  it('leaves the system message out when there is none', () => {
    expect(chatMessages(turnOf({ system: '  ' }), load)[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('sends tools as functions, only when they can be run', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]]))
    await run(server, turnOf({ tools: [memory] }), { runTool: async () => 'ok' })
    expect(chats(server)[0].tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'memory',
          description: 'Save or remove a memory.',
          parameters: memory.schema
        }
      }
    ])
    // No way to run them, or a model that can't use them: none are offered.
    await run(server, turnOf({ tools: [memory] }))
    await run(server, turnOf({ tools: [memory], model: bare }), { runTool: async () => 'ok' })
    expect(
      chats(server)
        .slice(1)
        .map((b) => b.tools)
    ).toEqual([undefined, undefined])
  })

  describe('sampling', () => {
    it('gives Qwen3 the model card’s profile when thinking is off', async () => {
      const server = await serve(scripted([[said('Hi'), finished()]]))
      await run(server, turnOf())
      expect(chats(server)[0].options).toMatchObject({ temperature: 0.7, top_p: 0.8 })
    })

    it('leaves Ollama’s own sampling alone when thinking is on', async () => {
      const server = await serve(scripted([[said('Hi'), finished()]]))
      await run(server, turnOf({ settings: thinking }))
      expect(chats(server)[0].options).toEqual({ num_ctx: 32768, num_predict: 8192 })
    })

    it('uses what the person chose, and nothing for other models', async () => {
      const server = await serve(scripted([[said('Hi'), finished()]]))
      await run(server, turnOf({ settings: { ...settings, temperature: 0.2, topP: 0.5 } }))
      await run(server, turnOf({ settings: { ...thinking, temperature: 1.1 } }))
      await run(server, turnOf({ model: llama }))
      expect(chats(server).map((b) => b.options)).toEqual([
        { num_ctx: 32768, temperature: 0.2, top_p: 0.5, num_predict: 8192 },
        { num_ctx: 32768, temperature: 1.1, num_predict: 8192 },
        { num_ctx: 32768, num_predict: 8192 }
      ])
    })
  })

  describe('thinking', () => {
    it('goes on and off for models with a switch', () => {
      expect(thinkFor(qwen.reasoning, settings)).toBe(false)
      expect(thinkFor(qwen.reasoning, thinking)).toBe(true)
    })

    it('is a level for models that take levels, and can’t be turned off', () => {
      expect(thinkFor(gptOss.reasoning, { ...settings, effort: 'high' })).toBe('high')
      expect(thinkFor(gptOss.reasoning, { ...settings, effort: 'low' })).toBe('low')
      // The model's own default when none is chosen; the nearest level to one it doesn't have.
      expect(thinkFor(gptOss.reasoning, settings)).toBe('medium')
      expect(thinkFor(gptOss.reasoning, { ...settings, effort: 'xhigh' })).toBe('high')
      expect(thinkFor(gptOss.reasoning, { ...settings, effort: 'none' })).toBe('low')
    })

    it('is left out for models that don’t think, which would refuse it', async () => {
      expect(thinkFor(llama.reasoning, thinking)).toBeUndefined()
      const server = await serve(scripted([[said('Hi'), finished()]]))
      await run(server, turnOf({ model: llama, settings: thinking }))
      expect('think' in chats(server)[0]).toBe(false)
    })

    it('reaches Ollama as the model takes it', async () => {
      const server = await serve(scripted([[said('Hi'), finished()]]))
      await run(server, turnOf({ model: gptOss, settings: { ...thinking, effort: 'high' } }))
      expect(chats(server)[0].think).toBe('high')
    })

    it('is described to the picker from how Ollama says it thinks', () => {
      expect(reasoningFor(true)).toEqual({
        levels: [],
        defaultLevel: null,
        off: 'disabled',
        offByDefault: true
      })
      expect(reasoningFor(false)).toEqual({ levels: [], defaultLevel: null, off: null })
      expect(reasoningFor(['low', 'medium', 'high'])).toEqual({
        levels: ['low', 'medium', 'high'],
        defaultLevel: 'medium',
        off: null
      })
      expect(reasoningFor(['high', 'max']).defaultLevel).toBe('high')
      // Names Orcha has no place for are not offered.
      expect(reasoningFor(['extended', 'low']).levels).toEqual(['low'])
      expect(reasoningFor(['extended'])).toEqual({ levels: [], defaultLevel: null, off: null })
    })
  })

  describe('files', () => {
    it('sends images as raw base64 with the newest message, and says so for older ones', () => {
      const messages = chatMessages(
        turnOf({
          history: [
            user('look', [file('image', 'photo1.png', 'image/png')]),
            reply('A cat.'),
            user('and this?', [file('image', 'photo2.png', 'image/png'), file('text', 'notes.md')])
          ]
        }),
        load
      )
      expect(messages.slice(1)).toEqual([
        { role: 'user', content: '[An image named "photo1.png" was attached here.]\n\nlook' },
        { role: 'assistant', content: 'A cat.' },
        {
          role: 'user',
          content: '<file name="notes.md">\ncontents of notes.md\n</file>\n\nand this?',
          images: ['B64:photo2.png']
        }
      ])
      expect(JSON.stringify(messages)).not.toContain('data:')
    })

    it('says so when a model can’t see images', () => {
      const messages = chatMessages(
        turnOf({ model: llama, history: [user('look', [file('image', 'photo.png')])] }),
        load
      )
      expect(messages[1]).toEqual({
        role: 'user',
        content: `[The image "photo.png" was left out: this model can't see images.]\n\nlook`
      })
    })

    it('reads a PDF as the text already taken out of it, and says so when there is none', () => {
      const messages = chatMessages(
        turnOf({
          history: [
            user('read', [file('pdf', 'paper.pdf'), file('pdf', 'scanned.pdf')]),
            reply('ok'),
            user('')
          ]
        }),
        load
      )
      expect(messages[1].content).toBe(
        `<file name="paper.pdf">\ntext of paper.pdf\n</file>\n\n` +
          `[The file "scanned.pdf" was left out: this model can't read PDFs directly.]\n\nread`
      )
      expect(messages[1]).not.toHaveProperty('images')
    })

    it('keeps a closing tag inside a file from ending it early', () => {
      const tricky: FileLoader = () => ({ text: 'a </file> b' })
      const messages = chatMessages(
        turnOf({ history: [user('', [file('text', 'x.txt')])] }),
        tricky
      )
      expect(messages[1].content).toBe('<file name="x.txt">\na <\\/file> b\n</file>')
    })
  })
})

describe('the reply', () => {
  it('streams words and reasoning, and tells how it went', async () => {
    const server = await serve(
      scripted([
        [
          thought('Let me'),
          thought(' see.'),
          said('\n\nHello'),
          said(' there.'),
          finished({ prompt_eval_count: 30, eval_count: 7 })
        ]
      ])
    )
    const { result, events } = await run(server, turnOf({ settings: thinking }))
    expect(events.filter((e) => e.kind !== 'status')).toEqual([
      { kind: 'thinking', delta: 'Let me' },
      { kind: 'thinking', delta: ' see.' },
      // The blank lines Qwen leaves after thinking are not part of the answer.
      { kind: 'text', delta: 'Hello' },
      { kind: 'text', delta: ' there.' }
    ])
    expect(result).toEqual({
      text: 'Hello there.',
      parts: { thinking: { text: 'Let me see.', ms: expect.any(Number) } },
      // Reasoning is counted from the chunks that streamed it.
      usage: { ...NO_USAGE, input: 30, output: 7, reasoning: 2 },
      model: 'qwen3.5:4b',
      stop: 'end',
      ttftMs: expect.any(Number)
    })
    expect(result.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('has no thinking part when the model didn’t think', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]]))
    const { result } = await run(server, turnOf())
    expect(result.parts).toEqual({})
  })

  it('counts what was already in Ollama’s cache as cache, not input', async () => {
    const server = await serve(
      scripted([[said('Hi'), finished({ prompt_eval_count: 30, prompt_eval_cached_count: 20 })]])
    )
    const { result } = await run(server, turnOf())
    expect(result.usage).toMatchObject({ input: 10, cacheRead: 20, output: 7 })
  })

  it('puts a line back together when it arrives in pieces', async () => {
    const server = await serve(
      scripted([
        async (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          const hello = JSON.stringify(said('Hello')) + '\n'
          const done = JSON.stringify(finished()) + '\n'
          res.write(hello.slice(0, 25))
          await sleep(15)
          res.write(hello.slice(25) + done.slice(0, 10))
          await sleep(15)
          res.end(done.slice(10))
        }
      ])
    )
    const { result } = await run(server, turnOf())
    expect(result.text).toBe('Hello')
    expect(result.usage?.output).toBe(7)
  })

  it('says why it stopped when it ran out of room', async () => {
    const server = await serve(
      scripted([
        [said('Partial'), finished({ done_reason: 'length' })],
        [
          said('Partial'),
          finished({ done_reason: 'length', prompt_eval_count: 32000, eval_count: 768 })
        ]
      ])
    )
    expect((await run(server, turnOf())).result.stop).toBe('max-tokens')
    expect((await run(server, turnOf())).result.stop).toBe('context-full')
  })

  it('starts a new paragraph for the words after a tool call', async () => {
    const server = await serve(
      scripted([
        [
          said('Let me save that.'),
          called('memory', { action: 'remember', text: 'Tea.' }),
          finished()
        ],
        [said('Done.'), finished()]
      ])
    )
    const { result, events } = await run(server, turnOf({ tools: [memory] }), {
      runTool: async () => 'Remembered.'
    })
    expect(result.text).toBe('Let me save that.\n\nDone.')
    expect(events.filter((e) => e.kind === 'text').map((e) => e.delta)).toEqual([
      'Let me save that.',
      '\n\nDone.'
    ])
  })
})

describe('thinking too long', () => {
  // Thinking that never ends, until the other side hangs up.
  const endless =
    (closed: { value: boolean }): Answer =>
    async (_req, res) => {
      res.on('close', () => (closed.value = true))
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (let i = 0; i < 500 && !res.destroyed; i++) {
        res.write(JSON.stringify(thought(`t${i} `)) + '\n')
        await sleep(2)
      }
      res.end()
    }

  it('cuts it off and asks again with thinking off', async () => {
    const closed = { value: false }
    const server = await serve(scripted([endless(closed), [said('A plain answer.'), finished()]]))
    const { result, events } = await run(server, turnOf({ settings: thinking }), { budget: 5 })

    const [first, second] = chats(server)
    expect(first).toMatchObject({ think: true, options: { num_ctx: 32768 } })
    expect(first.options).not.toHaveProperty('temperature')
    expect(second).toMatchObject({
      think: false,
      messages: first.messages,
      options: { num_ctx: 32768, temperature: 0.7, top_p: 0.8 }
    })
    await until(() => closed.value)
    expect(closed.value).toBe(true)

    expect(result.text).toBe('A plain answer.')
    // What it thought stays on show.
    expect(result.parts.thinking?.text).toBe('t0 t1 t2 t3 t4 t5 ')
    // Reading the prompt again is announced, so the wait isn't a mystery.
    expect(events.filter((e) => e.kind === 'status').map((e) => e.status)).toEqual([
      'reading',
      'reading'
    ])
    // The cut-off try is counted by its reasoning chunks; the second by Ollama.
    expect(result.usage).toMatchObject({ input: 30, output: 6 + 7, reasoning: 6 })
    expect(result.stop).toBe('end')
  })

  it('keeps thinking off for the rest of the turn', async () => {
    const closed = { value: false }
    const server = await serve(
      scripted([
        endless(closed),
        [called('memory', { action: 'remember', text: 'Tea.' }), finished()],
        [said('Done.'), finished()]
      ])
    )
    await run(server, turnOf({ settings: thinking, tools: [memory] }), {
      budget: 3,
      runTool: async () => 'Remembered.'
    })
    expect(chats(server).map((b) => b.think)).toEqual([true, false, false])
  })

  it('asks again with thinking off when it used up its allowance thinking', async () => {
    const server = await serve(
      scripted([
        [thought('Hmm.'), thought(' Hmm.'), finished({ done_reason: 'length', eval_count: 8192 })],
        [said('An answer.'), finished()]
      ])
    )
    const { result } = await run(server, turnOf({ settings: thinking }))
    expect(chats(server).map((b) => b.think)).toEqual([true, false])
    expect(result.text).toBe('An answer.')
    expect(result.parts.thinking?.text).toBe('Hmm. Hmm.')
  })

  it('does not cut off a model that was told how hard to think', async () => {
    const server = await serve(
      scripted([
        async (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          for (let i = 0; i < 20; i++) res.write(JSON.stringify(thought('t')) + '\n')
          res.write(JSON.stringify(said('Done.')) + '\n')
          res.end(JSON.stringify(finished()) + '\n')
        }
      ])
    )
    const { result } = await run(server, turnOf({ model: gptOss, settings: thinking }), {
      budget: 5
    })
    expect(chats(server)).toHaveLength(1)
    expect(result.text).toBe('Done.')
    expect(result.parts.thinking?.text).toHaveLength(20)
  })

  it('doesn’t ask again when the answer had started', async () => {
    const server = await serve(
      scripted([[thought('a'), said('Partial'), finished({ done_reason: 'length' })]])
    )
    const { result } = await run(server, turnOf({ settings: thinking }), { budget: 1 })
    expect(chats(server)).toHaveLength(1)
    expect(result.stop).toBe('max-tokens')
  })
})

describe('tools', () => {
  it('tells the model what was wrong with a call instead of failing', async () => {
    const ran: unknown[] = []
    const runTool: ToolRunner = async (call) => {
      ran.push(call)
      return 'Remembered.'
    }
    const server = await serve(
      scripted([
        // No action: small models leave required arguments out.
        [called('memory', { text: 'Likes tea.' }), finished()],
        [called('memory', { action: 'remember', text: 'Likes tea.' }), finished()],
        [said('Noted.'), finished()]
      ])
    )
    const { result } = await run(server, turnOf({ tools: [memory] }), { runTool })

    expect(ran).toEqual([{ name: 'memory', input: { action: 'remember', text: 'Likes tea.' } }])
    const [, second, third] = chats(server)
    expect(second.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            function: { index: 0, name: 'memory', arguments: { text: 'Likes tea.' } }
          }
        ]
      },
      { role: 'tool', tool_name: 'memory', content: expect.stringContaining('"action" is missing') }
    ])
    expect(second.messages.at(-1)?.content).toContain('required: action')
    expect(third.messages.at(-1)).toEqual({
      role: 'tool',
      tool_name: 'memory',
      content: 'Remembered.'
    })
    expect(result.text).toBe('Noted.')
    expect(result.usage?.output).toBe(21)
  })

  it('sends its reasoning back with the call, as Ollama asks', async () => {
    const server = await serve(
      scripted([
        [thought('I should save this.'), called('memory', { action: 'forget', id: 3 }), finished()],
        [said('Forgotten.'), finished()]
      ])
    )
    await run(server, turnOf({ tools: [memory], settings: thinking }), {
      runTool: async () => 'ok'
    })
    expect(chats(server)[1].messages.at(-2)).toMatchObject({
      role: 'assistant',
      thinking: 'I should save this.'
    })
  })

  it('answers a call to a tool that doesn’t exist', async () => {
    const ran: unknown[] = []
    const server = await serve(
      scripted([
        [called('rm_rf', {}), finished()],
        [said('Sorry.'), finished()]
      ])
    )
    await run(server, turnOf({ tools: [memory] }), {
      runTool: recorder(ran)
    })
    expect(ran).toEqual([])
    expect(chats(server)[1].messages.at(-1)?.content).toBe(
      'There is no tool called "rm_rf". The tools you can use are: memory.'
    )
  })

  it('takes arguments sent as JSON text', async () => {
    const ran: unknown[] = []
    const server = await serve(
      scripted([
        [called('memory', '{"action":"forget","id":3}'), finished()],
        [said('Ok.'), finished()]
      ])
    )
    await run(server, turnOf({ tools: [memory] }), {
      runTool: recorder(ran)
    })
    expect(ran).toEqual([{ name: 'memory', input: { action: 'forget', id: 3 } }])
  })

  it('hands a tool that fails to the model as its answer', async () => {
    const server = await serve(
      scripted([
        [called('memory', { action: 'forget', id: 3 }), finished()],
        [said('Could not.'), finished()]
      ])
    )
    const { result } = await run(server, turnOf({ tools: [memory] }), {
      runTool: async () => {
        throw new Error('the database is locked')
      }
    })
    expect(chats(server)[1].messages.at(-1)?.content).toBe(
      'The "memory" tool failed: the database is locked'
    )
    expect(result.text).toBe('Could not.')
  })

  it('cuts a very long answer from a tool', async () => {
    const server = await serve(
      scripted([
        [called('memory', { action: 'forget', id: 3 }), finished()],
        [said('Ok.'), finished()]
      ])
    )
    await run(server, turnOf({ tools: [memory] }), { runTool: async () => 'x'.repeat(9000) })
    const answer = String(chats(server)[1].messages.at(-1)?.content)
    expect(answer.startsWith('x'.repeat(8000) + '\n')).toBe(true)
    expect(answer.endsWith('the answer was 9000 characters long.]')).toBe(true)
    expect(answer.length).toBeLessThan(8100)
  })

  it('stops after six rounds', async () => {
    const ran: unknown[] = []
    const server = await serve(
      scripted([[called('memory', { action: 'forget', id: 3 }), finished()]])
    )
    const { result } = await run(server, turnOf({ tools: [memory] }), {
      runTool: recorder(ran)
    })
    expect(chats(server)).toHaveLength(6)
    expect(ran).toHaveLength(6)
    expect(result.text).toBe('')
  })

  it('checks a call against the tool’s schema', () => {
    expect(toolProblems(memory, { action: 'remember', text: 'Tea.' })).toBeNull()
    expect(toolProblems(memory, { action: 'forget', id: 3 })).toBeNull()
    expect(toolProblems(memory, {})).toContain('"action" is missing')
    expect(toolProblems(memory, { action: 'save' })).toContain('"action" is not valid')
    expect(toolProblems(memory, { action: 'forget', id: '3' })).toContain('"id" is not valid')
    expect(toolProblems(memory, { action: 'forget', id: 1.5 })).toContain('"id" is not valid')
    expect(toolProblems(memory, { text: 5 })).toMatch(/"action" is missing; "text" is not valid/)
    // A schema it can't read is left for the tool to judge.
    const odd: ClientTool = {
      ...memory,
      schema: { type: 'object', properties: { x: { $ref: '#/nope' } } }
    }
    expect(() => toolProblems(odd, { x: 1 })).not.toThrow()
  })
})

describe('the wait before the first words', () => {
  it('says the model is loading when it isn’t in memory', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]], false))
    const { events } = await run(server, turnOf())
    expect(events[0]).toEqual({ kind: 'status', status: 'loading' })
  })

  it('counts a model loaded with another context as not loaded', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]], true, 8192))
    const { events } = await run(server, turnOf())
    expect(events[0]).toMatchObject({ kind: 'status', status: 'loading' })
  })

  it('says it is reading the prompt once the model is in memory', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]]))
    const { events } = await run(server, turnOf())
    expect(events[0]).toEqual({ kind: 'status', status: 'reading' })
  })

  it('learns how fast the model reads, and says how long a long prompt will take', async () => {
    const server = await serve(
      scripted([
        // 1,000 tokens in 4 s: 250 a second. A cold load took 9 s.
        [
          said('Hi'),
          finished({ prompt_eval_count: 1000, prompt_eval_duration: 4e9, load_duration: 9e9 })
        ],
        [said('Hi'), finished()],
        [said('Hi'), finished()]
      ])
    )
    const using = provider(server)
    await run(server, turnOf(), { using })
    // About 1,000 tokens of prompt.
    const long = turnOf({ history: [user('x'.repeat(3200))] })
    const { events } = await run(server, long, { using })
    const eta = (events[0] as { etaMs: number }).etaMs
    expect(events[0]).toMatchObject({ status: 'reading' })
    expect(eta).toBeGreaterThan(3900)
    expect(eta).toBeLessThan(4400)
  })

  it('adds the time a cold load took last time when the model has to be loaded', async () => {
    let inMemory = true
    const server = await serve((req, res) => {
      if (req.path === '/api/ps') {
        return json(res, 200, {
          models: inMemory ? [{ name: 'qwen3.5:4b', context_length: 32768 }] : []
        })
      }
      ndjson(res, [
        said('Hi'),
        finished({ prompt_eval_count: 1000, prompt_eval_duration: 4e9, load_duration: 9e9 })
      ])
    })
    const using = provider(server)
    await run(server, turnOf(), { using })
    inMemory = false
    const { events } = await run(server, turnOf({ history: [user('x'.repeat(3200))] }), { using })
    expect(events[0]).toMatchObject({ status: 'loading' })
    expect((events[0] as { etaMs: number }).etaMs).toBeGreaterThan(12_900)
  })

  it('ignores a prompt too short to say anything about speed', async () => {
    const server = await serve(
      scripted([
        [said('Hi'), finished({ prompt_eval_count: 20, prompt_eval_duration: 1e9 })],
        [said('Hi'), finished()]
      ])
    )
    const using = provider(server)
    await run(server, turnOf(), { using })
    const { events } = await run(server, turnOf(), { using })
    expect(events[0]).toEqual({ kind: 'status', status: 'reading' })
  })
})

describe('when things go wrong', () => {
  async function failure(server: FakeOllama, turn = turnOf()): Promise<ProviderError> {
    const err = await run(server, turn).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    return err as ProviderError
  }

  it('says Ollama isn’t running when nothing answers', async () => {
    const gone = await fakeOllama(() => {})
    await gone.close()
    const err = await failure(gone)
    expect(err).toMatchObject({
      code: 'unreachable',
      message: "Ollama isn't running. Start it, then try again."
    })
  })

  it('says a model isn’t downloaded when Ollama has never heard of it', async () => {
    const server = await serve((req, res) =>
      req.path === '/api/ps'
        ? json(res, 200, { models: [] })
        : json(res, 404, { error: "model 'qwen3.5:4b' not found" })
    )
    const err = await failure(server)
    expect(err).toMatchObject({ code: 'not-found', status: 404 })
    expect(err.message).toContain('"qwen3.5:4b" isn\'t downloaded')
  })

  it('passes on a model that can’t chat', async () => {
    const server = await serve((req, res) =>
      req.path === '/api/ps'
        ? json(res, 200, { models: [] })
        : json(res, 400, { error: '"qwen3.5:4b" does not support chat' })
    )
    expect(await failure(server)).toMatchObject({ code: 'bad-request', status: 400 })
  })

  it('says Ollama is busy when its queue is full', async () => {
    const server = await serve((req, res) =>
      req.path === '/api/ps'
        ? json(res, 200, { models: [] })
        : json(res, 503, { error: 'server busy' })
    )
    expect(await failure(server)).toMatchObject({ code: 'overloaded', status: 503 })
  })

  it('fails on an error line, even though Ollama answered 200', async () => {
    const server = await serve(
      scripted([[said('Par'), { error: 'llama runner process has terminated: exit status 2' }]])
    )
    const events: StreamEvent[] = []
    const err = await provider(server)
      .run(turnOf(), (e) => events.push(e), new AbortController().signal)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).toContain('llama runner process has terminated')
    expect(events.some((e) => e.kind === 'text' && e.delta === 'Par')).toBe(true)
  })

  it('fails when the stream stops before the end', async () => {
    const server = await serve(scripted([[said('Par')]]))
    const err = await failure(server)
    expect(err).toMatchObject({ code: 'unreachable' })
    expect(err.message).toContain('stopped partway')
  })

  it('fails when the connection drops in the middle of a reply', async () => {
    const server = await serve(
      scripted([
        async (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          res.write(JSON.stringify(said('Par')) + '\n')
          await sleep(10)
          res.destroy()
        }
      ])
    )
    expect(await failure(server)).toMatchObject({ code: 'unreachable' })
  })

  it('keeps what had streamed when it is stopped', async () => {
    const server = await serve(
      scripted([
        async (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          for (let i = 0; i < 200 && !res.destroyed; i++) {
            res.write(JSON.stringify(said(`w${i} `)) + '\n')
            await sleep(5)
          }
          res.end()
        }
      ])
    )
    const stop = new AbortController()
    const err = await provider(server)
      .run(
        turnOf(),
        (e) => {
          if (e.kind === 'text' && e.delta === 'w2 ') stop.abort()
        },
        stop.signal
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TurnStopped)
    expect((err as TurnStopped).partial.text.startsWith('w0 w1 w2 ')).toBe(true)
    expect((err as TurnStopped).partial.model).toBe('qwen3.5:4b')
  })

  it('is stopped at once when told to before it starts', async () => {
    const server = await serve(scripted([[said('Hi'), finished()]]))
    const stop = new AbortController()
    stop.abort()
    const err = await provider(server)
      .run(turnOf(), () => {}, stop.signal)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TurnStopped)
    expect(chats(server)).toHaveLength(0)
  })
})

describe('one-off answers', () => {
  const titled = (): FakeHandler => (_req, res) =>
    json(res, 200, {
      model: 'qwen3.5:4b',
      created_at: at,
      message: { role: 'assistant', content: '  Tea chat \n' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 20,
      eval_count: 4
    })

  it('asks for a short, steady answer with thinking off', async () => {
    const server = await serve(titled())
    const out = await provider(server).complete(qwen, 'Name chats.', 'Hello there', {
      maxOutput: 32
    })
    expect(out).toEqual({ text: 'Tea chat', usage: { ...NO_USAGE, input: 20, output: 4 } })
    expect(chats(server)).toEqual([
      {
        model: 'qwen3.5:4b',
        messages: [
          { role: 'system', content: 'Name chats.' },
          { role: 'user', content: 'Hello there' }
        ],
        stream: false,
        think: false,
        keep_alive: '5m',
        options: { num_ctx: 32768, temperature: 0.3, num_predict: 32 }
      }
    ])
  })

  it('thinks as little as the model lets it, or not at all', async () => {
    const server = await serve(titled())
    await provider(server).complete(gptOss, '', 'Hi')
    await provider(server).complete(llama, '', 'Hi')
    const [oss, plain] = chats(server)
    expect(oss.think).toBe('low')
    expect('think' in plain).toBe(false)
    // No system prompt, and a default cap on the answer.
    expect(oss.messages).toEqual([{ role: 'user', content: 'Hi' }])
    expect(oss.options.num_predict).toBe(512)
  })

  it('fails like a chat does', async () => {
    const gone = await fakeOllama(() => {})
    await gone.close()
    await expect(provider(gone).complete(qwen, '', 'Hi')).rejects.toMatchObject({
      code: 'unreachable'
    })
  })
})

describe('local models in the picker', () => {
  it('describes an installed model', () => {
    expect(qwen).toEqual({
      id: 'ollama:qwen3.5:4b',
      route: 'ollama',
      apiModel: 'qwen3.5:4b',
      label: 'qwen3.5:4b',
      description: '4.7B · Q4_K_M · on this computer',
      spec: null,
      current: true,
      context: 32768,
      maxOutput: 8192,
      vision: true,
      pdf: false,
      tools: true,
      reasoning: { levels: [], defaultLevel: null, off: 'disabled', offByDefault: true },
      sampling: 'always',
      verbosity: false,
      webSearch: false,
      retains30d: false,
      price: null,
      ready: true
    })
    expect(llama).toMatchObject({ vision: false, tools: true, reasoning: { off: null } })
    expect(localChatModel(local({ context: 4096 }), false)).toMatchObject({
      maxOutput: 2048,
      ready: false
    })
  })
})
