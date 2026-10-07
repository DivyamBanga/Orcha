import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatSource } from '../../shared/types'
import {
  addUsage,
  citeMarks,
  fileText,
  MAX_ROUNDS,
  mediaHeader,
  TurnAborted,
  type ChatAdapter,
  type FileLoader,
  type HistoryMessage,
  type TurnInput,
  type TurnResult
} from './adapter'

// Claude through the relay (a guest's chats). The relay holds the real key
// and meters every reply against the guest's Claude budget.

// Models whose thinking can't be turned off get server-side refusal
// fallbacks: if a safety check declines, the same request reruns on the
// fallback model inside the same call instead of just stopping.
const FALLBACK_MODEL = 'claude-opus-4-8'

export function anthropicAdapter(
  relay: { relay: string; token: string },
  headers: Record<string, string>,
  load: FileLoader
): ChatAdapter {
  const client = new Anthropic({
    baseURL: `${relay.relay}/anthropic`,
    authToken: relay.token,
    apiKey: null,
    defaultHeaders: headers,
    maxRetries: 1
  })

  return {
    async run(turn, emit, signal, runTool) {
      const params = requestFor(turn, load)
      const messages = [...params.messages]
      let text = ''
      let thinking = ''
      let thinkingStarted = 0
      let thinkingMs = 0
      let usage: TurnResult['usage'] = null
      let model: string | null = null
      // Pages the search found, and which of them the text block being
      // written cites (marked at its end, where the claim finishes).
      const sources: ChatSource[] = []
      let cited: number[] = []
      const partial = (): TurnResult => ({
        text,
        parts: {
          ...(thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {}),
          ...(sources.length ? { sources } : {})
        },
        usage,
        model
      })
      const source = (url: string, title: string | null | undefined): number => {
        const known = sources.findIndex((s) => s.url === url)
        if (known >= 0) return known
        sources.push({ url, title: title || url })
        return sources.length - 1
      }
      try {
        // One model call per round; a tool use (or a long search pausing the
        // turn) sends what it did back and goes again.
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const stream = client.beta.messages.stream(
            { ...params, messages },
            { signal, headers: mediaHeader(turn.history) }
          )
          // A later round's words start a new paragraph after the last ones.
          let opened = round === 0
          for await (const event of stream) {
            if (event.type === 'content_block_start') {
              const block = event.content_block
              if (block.type === 'server_tool_use') {
                emit({ kind: 'tool', tool: { kind: 'search', label: 'Searching the web' } })
              } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
                for (const r of block.content) {
                  if (r.type === 'web_search_result') source(r.url, r.title)
                }
              } else if (block.type === 'text') {
                cited = []
              }
            } else if (event.type === 'content_block_stop') {
              if (cited.length) {
                const marks = citeMarks(cited, sources)
                text += marks
                emit({ kind: 'text', delta: marks })
                cited = []
              }
            } else if (event.type === 'content_block_delta') {
              if (
                event.delta.type === 'citations_delta' &&
                event.delta.citation.type === 'web_search_result_location'
              ) {
                const n = source(event.delta.citation.url, event.delta.citation.title)
                if (!cited.includes(n)) cited.push(n)
              }
              if (event.delta.type === 'thinking_delta') {
                if (!thinkingStarted) thinkingStarted = Date.now()
                thinking += event.delta.thinking
                emit({ kind: 'thinking', delta: event.delta.thinking })
              } else if (event.delta.type === 'text_delta') {
                if (thinkingStarted && !thinkingMs) thinkingMs = Date.now() - thinkingStarted
                let delta = event.delta.text
                if (!opened && text.trim()) delta = '\n\n' + delta.trimStart()
                opened = true
                text += delta
                emit({ kind: 'text', delta })
              }
            }
          }
          const final = await stream.finalMessage()
          if (final.stop_reason === 'refusal') {
            throw new Error(
              'The model declined to answer this one. Try rephrasing it, or ask another model.'
            )
          }
          const u = final.usage
          usage = addUsage(usage, {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0
          })
          model = final.model
          const toolUse = final.stop_reason === 'tool_use' && runTool
          if (final.stop_reason !== 'pause_turn' && !toolUse) break
          // What it said and did goes back as is (thinking signatures and all,
          // which a turn that's still going needs).
          messages.push({ role: 'assistant', content: final.content as BetaContentBlockParam[] })
          if (toolUse) {
            messages.push({
              role: 'user',
              content: final.content.flatMap((b) =>
                b.type === 'tool_use'
                  ? [
                      {
                        type: 'tool_result' as const,
                        tool_use_id: b.id,
                        content: runTool({ name: b.name, input: b.input })
                      }
                    ]
                  : []
              )
            })
          }
        }
        return partial()
      } catch (err) {
        if (signal.aborted) throw new TurnAborted(partial())
        throw new Error(describe(err))
      }
    },

    async complete(model, system, prompt) {
      const reply = await client.messages.create({
        model,
        max_tokens: 40,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
      return reply.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
    }
  }
}

