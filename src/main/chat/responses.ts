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

// GPT models on Azure through the relay (guests' chats, and the host's own),
// over the Responses API. Nothing is stored server-side (store: false): every
// turn sends the conversation, the same way the Claude adapter does.

export function responsesAdapter(
  relay: { relay: string; token: string },
  headers: Record<string, string>,
  load: FileLoader
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
    async run(turn, emit, signal, runTool) {
      let text = ''
      let thinking = ''
      let thinkingStarted = 0
      let thinkingMs = 0
      let usage: TurnResult['usage'] = null
      let failure: string | null = null
      // Cited pages, and where each citation ends: annotation indexes count
      // from the start of their own message, so each message's start in the
      // whole text is noted as it begins.
      const sources: ChatSource[] = []
      const cites: { at: number; n: number }[] = []
      const starts = new Map<string, number>()
      const partial = (): TurnResult => ({
        text,
        parts: {
          ...(thinking ? { thinking: { text: thinking, ms: thinkingMs } } : {}),
          ...(sources.length ? { sources } : {})
        },
        usage,
        model: null
      })
      const request = requestObject(turn, load)
      let input = request.input
      try {
        // One model call per round; when it calls a tool, what it output and
        // the tool's answers go back and it goes again.
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await post(
            JSON.stringify({ ...request, input }),
            signal,
            mediaHeader(turn.history)
          )
          if (!response.ok || !response.body) {
            throw new Error(
              ((await response.text()) || `The relay answered ${response.status}.`).replace(
                /^Orcha( relay)?: /,
                ''
              )
            )
          }
          const items: Record<string, unknown>[] = []
          let opened = round === 0
          for await (const event of sseEvents(response.body)) {
            const type = event.type as string
            if (type === 'response.output_text.delta') {
              if (thinkingStarted && !thinkingMs) thinkingMs = Date.now() - thinkingStarted
              let delta = String(event.delta ?? '')
              // A later round's words start a new paragraph after the last ones.
              const lead = !opened && text.trim() ? '\n\n' : ''
              if (lead) delta = lead + delta.trimStart()
              opened = true
              const item = String(event.item_id ?? '')
              if (!starts.has(item)) starts.set(item, text.length + lead.length)
              text += delta
              emit({ kind: 'text', delta })
            } else if (type === 'response.reasoning_summary_text.delta') {
              if (!thinkingStarted) thinkingStarted = Date.now()
              const delta = String(event.delta ?? '')
              thinking += delta
              emit({ kind: 'thinking', delta })
            } else if (type === 'response.web_search_call.in_progress') {
              emit({ kind: 'tool', tool: { kind: 'search', label: 'Searching the web' } })
            } else if (type === 'response.output_text.annotation.added') {
              const a = event.annotation as
                { type?: string; url?: string; title?: string; end_index?: number } | undefined
              if (a?.type === 'url_citation' && a.url) {
                let n = sources.findIndex((s) => s.url === a.url)
                if (n < 0) n = sources.push({ url: a.url, title: a.title || a.url }) - 1
                const start = starts.get(String(event.item_id ?? '')) ?? 0
                cites.push({ at: start + (a.end_index ?? 0), n })
              }
            } else if (type === 'response.output_item.done') {
              const item = event.item as Record<string, unknown> | undefined
              if (item) items.push(item)
            } else if (type === 'response.completed' || type === 'response.incomplete') {
              const u = (event.response as { usage?: ResponsesUsage } | undefined)?.usage
              if (u) {
                const cached = u.input_tokens_details?.cached_tokens ?? 0
                usage = addUsage(usage, {
                  input: (u.input_tokens ?? 0) - cached,
                  output: u.output_tokens ?? 0,
                  cacheRead: cached,
                  cacheWrite: 0
                })
              }
            } else if (type === 'response.failed' || type === 'error') {
              const r = event.response as { error?: { message?: string } } | undefined
              failure =
                r?.error?.message ?? String(event.message ?? 'The model stopped with an error.')
            }
          }
          const calls = items.filter((i) => i.type === 'function_call')
          if (failure || calls.length === 0 || !runTool) break
          // Its reasoning, words and calls (not the hosted search's own
          // records), then each call's answer.
          input = [
            ...input,
            ...items.filter((i) => i.type !== 'web_search_call'),
            ...calls.map((c) => {
              let args: unknown = {}
              try {
                args = JSON.parse(String(c.arguments ?? '{}'))
              } catch {
                // the model's arguments weren't JSON; the tool says so
              }
              return {
                type: 'function_call_output',
                call_id: c.call_id,
                output: runTool({ name: String(c.name), input: args })
              }
            })
          ]
        }
      } catch (err) {
        if (signal.aborted) throw new TurnAborted(partial())
        throw err instanceof Error ? err : new Error(String(err))
      }
      if (failure) throw new Error(failure)
      // The chips go in once the whole text is known (the saved reply has
      // them; the live one catches up when it finishes).
      const at = [...new Set(cites.map((c) => Math.min(c.at, text.length)))].sort((a, b) => b - a)
      for (const pos of at) {
        const ns = [
          ...new Set(cites.filter((c) => Math.min(c.at, text.length) === pos).map((c) => c.n))
        ]
        text = text.slice(0, pos) + citeMarks(ns, sources) + text.slice(pos)
      }
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

// Your message as Responses content: its files first (images and PDFs as
// data URLs, text inline), then what you wrote.
function userContent(m: HistoryMessage, load: FileLoader): Record<string, string>[] {
  const files = m.files.map((f): Record<string, string> => {
    const data = load(f)
    if ('text' in data) return { type: 'input_text', text: fileText(f.name, data.text) }
    return f.kind === 'image'
      ? { type: 'input_image', image_url: `data:${f.mime};base64,${data.base64}` }
      : {
          type: 'input_file',
          filename: f.name,
          file_data: `data:application/pdf;base64,${data.base64}`
        }
  })
  return m.text.trim() ? [...files, { type: 'input_text', text: m.text }] : files
}

// The request as an object, "model" first: the relay reads the model from the
// first bytes instead of parsing a body that can carry megabytes of images,
// and spreading this keeps that order.
export function requestObject(
  turn: TurnInput,
  load: FileLoader
): { model: string; input: unknown[] } & Record<string, unknown> {
  const input: unknown[] = [
    { role: 'developer', content: turn.system },
    ...turn.history
      .filter((m) => m.text.trim() || m.files.length > 0)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', content: userContent(m, load) }
          : { role: 'assistant', content: [{ type: 'output_text', text: m.text }] }
      )
  ]
  const tools = [
    ...(turn.webSearch && turn.model.webSearch ? [{ type: 'web_search' }] : []),
    ...(turn.tools ?? []).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.schema
    }))
  ]
  return {
    model: turn.model.id,
    stream: true,
    store: false,
    input,
    reasoning: { effort: turn.thinking ? 'high' : 'low', summary: 'auto' },
    ...(tools.length ? { tools } : {}),
    // Nothing is stored server-side, so a turn that calls a tool carries its
    // own reasoning (encrypted) into the next call.
    ...(turn.tools?.length ? { include: ['reasoning.encrypted_content'] } : {})
  }
}

export function requestBody(turn: TurnInput, load: FileLoader): string {
  return JSON.stringify(requestObject(turn, load))
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
