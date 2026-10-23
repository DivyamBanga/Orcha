import type Database from 'better-sqlite3'
import type { CostKind, Route, UsageEvent } from '../../shared/ai'
import { specFor } from '../../shared/models'
import type { TotalsQuery, UsageGroup, UsageTotals } from '../../shared/usage'
import { costOf, priceAt } from './pricing'
import type { ScannedEvent } from './transcripts'

// The usage ledger: one row for every model call (chat turns, titles, memory
// and other chores, research, Mission Control, Claude Code, Codex, local
// models). It holds numbers and ids only, never prompt or reply text. A row
// is costed once, when it is recorded, with the price that was in force then
// (and remembers which price row that was), so a later price change never
// rewrites what a past call cost.

type Db = Database.Database

export const USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_events (
    id             INTEGER PRIMARY KEY,
    at             INTEGER NOT NULL,
    route          TEXT NOT NULL,
    key_id         TEXT,
    model          TEXT NOT NULL,
    spec           TEXT,
    surface        TEXT NOT NULL,
    project_id     TEXT,
    chat_id        TEXT,
    session_id     TEXT,
    input          INTEGER NOT NULL DEFAULT 0,
    cache_read     INTEGER NOT NULL DEFAULT 0,
    cache_write_5m INTEGER NOT NULL DEFAULT 0,
    cache_write_1h INTEGER NOT NULL DEFAULT 0,
    cache_write    INTEGER NOT NULL DEFAULT 0,
    output         INTEGER NOT NULL DEFAULT 0,
    reasoning      INTEGER NOT NULL DEFAULT 0,
    web_searches   INTEGER NOT NULL DEFAULT 0,
    images         INTEGER NOT NULL DEFAULT 0,
    audio_seconds  REAL NOT NULL DEFAULT 0,
    long_context   INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL,
    cost_kind      TEXT NOT NULL,
    price_id       INTEGER,
    duration_ms    INTEGER,
    ttft_ms        INTEGER,
    incognito      INTEGER NOT NULL DEFAULT 0,
    source_key     TEXT
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage_events (at);
  CREATE INDEX IF NOT EXISTS usage_route_at ON usage_events (route, at);
  CREATE INDEX IF NOT EXISTS usage_chat ON usage_events (chat_id);
  CREATE INDEX IF NOT EXISTS usage_project ON usage_events (project_id);
  CREATE INDEX IF NOT EXISTS usage_session ON usage_events (session_id);
`

// A database made before transcripts were scanned has no source_key column,
// and CREATE TABLE IF NOT EXISTS won't add it. Run after USAGE_SCHEMA.
// Calls recorded live have no key; the index only holds the scanned ones.
export function migrateUsage(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'source_key')) {
    db.exec('ALTER TABLE usage_events ADD COLUMN source_key TEXT')
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS usage_source ON usage_events (source_key)
     WHERE source_key IS NOT NULL`
  )
}

// What a caller knows about a call; the ledger works out the cost, the price
// row and (when left out) the spec. The one exception is costKind 'free', for
// a call that costs nothing (a local model always does).
export type UsageInput = Omit<UsageEvent, 'id' | 'costUsd' | 'costKind' | 'priceId'> & {
  costKind?: CostKind
}

export interface RecordOptions {
  // Anthropic fast mode (the response's usage.speed): twice the token cost.
  fast?: boolean
}

interface Priced {
  spec: string | null
  costUsd: number | null
  costKind: CostKind
  priceId: number | null
}

// Local calls are free. Everything else is costed at the price book's price
// for the moment of the call: a key's or Azure's calls are 'billed', the Max
// plan's are 'plan' (what the same call would cost at list price, never
// money spent), and a call with no price is 'unknown' rather than guessed.
function priceCall(db: Db, call: UsageInput, opts: RecordOptions): Priced {
  // A model's name or deployment may be a dated or aliased form of a spec id.
  const known = call.route === 'ollama' ? null : specFor(call.spec ?? call.model)
  const spec = call.spec ?? known?.id ?? null
  if (call.route === 'ollama' || call.costKind === 'free') {
    return { spec, costUsd: 0, costKind: 'free', priceId: null }
  }
  const price = priceAt(db, spec ?? call.model, call.at)
  if (!price) return { spec, costUsd: null, costKind: 'unknown', priceId: null }
  return {
    spec,
    costUsd: costOf(price.price, call, { fast: opts.fast, family: known?.family }),
    costKind: call.route === 'plan' ? 'plan' : 'billed',
    priceId: price.id
  }
}

