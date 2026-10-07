import type { CatalogModel, ChatFile, ChatParts, ChatSource, ChatTool } from '../../shared/types'

// What every chat provider (Claude through the relay, Azure through the
// relay, and later Claude on the host's own plan) implements: run one turn,
// streaming as it goes, and answer a one-off prompt (chat titles).

export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
  files: ChatFile[]
}

export interface TurnInput {
  model: CatalogModel
  // Frozen when the chat started (see prompt.ts).
  system: string
  // Root to the new user message. Finished replies are replayed as their
  // visible text only, which keeps every request's prefix identical to the
  // last one: the prompt cache stays warm, and no reasoning from an earlier
  // turn is ever replayed (the newest models reject edited reasoning).
  history: HistoryMessage[]
  thinking: boolean
  webSearch: boolean
  // Tools Orcha runs itself (the memory tool), as JSON Schema; each adapter
  // offers them in its provider's shape and loops until the model is done.
  tools?: ClientTool[]
}

export interface ClientTool {
  name: string
  description: string
  schema: Record<string, unknown>
}

// Runs one call to a client tool and says how it went, for the model.
export type ToolRunner = (call: { name: string; input: unknown }) => string

// The most model calls one turn makes (each tool use is another call).
export const MAX_ROUNDS = 6

export type StreamEvent =
  { kind: 'text' | 'thinking'; delta: string } | { kind: 'tool'; tool: ChatTool }

export interface TurnResult {
  text: string
  parts: ChatParts
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  model: string | null // what actually answered (a refusal fallback can differ)
}

export interface ChatAdapter {
  run(
    turn: TurnInput,
    emit: (event: StreamEvent) => void,
    signal: AbortSignal,
    runTool?: ToolRunner
  ): Promise<TurnResult>
  complete(model: string, system: string, prompt: string): Promise<string>
}

// Usage across a turn's model calls, summed.
export function addUsage(
  total: TurnResult['usage'],
  next: NonNullable<TurnResult['usage']>
): NonNullable<TurnResult['usage']> {
  if (!total) return next
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite
  }
}

// Citation chips after a claim: " [1][3]", each a Markdown link to its source
// titled "cite" (which the chat draws as a chip, and Copy leaves out).
export function citeMarks(numbers: number[], sources: ChatSource[]): string {
  return (
    ' ' +
    numbers
      .filter((n) => sources[n])
      .map((n) => `[${n + 1}](<${sources[n].url.replace(/[<>\s]/g, encodeURIComponent)}> "cite")`)
      .join('')
  )
}

// How a file is read for sending (attachments.ts in the app, a stub in tests).
export type FileLoader = (file: ChatFile) => { base64: string } | { text: string }

// A text file (or the text of an Office file), inline in the message.
export function fileText(name: string, text: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${text}\n</file>`
}

// Tells the relay how many images and PDFs a request carries and their size
// in base64, so an interrupted reply's input isn't estimated as if all that
// were text. Empty when there are none.
export function mediaHeader(history: HistoryMessage[]): Record<string, string> {
  const media = history.flatMap((m) => m.files).filter((f) => f.kind !== 'text')
  if (media.length === 0) return {}
  const bytes = media.reduce((n, f) => n + Math.ceil(f.bytes / 3) * 4, 0)
  return { 'x-orcha-media': `${media.length},${bytes}` }
}

// An interrupted turn still has whatever streamed before the stop.
export class TurnAborted extends Error {
  constructor(public partial: TurnResult) {
    super('aborted')
  }
}

// What a reply cost, from its usage and the catalog's list prices (the
// relay's own tally is the bill; this is the "≈" shown on the message).
export function estimateCost(model: CatalogModel, usage: TurnResult['usage']): number | null {
  if (!usage) return null
  const r = model.rates
  return (
    (usage.input * r.in +
      usage.cacheWrite * r.in * 1.25 +
      usage.cacheRead * r.cacheRead +
      usage.output * r.out) /
    1_000_000
  )
}
