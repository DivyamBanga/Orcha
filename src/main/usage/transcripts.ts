import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageEvent } from '../../shared/ai'
import { specFor, type ModelSpec } from '../../shared/models'
import { CHUNK_BYTES, MAX_LINE_BYTES, readLines } from './lineReader'

// Turns the transcripts Claude Code and Codex keep on disk into usage events,
// reading only what was appended since the last look. Everything here is plain
// Node (no Electron, no database) so it can run in a worker thread: the old
// scanner parsed whole files on the main thread and froze the app for over a
// minute on a 2 GB ~/.claude/projects.
//
// What it does not do is price anything: events carry token counts and the id
// of the model spec they belong to, and the ledger works out the dollars.

export interface ScanDirs {
  claude: string | null // ~/.claude/projects
  codex: string | null // ~/.codex/sessions
}

export function defaultDirs(): ScanDirs {
  return {
    claude: join(homedir(), '.claude', 'projects'),
    codex: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  }
}

// Codex writes its model and folder on early lines and token totals on later
// ones, so a scan that resumes mid-file needs to remember them.
export interface CodexState {
  sessionId: string | null
  cwd: string | null
  provider: string
  model: string | null
  total: number // the running token total at the last event handled
}

// Where a scan got to in one file. Small and JSON-safe, so the caller can keep
// it between runs and the next start doesn't re-read the whole corpus.
export interface FileState {
  size: number // how far into the file we looked: equal to its size means nothing new
  offset: number // where the first unhandled line starts (short of size after a half-written line)
  codex?: CodexState
}

export interface ScanState {
  files: Map<string, FileState>
  // Calls already handed out, by key, with how complete that version was. Memory
  // only: it is what lets a copied or still-growing message be spotted.
  seen: Map<string, number>
}

export function newScanState(files: Record<string, FileState> = {}): ScanState {
  return { files: new Map(Object.entries(files)), seen: new Map() }
}

// A UsageEvent that has not been priced, plus what the ledger needs to keep
// one row per call however many times it is seen.
export interface ScannedEvent extends UsageEvent {
  // One model call's identity ("message id:request id"; "codex:session:running
  // total"). A key can come again, with more output, as a message finishes
  // streaming or when a resumed session copies it: the row with the most
  // output wins, and the original timestamp, folder and session are kept.
  key: string
  // The folder the agent ran in; mapCwdToProject() turns it into a project.
  cwd: string | null
  // Anthropic fast mode costs double; null where the source doesn't say.
  speed: 'standard' | 'fast' | null
}

export interface ScanLimits {
  // Stop once this many events are ready (`more` then says to call again), so
  // a first scan of a huge corpus reaches the main thread in small batches.
  maxEvents?: number
  // Ignore files last written, and events made, before this time (ms epoch).
  since?: number | null
  chunkBytes?: number
  maxLineBytes?: number
}

export interface ScanResult {
  events: ScannedEvent[]
  files: Record<string, FileState> // files that moved in this call
  removed: string[] // files that are gone
  more: boolean
  bytesRead: number
}

type Json = Record<string, unknown>

const obj = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

// Every Claude Code line that reports usage has this; most lines (tool
// results, which can be megabytes) don't, and are never decoded.
const USAGE_NEEDLE = Buffer.from('"usage"')

// A request whose prompt is longer than the model's long-context threshold is
// priced at the long rates (Haiku 5.5 over 100K, GPT over 272K).
function isLongContext(spec: ModelSpec | null, promptTokens: number): boolean {
  const above = spec?.price.long?.above
  return above !== undefined && promptTokens > above
}

// ---- Claude Code ----------------------------------------------------------

// One billed hop of a call, at its own model. Almost always there is one; when
// Anthropic reports `usage.iterations` (a refusal fallback, an advisor model,
// server-side compaction) the top-level numbers leave some hops out, so each
// iteration is priced at its own model, as the relay does.
interface Hop {
  model: string
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
}

interface Call {
  key: string
  at: number
  cwd: string | null
  sessionId: string | null
  hops: Hop[]
  reasoning: number
  webSearches: number
  speed: 'standard' | 'fast' | null
  // How complete this version is: a message is written once per content block
  // and the early lines carry placeholder counts (output_tokens of 8 against a
  // final 506), so the version with the most output is the real one.
  rank: number
}

