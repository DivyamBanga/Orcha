import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ChatBlock, PendingAsk, SessionUsage } from '../shared/types'

// ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>
export function encodedProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

export function hasSessionHistory(cwd: string): boolean {
  const dir = encodedProjectDir(cwd)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((f) => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

function latestSessionFile(cwd: string): string | null {
  const dir = encodedProjectDir(cwd)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const path = join(dir, f)
      return { path, mtime: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.path ?? null
}

// Published per-million-token rates (input/output/5m-cache-write/cache-read),
// verified 2026-07-26 against platform.claude.com/docs/en/pricing. Cache
// writes are 1.25x input (5-minute TTL) and cache reads 0.1x input.
interface Rates {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

// Sonnet 5 is on an introductory rate that ends 2026-08-31, after which it
// rises to $3/$15. Events are priced by their own timestamp so a trend that
// spans the changeover stays correct on both sides of it.
const SONNET_INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z')

const MODEL_PRICING: Record<string, Rates> = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
}

const SONNET_STANDARD: Rates = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }

function ratesFor(model: string | null, at: number): Rates | undefined {
  if (!model) return undefined
  if (model === 'sonnet' && at >= SONNET_INTRO_ENDS) return SONNET_STANDARD
  return MODEL_PRICING[model]
}

// Shared by sessionUsage() below and usageStats.ts's cross-project aggregator.
export function estimateCostUsd(
  model: string | null,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  },
  at: number = Date.now()
): number | null {
  const rates = ratesFor(model, at)
  if (!rates) return null
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheCreationTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead) /
    1_000_000
  )
}

// Token usage (and an estimated cost) for the workspace's current session,
// parsed from its latest transcript — the same data `/cost` reads inside the
// TUI. Scoped to the current session only, matching `/cost`'s own behavior;
// this does not aggregate across earlier --continue restarts.
export function sessionUsage(cwd: string, model: string | null): SessionUsage | null {
  const file = latestSessionFile(cwd)
  if (!file) return null

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of lines) {
      let entry: { message?: { usage?: Record<string, number> } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const usage = entry.message?.usage
      if (!usage) continue
      inputTokens += usage.input_tokens ?? 0
      outputTokens += usage.output_tokens ?? 0
      cacheReadTokens += usage.cache_read_input_tokens ?? 0
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0
    }
  } catch {
    return null
  }

  const estimatedCostUsd = estimateCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens
  })

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, estimatedCostUsd }
}

// Seconds since the session last wrote to its transcript; null if none.
export function lastActivityAgeSeconds(cwd: string): number | null {
  const file = latestSessionFile(cwd)
  if (!file) return null
  return (Date.now() - statSync(file).mtimeMs) / 1000
}

// The ask Claude is currently blocked on, read from the latest transcript.
// The terminal screen cannot be trusted for copy (ConPTY diffs glue words
// together), but the transcript carries the ask verbatim: an AskUserQuestion
// tool call (question AND its options, so remote surfaces can render real
// buttons), or a trailing question sentence in the last assistant text.
// Scans only the most recent assistant entry — older questions are history.
export function pendingAsk(cwd: string): PendingAsk | null {
  const file = latestSessionFile(cwd)
  if (!file) return null
  try {
    const raw = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of raw.slice(-40).reverse()) {
      let entry: { type?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'assistant') continue
      const content = entry.message?.content
      if (!Array.isArray(content)) return null
      const blocks = content as { type: string; text?: string; name?: string; input?: unknown }[]
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          const input = block.input as
            | {
                questions?: {
                  question?: string
                  options?: { label?: string; description?: string }[]
                }[]
              }
            | undefined
          const first = input?.questions?.[0]
          const q = first?.question
          if (typeof q === 'string' && q.trim()) {
            const options = (first?.options ?? [])
              .filter((o) => typeof o.label === 'string' && o.label.trim())
              .map((o) => ({
                label: o.label!.trim().slice(0, 80),
                description: typeof o.description === 'string' ? o.description.slice(0, 200) : null
              }))
            return { question: q.trim().slice(0, 300), options }
          }
        }
      }
      const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string')
      const lastText = texts[texts.length - 1]?.text?.trim()
      const ask = lastText?.match(/[^.!?\n]{8,240}\?\s*$/)
      return ask ? { question: ask[0].trim(), options: [] } : null
    }
  } catch {
    return null
  }
  return null
}