const INSERT = `
  INSERT INTO usage_events (
    at, route, key_id, model, spec, surface, project_id, chat_id, session_id,
    input, cache_read, cache_write_5m, cache_write_1h, cache_write, output, reasoning,
    web_searches, images, audio_seconds, long_context, cost_usd, cost_kind, price_id,
    duration_ms, ttft_ms, incognito, source_key
  ) VALUES (
    @at, @route, @keyId, @model, @spec, @surface, @projectId, @chatId, @sessionId,
    @input, @cacheRead, @cacheWrite5m, @cacheWrite1h, @cacheWrite, @output, @reasoning,
    @webSearches, @images, @audioSeconds, @longContext, @costUsd, @costKind, @priceId,
    @durationMs, @ttftMs, @incognito, @sourceKey
  )
`

// Costs a call and adds it to the ledger; returns the row as stored. An
// incognito call is still counted (it still costs money) but nothing in the
// row points back at the chat or project it came from. A session id would
// lead to the project just the same, so that goes too.
export function record(db: Db, call: UsageInput, opts: RecordOptions = {}): UsageEvent {
  return insert(db, call, opts, null)
}

function insert(
  db: Db,
  call: UsageInput,
  opts: RecordOptions,
  sourceKey: string | null
): UsageEvent {
  const priced = priceCall(db, call, opts)
  const event: UsageEvent = {
    ...call,
    ...priced,
    keyId: call.keyId ?? null,
    projectId: call.incognito ? null : (call.projectId ?? null),
    chatId: call.incognito ? null : (call.chatId ?? null),
    sessionId: call.incognito ? null : (call.sessionId ?? null),
    durationMs: call.durationMs ?? null,
    ttftMs: call.ttftMs ?? null
  }
  const result = db.prepare(INSERT).run({
    ...event,
    longContext: Number(event.longContext),
    incognito: Number(event.incognito),
    sourceKey
  })
  return { ...event, id: Number(result.lastInsertRowid) }
}

const REPRICE = `
  UPDATE usage_events SET
    model = @model, spec = @spec, input = @input, cache_read = @cacheRead,
    cache_write_5m = @cacheWrite5m, cache_write_1h = @cacheWrite1h, cache_write = @cacheWrite,
    output = @output, reasoning = @reasoning, web_searches = @webSearches,
    long_context = @longContext, cost_usd = @costUsd, cost_kind = @costKind, price_id = @priceId
  WHERE id = @id
`

// Adds a call read from a transcript, once per call however often it is seen.
// A message is written to a transcript several times as it streams, and a
// resumed session copies whole messages, so the same key comes again: the
// version with the most output is the finished one and replaces the row's
// tokens and cost. The time, project and session stay as first seen, and the
// price is the one in force at that first time.
export function recordScanned(db: Db, scanned: ScannedEvent): void {
  const held = db
    .prepare('SELECT id, at, output FROM usage_events WHERE source_key = ?')
    .get(scanned.key) as { id: number; at: number; output: number } | undefined
  if (!held) {
    insert(db, scanned, { fast: scanned.speed === 'fast' }, scanned.key)
    return
  }
  if (scanned.output <= held.output) return
  const call = { ...scanned, at: held.at }
  const priced = priceCall(db, call, { fast: scanned.speed === 'fast' })
  db.prepare(REPRICE).run({
    ...call,
    ...priced,
    id: held.id,
    longContext: Number(call.longContext)
  })
}