function hopOf(block: Json, model: string): Hop {
  const split = obj(block.cache_creation)
  const write5m = count(split?.ephemeral_5m_input_tokens)
  const write1h = count(split?.ephemeral_1h_input_tokens)
  // The lifetime split is the truth (on Fable the plain total can read 0 while
  // the split holds the tokens). Writes it doesn't account for are the
  // default 5-minute kind, which is also all an older line without a split has.
  const unsplit = Math.max(0, count(block.cache_creation_input_tokens) - write5m - write1h)
  return {
    model,
    input: count(block.input_tokens),
    cacheRead: count(block.cache_read_input_tokens),
    cacheWrite5m: write5m + unsplit,
    cacheWrite1h: write1h,
    output: count(block.output_tokens)
  }
}

function readClaudeLine(line: string): Call | null {
  let entry: Json | null
  try {
    entry = obj(JSON.parse(line))
  } catch {
    return null
  }
  const message = obj(entry?.message)
  const usage = obj(message?.usage)
  const id = str(message?.id)
  const model = str(message?.model)
  const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  // '<synthetic>' is Claude Code's own placeholder reply (an error, "no
  // response"), never sent to a model.
  if (!entry || entry.type !== 'assistant' || !usage || !id || !model || model.startsWith('<')) {
    return null
  }
  if (Number.isNaN(at)) return null

  const iterations = Array.isArray(usage.iterations) ? usage.iterations : []
  const blocks = iterations.map(obj).filter((b): b is Json => b !== null)
  const hops =
    blocks.length > 0 ? blocks.map((b) => hopOf(b, str(b.model) ?? model)) : [hopOf(usage, model)]
  if (hops.every((h) => h.input + h.cacheRead + h.cacheWrite5m + h.cacheWrite1h + h.output === 0)) {
    return null
  }
  const speed = usage.speed === 'fast' || usage.speed === 'standard' ? usage.speed : null
  return {
    key: `${id}:${str(entry.requestId) ?? ''}`,
    at,
    cwd: str(entry.cwd),
    sessionId: str(entry.sessionId),
    hops,
    reasoning: count(obj(usage.output_tokens_details)?.thinking_tokens),
    webSearches: count(obj(usage.server_tool_use)?.web_search_requests),
    speed,
    rank: hops.reduce((sum, h) => sum + h.output, 0) * 16 + Math.min(hops.length, 15)
  }
}

function claudeEvents(call: Call): ScannedEvent[] {
  return call.hops.map((hop, i) => {
    const spec = specFor(hop.model)
    const prompt = hop.input + hop.cacheRead + hop.cacheWrite5m + hop.cacheWrite1h
    return {
      key: i === 0 ? call.key : `${call.key}#${i}`,
      cwd: call.cwd,
      speed: call.speed,
      at: call.at,
      // Claude Code runs on the Max plan unless a tab was given an API key, and
      // the transcript doesn't say which (it has no key-source field at all):
      // whoever knows a folder runs on a key marks those rows 'api' / 'billed'.
      route: 'plan',
      keyId: null,
      model: hop.model,
      spec: spec?.id ?? null,
      surface: 'claude-code',
      projectId: null,
      chatId: null,
      sessionId: call.sessionId,
      input: hop.input,
      cacheRead: hop.cacheRead,
      cacheWrite5m: hop.cacheWrite5m,
      cacheWrite1h: hop.cacheWrite1h,
      cacheWrite: 0,
      output: hop.output,
      // Thinking and searches are reported once for the call, not per hop.
      reasoning: i === 0 ? Math.min(call.reasoning, hop.output) : 0,
      webSearches: i === 0 ? call.webSearches : 0,
      images: 0,
      audioSeconds: 0,
      longContext: isLongContext(spec, prompt),
      costUsd: null,
      costKind: 'plan',
      priceId: null,
      durationMs: null,
      ttftMs: null,
      incognito: false
    }
  })
}

// ---- Codex ----------------------------------------------------------------

function newCodexState(): CodexState {
  return { sessionId: null, cwd: null, provider: 'openai', model: null, total: 0 }
}

// rollout-2026-02-07T00-30-50-<session id>.jsonl
function sessionFromFileName(path: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)
  return match ? match[1] : null
}

