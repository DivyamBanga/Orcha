import type { ChatModel, TurnSettings } from '../../shared/ai'
import type { ChatFile, ChatParts, ChatTool } from '../../shared/types'

// What every chat provider implements — Claude on the Max plan (Claude Code),
// Claude on an API key, GPT on Azure, and local models through Ollama: run
// one turn, streaming as it goes, and answer a one-off prompt (titles, chores).
//
// A conversation is replayed as its visible text only. Earlier turns' hidden
// reasoning, tool calls and search records never go back to a model, which
// is what lets any model continue any chat, keeps every request's prefix
// stable for prompt caching, and keeps branches and edits clear of
// Anthropic's preserved-thinking check.

export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
  files: ChatFile[]
}

// A tool Orcha runs itself (memory, past-chat search, MCP tools...), as JSON
// Schema; each provider offers it in its own shape and loops until done.
export interface ClientTool {
  name: string
  description: string
  schema: Record<string, unknown>
  // Changes something (a write, a send, running code): the runner asks first.
  mutating?: boolean
}

export type ToolRunner = (call: { name: string; input: unknown }) => Promise<string>

export interface ProviderTurn {
  model: ChatModel
  // Frozen when the chat started (see prompt.ts).
  system: string
  // Root to the new user message.
  history: HistoryMessage[]
  settings: TurnSettings
  tools: ClientTool[]
  // Claude on the Max plan keeps a chat as a Claude Code session: the one
  // this turn continues, and where (null when this turn starts it).
  session?: { id: string; at: string | null }
  // Incognito: providers keep nothing (Azure store:false, no Files API).
  incognito?: boolean
}

export type StreamEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool'; tool: ChatTool }
  // Waiting with nothing streaming yet: a local model loading into memory or
  // reading a long prompt (with an estimate), a cloud model queued.
  | { kind: 'status'; status: 'loading' | 'reading' | 'queued'; etaMs?: number }

// Token counts with exclusive buckets: input excludes cache reads and
// writes; reasoning is the part of output spent thinking.
export interface TokenUsage {
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheWrite: number
  output: number
  reasoning: number
  webSearches: number
  longContext: boolean
}

export const NO_USAGE: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  webSearches: 0,
  longContext: false
}

export function addTokens(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    webSearches: a.webSearches + b.webSearches,
    longContext: a.longContext || b.longContext
  }
}

export type StopReason = 'end' | 'max-tokens' | 'refusal' | 'context-full'

export interface TurnResult {
  text: string
  parts: ChatParts
  usage: TokenUsage | null
  model: string | null // what actually answered (a refusal fallback can differ)
  stop: StopReason
  ttftMs: number | null // time to the first streamed token
  // Max plan: the session the reply went in, and where it got to.
  session?: { id: string; at: string | null }
}

// Why a turn failed, so the chat can react: offer another key ('no-credit',
// 'rate-limit', 'auth'), wait ('overloaded'), or explain ('refused').
export type ProviderErrorCode =
  | 'auth'
  | 'no-credit'
  | 'rate-limit'
  | 'overloaded'
  | 'context-full'
  | 'refused'
  | 'not-found'
  | 'bad-request'
  | 'unreachable'
  | 'unknown'

export class ProviderError extends Error {
  constructor(
    message: string, // plain words, shown to the person
    public code: ProviderErrorCode,
    public retryAfterMs: number | null = null,
    public status: number | null = null
  ) {
    super(message)
  }
}

// An interrupted turn still has whatever streamed before the stop.
export class TurnStopped extends Error {
  constructor(public partial: TurnResult) {
    super('stopped')
  }
}

export interface Provider {
  run(
    turn: ProviderTurn,
    emit: (event: StreamEvent) => void,
    signal: AbortSignal,
    runTool?: ToolRunner
  ): Promise<TurnResult>
  // A short non-streamed answer (titles, summaries, memory chores).
  complete(
    model: ChatModel,
    system: string,
    prompt: string,
    opts?: { maxOutput?: number; signal?: AbortSignal }
  ): Promise<{ text: string; usage: TokenUsage | null }>
}

// How a file is read for sending (attachments.ts in the app, a stub in tests).
export type FileLoader = (file: ChatFile) => { base64: string } | { text: string }

// A text file (or the text read out of a document), inline in a message. A
// closing tag inside the file can't end the block early.
export function fileText(name: string, text: string): string {
  const safe = text.replace(/<\/file>/gi, '<\\/file>')
  return `<file name="${name.replace(/"/g, "'")}">\n${safe}\n</file>`
}