// What one coding session (a transcript's session id) has used and cost, or
// null when the ledger has nothing for it yet.
export function sessionTotals(
  db: Db,
  sessionId: string
): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number | null
} | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
              SUM(cache_write_5m + cache_write_1h + cache_write) AS cache_write,
              SUM(cost_usd) AS cost_usd
       FROM usage_events WHERE session_id = ?`
    )
    .get(sessionId) as {
    n: number
    input: number
    output: number
    cache_read: number
    cache_write: number
    cost_usd: number | null
  }
  if (row.n === 0) return null
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    costUsd: row.cost_usd
  }
}

interface EventRow {
  id: number
  at: number
  route: string
  key_id: string | null
  model: string
  spec: string | null
  surface: string
  project_id: string | null
  chat_id: string | null
  session_id: string | null
  input: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  cache_write: number
  output: number
  reasoning: number
  web_searches: number
  images: number
  audio_seconds: number
  long_context: number
  cost_usd: number | null
  cost_kind: string
  price_id: number | null
  duration_ms: number | null
  ttft_ms: number | null
  incognito: number
}

const toEvent = (r: EventRow): UsageEvent => ({
  id: r.id,
  at: r.at,
  route: r.route as Route,
  keyId: r.key_id,
  model: r.model,
  spec: r.spec,
  surface: r.surface as UsageEvent['surface'],
  projectId: r.project_id,
  chatId: r.chat_id,
  sessionId: r.session_id,
  input: r.input,
  cacheRead: r.cache_read,
  cacheWrite5m: r.cache_write_5m,
  cacheWrite1h: r.cache_write_1h,
  cacheWrite: r.cache_write,
  output: r.output,
  reasoning: r.reasoning,
  webSearches: r.web_searches,
  images: r.images,
  audioSeconds: r.audio_seconds,
  longContext: r.long_context === 1,
  costUsd: r.cost_usd,
  costKind: r.cost_kind as CostKind,
  priceId: r.price_id,
  durationMs: r.duration_ms,
  ttftMs: r.ttft_ms,
  incognito: r.incognito === 1
})

// The latest calls, newest first.
export function recent(db: Db, limit = 50): UsageEvent[] {
  const rows = db
    .prepare('SELECT * FROM usage_events ORDER BY at DESC, id DESC LIMIT ?')
    .all(limit) as EventRow[]
  return rows.map(toEvent)
}

// What each way of splitting totals groups by. A model is grouped as it was
// priced, so a dated id and its plain name count together.
const GROUP_BY: Record<UsageGroup, (utc: boolean) => string> = {
  day: (utc) => `date(at / 1000, 'unixepoch'${utc ? '' : ", 'localtime'"})`,
  model: () => 'COALESCE(spec, model)',
  route: () => 'route',
  project: () => 'project_id',
  surface: () => 'surface',
  key: () => 'key_id'
}

interface TotalsRow {
  grp: string | null
  events: number
  input: number
  cache_read: number
  cache_write: number
  output: number
  reasoning: number
  web_searches: number
  billed_usd: number
  plan_usd: number
  unpriced: number
}

// Sums for a stretch of time, split by day, model, route, project, surface or
// key. Days come oldest first; the others biggest spender first. Cash (billed)
// and Max-plan value are separate columns and never added together.
export function totals(db: Db, query: TotalsQuery): UsageTotals[] {
  const groupKey = GROUP_BY[query.groupBy]
  if (!groupKey) throw new Error(`Usage can't be split by "${query.groupBy}".`)
  const order = query.groupBy === 'day' ? 'grp' : 'billed_usd DESC, plan_usd DESC, events DESC, grp'
  const rows = db
    .prepare(
      `SELECT ${groupKey(query.utc === true)} AS grp,
              COUNT(*) AS events,
              SUM(input) AS input,
              SUM(cache_read) AS cache_read,
              SUM(cache_write_5m + cache_write_1h + cache_write) AS cache_write,
              SUM(output) AS output,
              SUM(reasoning) AS reasoning,
              SUM(web_searches) AS web_searches,
              SUM(CASE WHEN cost_kind = 'billed' THEN cost_usd ELSE 0 END) AS billed_usd,
              SUM(CASE WHEN cost_kind = 'plan' THEN cost_usd ELSE 0 END) AS plan_usd,
              SUM(cost_kind = 'unknown') AS unpriced
       FROM usage_events
       WHERE at >= ? AND at < ?${query.includeIncognito === false ? ' AND incognito = 0' : ''}
       GROUP BY grp ORDER BY ${order}`
    )
    .all(query.from, query.to) as TotalsRow[]
  return rows.map((r) => ({
    key: r.grp,
    events: r.events,
    input: r.input,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    output: r.output,
    reasoning: r.reasoning,
    webSearches: r.web_searches,
    billedUsd: r.billed_usd,
    planUsd: r.plan_usd,
    unpriced: r.unpriced
  }))
}

// Cash spent since a moment (a budget's month starts), on one route or one
// key or all of it. Only real spending counts: not Max plan value, not local
// calls, not calls with no price. Incognito calls do count, they cost money.
export function spendSince(db: Db, query: { from: number; route?: Route; keyId?: string }): number {
  const where = ["cost_kind = 'billed'", 'at >= ?']
  const args: (string | number)[] = [query.from]
  if (query.route) {
    where.push('route = ?')
    args.push(query.route)
  }
  if (query.keyId) {
    where.push('key_id = ?')
    args.push(query.keyId)
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events WHERE ${where.join(' AND ')}`
    )
    .get(...args) as { usd: number }
  return row.usd
}