function codexEvent(
  entry: Json,
  payload: Json,
  ctx: CodexState,
  path: string
): ScannedEvent | null {
  const info = obj(payload.info) // null on a session's first event, which only carries rate limits
  const last = obj(info?.last_token_usage)
  const total = count(obj(info?.total_token_usage)?.total_tokens)
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  // Codex repeats a token_count while nothing new was used (444 of 900 on one
  // machine); the running total only moves when a call really finished.
  if (!last || total === 0 || total === ctx.total || Number.isNaN(at)) return null
  ctx.total = total

  const promptAll = count(last.input_tokens) // includes the cached part
  const cached = Math.min(count(last.cached_input_tokens), promptAll)
  const output = count(last.output_tokens)
  if (promptAll + output === 0) return null
  const sessionId = ctx.sessionId ?? sessionFromFileName(path)
  const model = ctx.model ?? 'unknown'
  const spec = specFor(model)
  // Orcha's own Codex tabs run on the Azure key (provider 'orcha'). Codex
  // signed in with the owner's own ChatGPT/OpenAI account (provider 'openai',
  // Codex's default, and every rollout from before Orcha) is plan usage, so it
  // never counts as Azure spend.
  const ownAccount = ctx.provider === 'openai'
  return {
    key: `codex:${sessionId ?? 'unknown'}:${total}`,
    cwd: ctx.cwd,
    speed: null,
    at,
    route: ownAccount ? 'plan' : 'azure',
    keyId: null,
    model,
    spec: spec?.id ?? null,
    surface: 'codex',
    projectId: null,
    chatId: null,
    sessionId,
    input: promptAll - cached,
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    output,
    reasoning: Math.min(count(last.reasoning_output_tokens), output),
    webSearches: 0,
    images: 0,
    audioSeconds: 0,
    longContext: isLongContext(spec, promptAll),
    costUsd: null,
    costKind: ownAccount ? 'plan' : 'billed',
    priceId: null,
    durationMs: null,
    ttftMs: null,
    incognito: false
  }
}

function readCodexLine(line: string, ctx: CodexState, path: string): ScannedEvent | null {
  if (!/"(token_count|turn_context|session_meta)"/.test(line)) return null
  let entry: Json | null
  try {
    entry = obj(JSON.parse(line))
  } catch {
    return null
  }
  const payload = obj(entry?.payload)
  if (!entry || !payload) return null
  if (entry.type === 'session_meta') {
    ctx.sessionId = str(payload.id) ?? ctx.sessionId
    ctx.cwd = str(payload.cwd) ?? ctx.cwd
    ctx.provider = str(payload.model_provider) ?? ctx.provider
  } else if (entry.type === 'turn_context') {
    ctx.model = str(payload.model) ?? ctx.model
    ctx.cwd = str(payload.cwd) ?? ctx.cwd
  } else if (entry.type === 'event_msg' && payload.type === 'token_count') {
    return codexEvent(entry, payload, ctx, path)
  }
  return null
}

// ---- walking and scanning -------------------------------------------------

interface Found {
  path: string
  size: number
  mtimeMs: number
  kind: 'claude' | 'codex'
}

// Every wanted file under `root`, however deep: Claude Code keeps subagent
// transcripts in <session>/subagents/ and workflow agents a level below that.
// `complete` is false when part of the tree couldn't be listed, so a file
// that merely wasn't seen isn't taken for a deleted one.
function listFiles(
  root: string | null,
  kind: Found['kind'],
  wanted: (name: string) => boolean
): { files: Found[]; complete: boolean } {
  const files: Found[] = []
  let complete = true
  const folders = root ? [root] : []
  for (let dir = folders.pop(); dir !== undefined; dir = folders.pop()) {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      // A missing root only means that tool isn't installed here.
      if (!(dir === root && (err as NodeJS.ErrnoException).code === 'ENOENT')) complete = false
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        folders.push(path)
      } else if (entry.isFile() && wanted(entry.name)) {
        try {
          const { size, mtimeMs } = statSync(path)
          files.push({ path, size, mtimeMs, kind })
        } catch {
          complete = false
        }
      }
    }
  }
  return { files, complete }
}

const isTranscript = (name: string): boolean => name.endsWith('.jsonl')
const isRollout = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl')

