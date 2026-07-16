import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { SessionUsage } from '../shared/types'

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
// as of 2026-07-16 (platform.claude.com/docs/en/about-claude/pricing). These
// drift over time (e.g. Sonnet 5's introductory rate below ends 2026-08-31,
// after which it rises to $3/$15) — treat the resulting dollar figure as
// illustrative, not a billing-accurate total.
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
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

  const rates = model ? MODEL_PRICING[model] : undefined
  const estimatedCostUsd = rates
    ? (inputTokens * rates.input +
        outputTokens * rates.output +
        cacheCreationTokens * rates.cacheWrite +
        cacheReadTokens * rates.cacheRead) /
      1_000_000
    : null

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, estimatedCostUsd }
}

// Seconds since the session last wrote to its transcript; null if none.
export function lastActivityAgeSeconds(cwd: string): number | null {
  const file = latestSessionFile(cwd)
  if (!file) return null
  return (Date.now() - statSync(file).mtimeMs) / 1000
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