// Toast-sized version of the ask, kept for the desktop notification body.
export function pendingQuestion(cwd: string): string | null {
  const ask = pendingAsk(cwd)
  return ask ? ask.question.slice(0, 140) : null
}

// The one argument of a tool call worth showing in a digest row.
function interestingArg(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.slice(0, 80)
  }
  return null
}

// The tail of the latest transcript as readable chat blocks for the phone:
// user/assistant text in full (capped), consecutive tool calls collapsed into
// one 'tools' block. Tool results are skipped — this is a report, not a log.
export function readChatDigest(cwd: string, limit: number): ChatBlock[] {
  const file = latestSessionFile(cwd)
  if (!file) return []
  const blocks: ChatBlock[] = []
  const push = (block: ChatBlock): void => {
    blocks.push(block)
  }
  try {
    const raw = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of raw.slice(-600)) {
      let entry: { type?: string; timestamp?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      const at = entry.timestamp ? Date.parse(entry.timestamp) || null : null
      const content = entry.message?.content
      if (entry.type === 'user' && typeof content === 'string' && content.trim()) {
        push({ kind: 'user', text: content.slice(0, 6000), tools: null, at })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content as {
        type: string
        text?: string
        name?: string
        input?: Record<string, unknown>
      }[]) {
        if (block.type === 'text' && block.text?.trim()) {
          push({
            kind: entry.type as 'user' | 'assistant',
            text: block.text.slice(0, 6000),
            tools: null,
            at
          })
        } else if (entry.type === 'assistant' && block.type === 'tool_use' && block.name) {
          const tool = { name: block.name, arg: interestingArg(block.input) }
          const prev = blocks[blocks.length - 1]
          if (prev?.kind === 'tools' && prev.tools) {
            prev.tools.push(tool)
            prev.at = at ?? prev.at
          } else {
            push({ kind: 'tools', text: null, tools: [tool], at })
          }
        }
      }
    }
  } catch {
    return blocks.slice(-limit)
  }
  return blocks.slice(-limit)
}

// One-line summaries of the tail of the latest session transcript.
export function readRecentActivity(cwd: string, limit: number): string[] {
  const file = latestSessionFile(cwd)
  if (!file) return []
  const lines: string[] = []
  try {
    const raw = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of raw.slice(-200)) {
      let entry: {
        type?: string
        message?: { content?: unknown }
      }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const content = entry.message?.content
      if (entry.type === 'user' && typeof content === 'string' && content.trim()) {
        lines.push(`User: ${content.slice(0, 120)}`)
      } else if (Array.isArray(content)) {
        for (const block of content as {
          type: string
          text?: string
          name?: string
          input?: Record<string, unknown>
        }[]) {
          if (entry.type === 'user' && block.type === 'text' && block.text?.trim()) {
            lines.push(`User: ${block.text.slice(0, 120)}`)
          } else if (entry.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
            lines.push(`Claude: ${block.text.slice(0, 120)}`)
          } else if (entry.type === 'assistant' && block.type === 'tool_use') {
            const arg =
              typeof block.input?.file_path === 'string'
                ? ` ${block.input.file_path}`
                : typeof block.input?.command === 'string'
                  ? ` ${String(block.input.command).slice(0, 60)}`
                  : ''
            lines.push(`Tool: ${block.name}${arg}`)
          }
        }
      }
    }
  } catch {
    return lines
  }
  return lines.slice(-limit)
}
