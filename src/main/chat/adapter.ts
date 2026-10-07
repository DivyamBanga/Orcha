import type { CatalogModel, ChatFile, ChatParts } from '../../shared/types'

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
}

export type StreamEvent =
  | { kind: 'text' | 'thinking'; delta: string }
  | { kind: 'tool'; tool: 'search' | 'memory'; label: string }

export interface TurnResult {
  text: string
  parts: ChatParts
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  model: string | null // what actually answered (a refusal fallback can differ)
}

export interface ChatAdapter {
  run(turn: TurnInput, emit: (event: StreamEvent) => void, signal: AbortSignal): Promise<TurnResult>
  complete(model: string, system: string, prompt: string): Promise<string>
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
