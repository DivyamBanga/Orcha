import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as db from '../db'
import { pendingAsk, readRecentActivity } from '../claudeSessions'
import { claudeSdkBinary } from '../platform'
import type { NextStep, Project } from '../../shared/types'

// Runs in its own folder so generations never write transcripts into a real
// project's ~/.claude/projects dir — latestSessionFile picks the newest file
// by mtime, so a generator transcript landing there would hijack question
// extraction and per-session usage for that project.
const CWD = join(homedir(), '.orcha', 'nextsteps')

const SYSTEM = `You suggest a developer's next moves on a coding project, based on what their
Claude Code sessions just did. Reply with ONLY a JSON array of 2-3 items:
[{"label": "...", "prompt": "..."}]
- label: at most 6 words, imperative, specific ("Fix the failing WAL test").
- prompt: the full instruction to send to the coding session (1-3 sentences).
- Ground every suggestion in the activity shown — unfinished work, failing
  tests, uncommitted changes, natural follow-ups. Never generic filler like
  "add tests" or "improve docs" unless the activity itself points there.
- If a session is blocked on a question, do NOT suggest answering it (the app
  surfaces that separately); suggest what comes after or in parallel.`

// Suggestions are cheap by design: haiku, one turn, no tools.
export async function generateNextSteps(project: Project): Promise<NextStep[]> {
  mkdirSync(CWD, { recursive: true })
  const sessions = db.workspaces.listActive().filter((w) => w.projectId === project.id)
  const parts: string[] = []
  for (const w of sessions) {
    const lines = readRecentActivity(w.worktreePath, 20)
    if (lines.length === 0) continue
    const ask = pendingAsk(w.worktreePath)
    parts.push(
      [
        `## Session "${w.kind === 'main' ? 'main' : w.name}"`,
        ...lines,
        ask ? `(currently blocked asking: ${ask.question})` : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  if (parts.length === 0) return []

  const prompt = `Project: ${project.name}\n\n${parts.join('\n\n')}\n\nReply with ONLY the JSON array.`

  let text = ''
  const q = query({
    prompt,
    options: {
      cwd: CWD,
      systemPrompt: SYSTEM,
      settingSources: [],
      model: 'haiku',
      maxTurns: 1,
      allowedTools: [],
      executable: 'node',
      pathToClaudeCodeExecutable: claudeSdkBinary()
    }
  })
  for await (const msg of q) {
    // Defensive shapes: only the text blocks of assistant messages matter.
    const m = msg as {
      type?: string
      message?: { content?: { type?: string; text?: string }[] }
      result?: string
    }
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
      }
    } else if (m.type === 'result' && typeof m.result === 'string' && !text) {
      text = m.result
    }
  }
  return parseSteps(text)
}

function parseSteps(text: string): NextStep[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (s): s is { label: string; prompt: string } =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as { label?: unknown }).label === 'string' &&
          typeof (s as { prompt?: unknown }).prompt === 'string'
      )
      .map((s) => ({ label: s.label.trim().slice(0, 60), prompt: s.prompt.trim().slice(0, 1000) }))
      .filter((s) => s.label && s.prompt)
      .slice(0, 3)
  } catch {
    return []
  }
}
