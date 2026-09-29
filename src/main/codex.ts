import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { attributionHeaders, relayConfig } from './guest'
import type { Project, Workspace } from '../shared/types'

// Codex tabs (guest mode only): the real `codex` TUI in a terminal, pointed at
// the host's relay by command-line config overrides, so nothing in the guest's
// own ~/.codex/config.toml changes and a ChatGPT login there is never used or
// sent. Behaviour verified against codex-cli 0.158.0.

export const CODEX_MODELS = ['gpt-6-sol', 'gpt-6-astra'] as const
export const DEFAULT_CODEX_MODEL = 'gpt-6-sol'
// Flags and config keys below exist from this version on.
export const MIN_CODEX_VERSION = '0.158.0'

// The env var the relay token rides in; Codex sends it as a Bearer token.
const TOKEN_ENV = 'ORCHA_RELAY_KEY'

// Where the official installer (chatgpt.com/codex/install.ps1) puts it. Used
// by full path because a just-installed Codex isn't on this process's PATH.
export const OFFICIAL_CODEX_EXE = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs',
  'OpenAI',
  'Codex',
  'bin',
  'codex.exe'
)

export function codexExecutable(): string {
  return existsSync(OFFICIAL_CODEX_EXE) ? OFFICIAL_CODEX_EXE : 'codex'
}

