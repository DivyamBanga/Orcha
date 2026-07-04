import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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