// Your message as content blocks: its files first (images, PDFs as documents,
// text inline), then what you wrote. A message without files stays a string.
export function userContent(m: HistoryMessage, load: FileLoader): BetaMessageParam['content'] {
  if (m.files.length === 0) return m.text
  const blocks: BetaContentBlockParam[] = m.files.map((f) => {
    const data = load(f)
    if ('text' in data) return { type: 'text', text: fileText(f.name, data.text) }
    return f.kind === 'image'
      ? {
          type: 'image',
          source: { type: 'base64', media_type: f.mime as 'image/png', data: data.base64 }
        }
      : {
          type: 'document',
          title: f.name,
          source: { type: 'base64', media_type: 'application/pdf', data: data.base64 }
        }
  })
  if (m.text.trim()) blocks.push({ type: 'text', text: m.text })
  return blocks
}

export function requestFor(turn: TurnInput, load: FileLoader): BetaMessageStreamParams {
  const { model } = turn
  const messages: BetaMessageParam[] = turn.history
    .filter((m) => m.text.trim() || m.files.length > 0)
    .map((m) => ({ role: m.role, content: m.role === 'user' ? userContent(m, load) : m.text }))
  const params: BetaMessageStreamParams = {
    model: model.id,
    max_tokens: 32_000,
    // The frozen system prompt is cached on its own, and the conversation's
    // tail on top of it (top-level automatic caching).
    system: [{ type: 'text', text: turn.system, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages
  }
  // Thinking. "always" models can't turn it off, so the toggle sets how hard
  // they think instead; Haiku still takes a token budget.
  if (model.thinking === 'toggle') {
    params.thinking = turn.thinking
      ? { type: 'adaptive', display: 'summarized' }
      : { type: 'disabled' }
  } else if (model.thinking === 'always') {
    params.thinking = { type: 'adaptive', display: 'summarized' }
    params.output_config = { effort: turn.thinking ? 'high' : 'low' }
    params.betas = ['server-side-fallback-2026-06-01']
    params.fallbacks = [{ model: FALLBACK_MODEL }]
  } else if (model.thinking === 'budget' && turn.thinking) {
    params.thinking = { type: 'enabled', budget_tokens: 8_000 }
  }
  const tools: BetaMessageStreamParams['tools'] = []
  if (turn.webSearch && model.webSearch) {
    tools.push({ type: model.webSearch, name: 'web_search', max_uses: 5 } as never)
  }
  for (const t of turn.tools ?? []) {
    tools.push({
      name: t.name,
      description: t.description,
      input_schema: t.schema as BetaTool.InputSchema
    })
  }
  if (tools.length) params.tools = tools
  return params
}

// The relay words its refusals for people (budget used up, access off); show
// those as they are, and anything else as plainly as possible.
function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | undefined
    const message = body?.error?.message ?? err.message
    return message.replace(/^Orcha( relay)?: /, '')
  }
  if (err instanceof Error) return err.message
  return String(err)
}
