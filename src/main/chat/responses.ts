import { TurnAborted, type ChatAdapter, type TurnInput, type TurnResult } from './adapter'

// GPT models on Azure through the relay (guests' chats, and the host's own),
// over the Responses API. Nothing is stored server-side (store: false): every
// turn sends the conversation, the same way the Claude adapter does.

export function responsesAdapter(
  relay: { relay: string; token: string },
  headers: Record<string, string>
): ChatAdapter {
  const post = (
    body: string,
    signal?: AbortSignal,
    extra: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(`${relay.relay}/openai/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${relay.token}`,
        'content-type': 'application/json',
        ...headers,
        ...extra
      },
      body,
      signal
    })

  return {
    async run(turn, emit, signal) {
      let text = ''
      let thinking = ''
      let thinkingStarted = 0
      let thinkingMs = 0
      let usage: TurnResult['usage'] = null
      let failure: string | null = null
      const partial = (): TurnResult => ({
        text,
        parts: thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {},
        usage,
        model: null
      })
      try {
        const response = await post(requestBody(turn), signal)
        if (!response.ok || !response.body) {
          throw new Error(
            ((await response.text()) || `The relay answered ${response.status}.`).replace(
              /^Orcha( relay)?: /,
              ''
            )
          )
        }
        for await (const event of sseEvents(response.body)) {
          const type = event.type as string
          if (type === 'response.output_text.delta') {
            if (thinkingStarted && !thinkingMs) thinkingMs = Date.now() - thinkingStarted
            const delta = String(event.delta ?? '')
            text += delta
            emit({ kind: 'text', delta })
          } else if (type === 'response.reasoning_summary_text.delta') {
            if (!thinkingStarted) thinkingStarted = Date.now()
            const delta = String(event.delta ?? '')
            thinking += delta
            emit({ kind: 'thinking', delta })
          } else if (type === 'response.web_search_call.in_progress') {
            emit({ kind: 'tool', tool: 'search', label: 'Searching the web' })
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            const u = (event.response as { usage?: ResponsesUsage } | undefined)?.usage
            if (u) {
              const cached = u.input_tokens_details?.cached_tokens ?? 0
              usage = {
                input: (u.input_tokens ?? 0) - cached,
                output: u.output_tokens ?? 0,
                cacheRead: cached,
                cacheWrite: 0
              }
            }
          } else if (type === 'response.failed' || type === 'error') {
            const r = event.response as { error?: { message?: string } } | undefined
            failure =
              r?.error?.message ?? String(event.message ?? 'The model stopped with an error.')
          }
        }
      } catch (err) {
        if (signal.aborted) throw new TurnAborted(partial())
        throw err instanceof Error ? err : new Error(String(err))
      }
      if (failure) throw new Error(failure)
      return { ...partial(), model: turn.model.id }
    },

    async complete(model, system, prompt) {
      const response = await post(
        JSON.stringify({
          model,
          store: false,
          input: [
            { role: 'developer', content: system },
            { role: 'user', content: prompt }
          ],
          reasoning: { effort: 'low' },
          max_output_tokens: 400
        })
      )
      if (!response.ok) throw new Error(`The relay answered ${response.status}.`)
      const body = (await response.json()) as {
        output?: { type?: string; content?: { type?: string; text?: string }[] }[]
      }
      return (body.output ?? [])
        .flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
        .map((c) => (c.type === 'output_text' ? (c.text ?? '') : ''))
        .join('')
        .trim()
    }
  }
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

// "model" leads the JSON: the relay reads it from the first bytes instead of
// parsing a body that can carry megabytes of images.
export function requestBody(turn: TurnInput): string {
  const input = [
    { role: 'developer', content: turn.system },
    ...turn.history
      .filter((m) => m.text.trim() || m.files.length > 0)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', content: [{ type: 'input_text', text: m.text }] }
          : { role: 'assistant', content: [{ type: 'output_text', text: m.text }] }
      )
  ]
  return JSON.stringify({
    model: turn.model.id,
    stream: true,
    store: false,
    input,
    reasoning: { effort: turn.thinking ? 'high' : 'low', summary: 'auto' },
    ...(turn.webSearch && turn.model.webSearch ? { tools: [{ type: 'web_search' }] } : {})
  })
}

// Server-sent events from a fetch body, as parsed `data:` payloads.
async function* sseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data) as Record<string, unknown>
      } catch {
        // not JSON; skip
      }
    }
  }
}
