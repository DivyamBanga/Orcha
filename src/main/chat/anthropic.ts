import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessageParam,
  BetaMessageStreamParams
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { TurnAborted, type ChatAdapter, type TurnInput, type TurnResult } from './adapter'

// Claude through the relay (a guest's chats). The relay holds the real key
// and meters every reply against the guest's Claude budget.

// Models whose thinking can't be turned off get server-side refusal
// fallbacks: if a safety check declines, the same request reruns on the
// fallback model inside the same call instead of just stopping.
const FALLBACK_MODEL = 'claude-opus-4-8'

export function anthropicAdapter(
  relay: { relay: string; token: string },
  headers: Record<string, string>
): ChatAdapter {
  const client = new Anthropic({
    baseURL: `${relay.relay}/anthropic`,
    authToken: relay.token,
    apiKey: null,
    defaultHeaders: headers,
    maxRetries: 1
  })

  return {
    async run(turn, emit, signal) {
      const params = requestFor(turn)
      const stream = client.beta.messages.stream(params, { signal })
      let text = ''
      let thinking = ''
      let thinkingStarted = 0
      let thinkingMs = 0
      const partial = (): TurnResult => ({
        text,
        parts: thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {},
        usage: null,
        model: null
      })
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'server_tool_use') {
              emit({ kind: 'tool', tool: 'search', label: 'Searching the web' })
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'thinking_delta') {
              if (!thinkingStarted) thinkingStarted = Date.now()
              thinking += event.delta.thinking
              emit({ kind: 'thinking', delta: event.delta.thinking })
            } else if (event.delta.type === 'text_delta') {
              if (thinkingStarted && !thinkingMs) thinkingMs = Date.now() - thinkingStarted
              text += event.delta.text
              emit({ kind: 'text', delta: event.delta.text })
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
        return {
          ...partial(),
          usage: {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0
          },
          model: final.model
        }
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

export function requestFor(turn: TurnInput): BetaMessageStreamParams {
  const { model } = turn
  const messages: BetaMessageParam[] = turn.history
    .filter((m) => m.text.trim() || m.files.length > 0)
    .map((m) => ({ role: m.role, content: m.text }))
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
  if (turn.webSearch && model.webSearch) {
    params.tools = [{ type: model.webSearch, name: 'web_search', max_uses: 5 } as never]
  }
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