// One pass over both folders: reads whatever is new since `state` was last
// updated (which this call advances), and returns the events found. Files are
// visited oldest first, so a message copied into a resumed session is credited
// to the session it began in.
export function scanOnce(dirs: ScanDirs, state: ScanState, limits: ScanLimits = {}): ScanResult {
  const maxEvents = Math.max(1, limits.maxEvents ?? Infinity)
  const since = limits.since ?? null
  const readLimits = {
    chunkBytes: limits.chunkBytes ?? CHUNK_BYTES,
    maxLineBytes: limits.maxLineBytes ?? MAX_LINE_BYTES
  }

  const claude = listFiles(dirs.claude, 'claude', isTranscript)
  const codex = listFiles(dirs.codex, 'codex', isRollout)
  const found = [...claude.files, ...codex.files].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1)
  )

  const events: ScannedEvent[] = []
  // Claude messages touched in this call. Their lines are merged here and each
  // message leaves once, with its most complete usage, instead of once per line.
  const pending = new Map<string, Call>()
  const changed: Record<string, FileState> = {}
  let bytesRead = 0
  const spent = (): boolean => events.length + pending.size >= maxEvents

  const offer = (call: Call): void => {
    const held = pending.get(call.key)
    if (call.rank <= (held?.rank ?? state.seen.get(call.key) ?? -1)) return
    // The first sighting's time, folder and session stand for the message.
    pending.set(
      call.key,
      held ? { ...call, at: held.at, cwd: held.cwd, sessionId: held.sessionId } : call
    )
  }

  for (const file of found) {
    if (since !== null && file.mtimeMs < since) continue
    if (spent()) break
    const prev = state.files.get(file.path)
    if (prev && file.size === prev.size) continue
    // A file that got smaller was replaced: start it over.
    const start = prev && file.size >= prev.size ? prev.offset : 0
    const ctx =
      file.kind === 'codex'
        ? start > 0 && prev?.codex
          ? { ...prev.codex }
          : newCodexState()
        : undefined

    const onLine = (line: string): boolean => {
      if (ctx) {
        const event = readCodexLine(line, ctx, file.path)
        if (event && (since === null || event.at >= since)) events.push(event)
      } else {
        const call = readClaudeLine(line)
        if (call && (since === null || call.at >= since)) offer(call)
      }
      return spent()
    }
    try {
      const needle = ctx ? null : USAGE_NEEDLE
      const read = readLines(file.path, start, needle, onLine, readLimits)
      bytesRead += read.bytesRead
      const next: FileState = {
        size: read.size,
        offset: read.offset,
        ...(ctx ? { codex: ctx } : {})
      }
      state.files.set(file.path, next)
      changed[file.path] = next
    } catch {
      // Locked or deleted while we looked: try again on the next scan.
    }
  }
  const more = spent()

  for (const call of pending.values()) {
    state.seen.set(call.key, call.rank)
    events.push(...claudeEvents(call))
  }

  const removed: string[] = []
  if (claude.complete && codex.complete) {
    const present = new Set(found.map((f) => f.path))
    for (const path of [...state.files.keys()]) {
      if (present.has(path)) continue
      state.files.delete(path)
      removed.push(path)
    }
  }
  return { events, files: changed, removed, more, bytesRead }
}

// Scans until nothing is left, handing each batch over as it fills. A batch
// with no events and no deleted files is not worth a message: the positions it
// would carry only skip lines that held no usage, which a restart re-skips
// for free.
export function scanAll(
  dirs: ScanDirs,
  state: ScanState,
  limits: ScanLimits,
  onBatch: (batch: ScanResult) => void
): void {
  for (;;) {
    const result = scanOnce(dirs, state, limits)
    if (result.events.length > 0 || result.removed.length > 0) onBatch(result)
    if (!result.more) return
  }
}

// ---- projects ---------------------------------------------------------------

export interface ProjectRef {
  id: string
  name: string
  repoPath: string
  chatOnly?: boolean
  sshHost?: string | null
}

// Case and slashes don't matter for a path on Windows, and an agent's folder
// is written either way round.
const normal = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()

// The Orcha project a folder belongs to: the repo itself or anything inside it
// (including Claude Code's own .claude/worktrees), or one of Orcha's session
// worktrees at ~/.orcha/worktrees/<project name>/<session>. Null when the
// folder is elsewhere, or when two projects share the name a worktree is
// filed under and there is no telling which one it is.
export function mapCwdToProject(
  cwd: string | null,
  projects: ProjectRef[],
  worktreeRoot: string = join(homedir(), '.orcha', 'worktrees')
): string | null {
  if (!cwd) return null
  const here = normal(cwd)
  const local = projects.filter((p) => !p.chatOnly && !p.sshHost)

  let best: ProjectRef | null = null
  let bestLength = 0
  for (const project of local) {
    const root = normal(project.repoPath)
    if (root === '') continue
    if ((here === root || here.startsWith(`${root}/`)) && root.length > bestLength) {
      best = project
      bestLength = root.length
    }
  }
  if (best) return best.id

  const base = `${normal(worktreeRoot)}/`
  if (!here.startsWith(base)) return null
  const name = here.slice(base.length).split('/')[0]
  const named = local.filter((p) => normal(p.name) === name)
  return named.length === 1 ? named[0].id : null
}