// A TOML string for a -c value. Literal (single-quoted) strings need no
// escaping at all, so they're used unless the text itself has a quote.
function toml(value: string): string {
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// One argument for PowerShell's call operator. Single-quoted PowerShell
// strings are fully literal — no $ expansion, no backtick escapes — so the
// TOML inside passes through untouched; only ' itself needs doubling.
function ps(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`
}

// `codex resume --last` continues this folder's most recent Orcha session. It
// only runs when one exists: with nothing to resume, codex 0.158 sits on
// "Resuming session…" forever instead of starting fresh (observed live).
export function codexLaunchCommand(workspace: Workspace, project: Project | undefined): string {
  const relay = relayConfig()
  if (!relay) throw new Error('Codex tabs need Orcha to be paired with an invite first.')
  const headers = Object.entries(attributionHeaders(project?.name ?? workspace.name, workspace.id))
    .map(([k, v]) => `${toml(k)}=${toml(v)}`)
    .join(',')
  const provider = [
    "name='Orcha'",
    `base_url=${toml(`${relay.relay}/openai/v1`)}`,
    `env_key='${TOKEN_ENV}'`,
    "wire_api='responses'",
    // A long reasoning phase can be quiet for minutes before tokens flow.
    'stream_idle_timeout_ms=600000',
    `http_headers={${headers}}`
  ].join(',')
  const args = [
    ...(latestRollout(workspace.worktreePath) ? ['resume', '--last'] : []),
    // Config overrides need codex's embedded mode anyway; asking for it
    // explicitly skips the startup warning about not using its shared server.
    '--no-daemon',
    '-c',
    'model_provider=orcha',
    '-c',
    `model_providers.orcha={${provider}}`,
    '-c',
    'check_for_update_on_startup=false',
    // Pre-answers the "Trust this folder?" screen for this tab's folder only.
    '-c',
    `projects={${toml(workspace.worktreePath)}={trust_level='trusted'}}`,
    '-m',
    workspace.model && (CODEX_MODELS as readonly string[]).includes(workspace.model)
      ? workspace.model
      : DEFAULT_CODEX_MODEL,
    // Full auto, matching how Claude tabs run (--dangerously-skip-permissions).
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    workspace.worktreePath
  ]
  return `& ${ps(codexExecutable())} ${args.map(ps).join(' ')}`
}

export function codexEnv(base: Record<string, string>): Record<string, string> {
  const relay = relayConfig()
  const env = { ...base }
  if (relay) env[TOKEN_ENV] = relay.token
  return env
}

// ---- reading Codex's session logs ----------------------------------------------

// Rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (local
// dates). A resumed session keeps appending to its original file, which can sit
// in an older day's folder, so recent-by-mtime is what counts, not the folder.
function sessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
}

const LOOKBACK_DAYS = 30
const metaCache = new Map<string, { cwd: string; provider: string } | null>()

function rolloutFiles(): { path: string; mtime: number }[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000
  const files: { path: string; mtime: number }[] = []
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  for (const year of list(root)) {
    for (const month of list(join(root, year))) {
      for (const day of list(join(root, year, month))) {
        const dir = join(root, year, month, day)
        for (const f of list(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
          const path = join(dir, f)
          try {
            const mtime = statSync(path).mtimeMs
            if (mtime >= cutoff) files.push({ path, mtime })
          } catch {
            // vanished mid-scan
          }
        }
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

// The session_meta line is always first; it can be long (it may carry the
// base instructions), so read until the first newline rather than a fixed size.
function rolloutMeta(path: string): { cwd: string; provider: string } | null {
  if (metaCache.has(path)) return metaCache.get(path)!
  let meta: { cwd: string; provider: string } | null = null
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const text = buf.subarray(0, n).toString('utf8')
      const first = text.slice(0, text.indexOf('\n') === -1 ? n : text.indexOf('\n'))
      const line = JSON.parse(first) as {
        type?: string
        payload?: { cwd?: string; model_provider?: string }
      }
      if (line.type === 'session_meta' && line.payload?.cwd) {
        meta = { cwd: line.payload.cwd, provider: line.payload.model_provider ?? '' }
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    meta = null
  }
  metaCache.set(path, meta)
  return meta
}

// Latest Orcha Codex rollout for a folder (paths compare case-insensitively
// on Windows, like Codex's own matching).
function latestRollout(cwd: string): { path: string; mtime: number } | null {
  const want = cwd.toLowerCase().replace(/[\\/]+$/, '')
  for (const file of rolloutFiles()) {
    const meta = rolloutMeta(file.path)
    if (
      meta &&
      meta.provider === 'orcha' &&
      meta.cwd.toLowerCase().replace(/[\\/]+$/, '') === want
    ) {
      return file
    }
  }
  return null
}

interface RolloutEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

// User prompts, Codex's replies and its tool calls, oldest first. Handles the
// paginated format (item_completed) and the older user/agent_message events.
function readRollout(cwd: string, maxLines: number): RolloutEntry[] {
  const file = latestRollout(cwd)
  if (!file) return []
  let lines: string[]
  try {
    lines = readFileSync(file.path, 'utf8').trim().split('\n').slice(-maxLines)
  } catch {
    return []
  }
  const entries: RolloutEntry[] = []
  const textOf = (content: unknown): string =>
    Array.isArray(content)
      ? content.map((c: { text?: unknown }) => (typeof c.text === 'string' ? c.text : '')).join('')
      : ''
  for (const line of lines) {
    let entry: { type?: string; payload?: Record<string, unknown> }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const p = entry.payload ?? {}
    if (entry.type === 'event_msg') {
      if (p.type === 'item_completed') {
        const item = p.item as { type?: string; content?: unknown } | undefined
        if (item?.type === 'UserMessage') entries.push({ role: 'user', text: textOf(item.content) })
        else if (item?.type === 'AgentMessage') {
          entries.push({ role: 'assistant', text: textOf(item.content) })
        }
      } else if (p.type === 'user_message' && typeof p.message === 'string') {
        entries.push({ role: 'user', text: p.message })
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        entries.push({ role: 'assistant', text: p.message })
      }
    } else if (entry.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let arg = ''
        try {
          const parsed = JSON.parse(String(p.arguments ?? p.input ?? '')) as {
            command?: unknown
            cmd?: unknown
          }
          const cmd = parsed.command ?? parsed.cmd
          arg = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : ''
        } catch {
          arg = typeof p.input === 'string' ? p.input : ''
        }
        entries.push({ role: 'tool', text: `${String(p.name ?? 'tool')} ${arg}`.trim() })
      }
    }
  }
  return entries.filter((e) => e.text.trim())
}

export function codexActivityAgeSeconds(cwd: string): number | null {
  const file = latestRollout(cwd)
  return file ? (Date.now() - file.mtime) / 1000 : null
}

// One-line summaries for Mission Control, in the same shape as Claude's.
export function codexRecentActivity(cwd: string, limit: number): string[] {
  return readRollout(cwd, 400)
    .map((e) =>
      e.role === 'user'
        ? `User: ${e.text.slice(0, 120)}`
        : e.role === 'assistant'
          ? `Codex: ${e.text.slice(0, 120)}`
          : `Tool: ${e.text.slice(0, 80)}`
    )
    .slice(-limit)
}

// The question Codex ended its last turn on, if its final message asks one.
export function codexPendingQuestion(cwd: string): string | null {
  const last = readRollout(cwd, 200)
    .filter((e) => e.role !== 'tool')
    .pop()
  if (!last || last.role !== 'assistant') return null
  const ask = last.text.trim().match(/[^.!?\n]{8,240}\?\s*$/)
  return ask ? ask[0].trim().slice(0, 140) : null
}
