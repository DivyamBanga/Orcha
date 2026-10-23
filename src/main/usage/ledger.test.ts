import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { NO_USAGE } from '../chat/provider'
import {
  migrateUsage,
  recent,
  record,
  recordScanned,
  sessionTotals,
  spendSince,
  totals,
  USAGE_SCHEMA,
  type UsageInput
} from './ledger'
import type { ScannedEvent } from './transcripts'
import { addPrice, PRICE_SCHEMA, priceAt, seedPrices } from './pricing'
import { specFor } from '../../shared/models'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 22, 12)

function ledger(): Database.Database {
  const db = new Database(':memory:')
  db.exec(PRICE_SCHEMA)
  db.exec(USAGE_SCHEMA)
  migrateUsage(db)
  seedPrices(db)
  return db
}

// An Opus 5.5 chat turn on an API key, unless said otherwise.
const call = (over: Partial<UsageInput> = {}): UsageInput => ({
  ...NO_USAGE,
  at: T0,
  route: 'api',
  keyId: 'key-1',
  model: 'claude-opus-5-5',
  spec: null,
  surface: 'chat',
  projectId: 'proj-1',
  chatId: 'chat-1',
  sessionId: null,
  images: 0,
  audioSeconds: 0,
  durationMs: null,
  ttftMs: null,
  incognito: false,
  ...over
})

describe('recording a call', () => {
  it('creates its table and indexes, and can be created twice', () => {
    const db = ledger()
    db.exec(USAGE_SCHEMA)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(indexes).toEqual(
      expect.arrayContaining(['usage_at', 'usage_route_at', 'usage_chat', 'usage_project'])
    )
  })

  it('costs it at the price in force, remembers which price, and stores what it returns', () => {
    const db = ledger()
    const event = record(
      db,
      call({
        model: 'claude-opus-5-5-20260301',
        input: 1_000,
        cacheRead: 200_000,
        cacheWrite5m: 10_000,
        cacheWrite1h: 50_000,
        output: 8_000,
        reasoning: 3_000,
        longContext: false,
        durationMs: 4_200,
        ttftMs: 800
      })
    )
    expect(event.spec).toBe('claude-opus-5-5') // the dated id found its spec
    expect(event.costKind).toBe('billed')
    expect(event.costUsd).toBeCloseTo(0.654, 9)
    expect(event.priceId).toBe(priceAt(db, 'claude-opus-5-5', T0)!.id)
    expect(event.id).toBe(1)
    expect(recent(db, 1)).toEqual([event])
  })

  it('finds the spec for an Azure deployment, by name or as told', () => {
    const db = ledger()
    const dated = record(db, call({ route: 'azure', keyId: null, model: 'gpt-6-sol-2026-09-22' }))
    expect(dated.spec).toBe('gpt-6-sol')
    const renamed = record(
      db,
      call({ route: 'azure', keyId: null, model: 'my-sol', spec: 'gpt-6-sol', input: 100_000 })
    )
    expect(renamed.spec).toBe('gpt-6-sol')
    expect(renamed.costUsd).toBeCloseTo(0.2, 9)
  })

  it('values a Max plan call at list price, as plan value and not as money', () => {
    const db = ledger()
    const usage = { input: 1_000, cacheWrite1h: 50_000, output: 8_000 }
    const api = record(db, call(usage))
    const plan = record(db, call({ ...usage, route: 'plan', keyId: null }))
    expect(plan.costKind).toBe('plan')
    expect(plan.costUsd).toBe(api.costUsd)
    expect(plan.priceId).toBe(api.priceId)
    expect(spendSince(db, { from: 0, route: 'plan' })).toBe(0)
  })

  it('makes local calls free, whatever the model is called', () => {
    const db = ledger()
    const local = record(
      db,
      call({ route: 'ollama', keyId: null, model: 'qwen3.5:9b', input: 5_000 })
    )
    expect(local).toMatchObject({ costKind: 'free', costUsd: 0, priceId: null, spec: null })
    // a local model that happens to share a name with a priced one is still free
    const alike = record(db, call({ route: 'ollama', keyId: null, model: 'gpt-4o', input: 5_000 }))
    expect(alike).toMatchObject({ costKind: 'free', costUsd: 0, priceId: null, spec: null })
  })

  it('leaves a call with no price unknown rather than guessing', () => {
    const db = ledger()
    const event = record(db, call({ model: 'claude-future-9', input: 5_000 }))
    expect(event).toMatchObject({ costKind: 'unknown', costUsd: null, priceId: null, spec: null })
    expect(recent(db, 1)[0].costUsd).toBeNull()
  })

  it('takes a caller’s word that a call was free', () => {
    const db = ledger()
    const event = record(
      db,
      call({ route: 'azure', keyId: null, model: 'gpt-6-sol', costKind: 'free' })
    )
    expect(event).toMatchObject({ costKind: 'free', costUsd: 0, priceId: null })
  })

  it('counts an incognito call but keeps nothing that points back to it', () => {
    const db = ledger()
    const event = record(
      db,
      call({
        incognito: true,
        chatId: 'chat-9',
        projectId: 'proj-9',
        sessionId: 'session-9',
        input: 1_000_000
      })
    )
    expect(event).toMatchObject({ chatId: null, projectId: null, sessionId: null, incognito: true })
    expect(event.costUsd).toBeCloseTo(4, 9)
    const row = db
      .prepare('SELECT chat_id, project_id, session_id, incognito FROM usage_events')
      .get()
    expect(row).toEqual({ chat_id: null, project_id: null, session_id: null, incognito: 1 })
    expect(spendSince(db, { from: 0 })).toBeCloseTo(4, 9)
  })

  it('keeps the cost a call had after the price changes', () => {
    const db = ledger()
    const sol = specFor('gpt-6-sol')!.price
    const usage = {
      route: 'azure',
      keyId: null,
      model: 'gpt-6-sol',
      input: 100_000,
      output: 10_000
    } as const
    const before = record(db, call({ ...usage, at: T0 }))
    expect(before.costUsd).toBeCloseTo(0.3, 9) // 100,000 x $2 + 10,000 x $10

    const raised = addPrice(db, {
      model: 'gpt-6-sol',
      effectiveFrom: T0 + HOUR,
      price: { ...sol, in: 3, out: 12 },
      source: 'azure-retail',
      note: 'test'
    })
    const after = record(db, call({ ...usage, at: T0 + 2 * HOUR }))
    expect(after.costUsd).toBeCloseTo(0.42, 9) // 100,000 x $3 + 10,000 x $12
    expect(after.priceId).toBe(raised)

    // the first call still says what it cost and which price row it used
    const [newest, first] = recent(db, 2)
    expect(newest.id).toBe(after.id)
    expect(first.id).toBe(before.id)
    expect(first.costUsd).toBeCloseTo(0.3, 9)
    expect(first.priceId).toBe(before.priceId)
    expect(first.priceId).not.toBe(after.priceId)

    // a call from before the change that is recorded late still gets the price of its day
    const late = record(db, call({ ...usage, at: T0 + 1 }))
    expect(late.costUsd).toBeCloseTo(0.3, 9)
    expect(late.priceId).toBe(before.priceId)
  })

  it('doubles the token cost in fast mode', () => {
    const db = ledger()
    const usage = { input: 1_000, output: 8_000 }
    const normal = record(db, call(usage))
    const fast = record(db, call(usage), { fast: true })
    expect(fast.costUsd).toBeCloseTo(normal.costUsd! * 2, 12)
  })

  it('charges searches by model family', () => {
    const db = ledger()
    const claude = record(db, call({ webSearches: 3 }))
    expect(claude.costUsd).toBeCloseTo(0.03, 9)
    const gpt = record(
      db,
      call({ route: 'azure', keyId: null, model: 'gpt-6-sol', webSearches: 3 })
    )
    expect(gpt.costUsd).toBeCloseTo(0.042, 9)
  })

  it('uses the long tier for a Haiku 5.5 prompt over 100,000 tokens', () => {
    const db = ledger()
    const event = record(
      db,
      call({ model: 'claude-haiku-5-5', input: 90_000, cacheRead: 20_000, output: 2_000 })
    )
    expect(event.costUsd).toBeCloseTo(0.051, 9)
    expect(
      record(db, call({ model: 'claude-haiku-5-5', input: 1_000, longContext: true })).costUsd
    ).toBeCloseTo(0.0005, 9)
    expect(recent(db, 1)[0].longContext).toBe(true)
  })

  it('stores every field it was given', () => {
    const db = ledger()
    const event = record(
      db,
      call({
        route: 'plan',
        keyId: null,
        surface: 'research',
        sessionId: 'session-1',
        images: 2,
        audioSeconds: 12.5,
        reasoning: 40,
        output: 100,
        durationMs: 1_500,
        ttftMs: 300
      })
    )
    expect(recent(db, 1)).toEqual([event])
    expect(event).toMatchObject({ images: 2, audioSeconds: 12.5, sessionId: 'session-1' })
  })
})

// A few days of use, for the questions the dashboard and the budgets ask.
function busyLedger(): Database.Database {
  const db = ledger()
  const at = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 9, day, hour, minute)
  // Oct 20, 23:30 UTC: $0.024 on key-1
  record(db, call({ at: at(20, 23, 30), input: 1_000, output: 1_000 }))
  // Oct 21, 00:30 UTC: $0.048 on key-2, another project
  record(
    db,
    call({ at: at(21, 0, 30), keyId: 'key-2', projectId: 'proj-2', input: 2_000, output: 2_000 })
  )
  // Oct 21, 12:00 UTC: the Max plan, valued at $0.022
  record(
    db,
    call({
      at: at(21, 12),
      route: 'plan',
      keyId: null,
      input: 1_000,
      cacheWrite1h: 1_000,
      output: 500
    })
  )
  // Oct 22: Azure with a search ($0.0615), a free local title, a call with no price,
  // and an incognito Sonnet call ($0.012)
  record(
    db,
    call({
      at: at(22, 10),
      route: 'azure',
      keyId: null,
      model: 'gpt-6-sol',
      projectId: null,
      input: 10_000,
      cacheRead: 5_000,
      cacheWrite: 1_000,
      output: 1_000,
      reasoning: 400,
      webSearches: 2
    })
  )
  record(
    db,
    call({
      at: at(22, 11),
      route: 'ollama',
      keyId: null,
      model: 'qwen3.5:9b',
      surface: 'title',
      input: 300,
      output: 50
    })
  )
  record(db, call({ at: at(22, 12), model: 'claude-future-9', input: 100 }))
  record(
    db,
    call({
      at: at(22, 13),
      model: 'claude-sonnet-5-5',
      incognito: true,
      input: 1_000,
      output: 1_000
    })
  )
  return db
}

const WHOLE_WEEK = { from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 23) }

describe('totals', () => {
  it('splits by day, oldest first, with cash and plan value apart', () => {
    const days = totals(busyLedger(), { ...WHOLE_WEEK, groupBy: 'day', utc: true })
    expect(days.map((d) => d.key)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22'])
    expect(days[0]).toMatchObject({ events: 1, input: 1_000, output: 1_000, unpriced: 0 })
    expect(days[0].billedUsd).toBeCloseTo(0.024, 9)
    expect(days[1]).toMatchObject({ events: 2, cacheWrite: 1_000, output: 2_500 })
    expect(days[1].billedUsd).toBeCloseTo(0.048, 9)
    expect(days[1].planUsd).toBeCloseTo(0.022, 9)
    expect(days[2]).toMatchObject({
      events: 4,
      input: 11_400,
      cacheRead: 5_000,
      cacheWrite: 1_000,
      output: 2_050,
      reasoning: 400,
      webSearches: 2,
      unpriced: 1,
      planUsd: 0
    })
    expect(days[2].billedUsd).toBeCloseTo(0.0615 + 0.012, 9)
  })

  it('cuts days at local midnight unless asked for UTC', () => {
    const db = busyLedger()
    const local = (ms: number): string => {
      const d = new Date(ms)
      const two = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
    }
    const expected = new Set(recent(db, 100).map((e) => local(e.at)))
    const days = totals(db, { ...WHOLE_WEEK, groupBy: 'day' })
    expect(days.map((d) => d.key)).toEqual([...expected].sort())
    expect(days.reduce((n, d) => n + d.events, 0)).toBe(7)
  })

  it('counts the start of the range and not its end', () => {
    const db = busyLedger()
    const noon = Date.UTC(2026, 9, 21, 12)
    const sum = (from: number, to: number): number =>
      totals(db, { from, to, groupBy: 'route' }).reduce((n, g) => n + g.events, 0)
    expect(sum(noon, noon + 1)).toBe(1)
    expect(sum(noon + 1, noon + 2)).toBe(0)
    expect(sum(noon - 1, noon)).toBe(0)
  })

  it('splits by route, biggest spender first', () => {
    const rows = totals(busyLedger(), { ...WHOLE_WEEK, groupBy: 'route' })
    expect(rows.map((r) => r.key)).toEqual(['api', 'azure', 'plan', 'ollama'])
    expect(rows[0].billedUsd).toBeCloseTo(0.084, 9)
    expect(rows[0]).toMatchObject({ events: 4, unpriced: 1 })
    expect(rows[2]).toMatchObject({ billedUsd: 0 })
    expect(rows[2].planUsd).toBeCloseTo(0.022, 9)
  })

  it('splits by model as priced, so a dated id and its plain name are one row', () => {
    const db = busyLedger()
    record(
      db,
      call({ at: Date.UTC(2026, 9, 22, 14), model: 'claude-opus-5-5-20260301', input: 1_000 })
    )
    const rows = totals(db, { ...WHOLE_WEEK, groupBy: 'model' })
    expect(rows.map((r) => r.key)).toEqual([
      'claude-opus-5-5',
      'gpt-6-sol',
      'claude-sonnet-5-5',
      'claude-future-9',
      'qwen3.5:9b'
    ])
    expect(rows[0].events).toBe(4)
  })

  it('splits by project, with calls that have none together', () => {
    const db = busyLedger()
    const rows = totals(db, { ...WHOLE_WEEK, groupBy: 'project' })
    expect(rows.map((r) => r.key)).toEqual([null, 'proj-2', 'proj-1'])
    expect(rows[0].events).toBe(2) // the Azure call, and the incognito one
    expect(rows[0].billedUsd).toBeCloseTo(0.0615 + 0.012, 9)
    // leave incognito out and its $0.012 goes
    const without = totals(db, { ...WHOLE_WEEK, groupBy: 'project', includeIncognito: false })
    expect(without[0].events).toBe(1)
    expect(without[0].billedUsd).toBeCloseTo(0.0615, 9)
  })

  it('splits by surface and by key', () => {
    const db = busyLedger()
    const surfaces = totals(db, { ...WHOLE_WEEK, groupBy: 'surface' })
    expect(surfaces.map((r) => [r.key, r.events])).toEqual([
      ['chat', 6],
      ['title', 1]
    ])
    const keys = totals(db, { ...WHOLE_WEEK, groupBy: 'key' })
    expect(keys.map((r) => r.key)).toEqual([null, 'key-2', 'key-1'])
    expect(keys[2].billedUsd).toBeCloseTo(0.024 + 0.012, 9)
  })

  it('refuses a split it does not know', () => {
    expect(() => totals(ledger(), { ...WHOLE_WEEK, groupBy: 'chat' as never })).toThrow(
      'Usage can\'t be split by "chat".'
    )
  })

  it('is empty when nothing was used', () => {
    expect(totals(ledger(), { ...WHOLE_WEEK, groupBy: 'day' })).toEqual([])
  })
})

describe('spending against a budget', () => {
  it('adds up only real cash, from a moment, by key or route', () => {
    const db = busyLedger()
    const oct21 = Date.UTC(2026, 9, 21)
    // key-1: Oct 20 ($0.024) is before, the incognito Sonnet call ($0.012) counts
    expect(spendSince(db, { from: oct21, keyId: 'key-1' })).toBeCloseTo(0.012, 9)
    expect(spendSince(db, { from: 0, keyId: 'key-1' })).toBeCloseTo(0.036, 9)
    expect(spendSince(db, { from: 0, keyId: 'key-2' })).toBeCloseTo(0.048, 9)
    expect(spendSince(db, { from: 0, route: 'azure' })).toBeCloseTo(0.0615, 9)
    expect(spendSince(db, { from: 0, route: 'api' })).toBeCloseTo(0.084, 9)
    // everything: not the plan's $0.022, not the free call, not the unpriced one
    expect(spendSince(db, { from: 0 })).toBeCloseTo(0.084 + 0.0615, 9)
    expect(spendSince(db, { from: 0, route: 'ollama' })).toBe(0)
    expect(spendSince(db, { from: Date.UTC(2027, 0, 1) })).toBe(0)
  })
})

describe('recent calls', () => {
  it('lists the newest first, as many as asked', () => {
    const db = busyLedger()
    const last = recent(db, 3)
    expect(last.map((e) => e.model)).toEqual(['claude-sonnet-5-5', 'claude-future-9', 'qwen3.5:9b'])
    expect(recent(db, 100)).toHaveLength(7)
    expect(recent(db)).toHaveLength(7)
  })

  it('puts calls from the same moment in the order they were recorded', () => {
    const db = ledger()
    const first = record(db, call({ input: 1 }))
    const second = record(db, call({ input: 2 }))
    expect(recent(db, 2).map((e) => e.id)).toEqual([second.id, first.id])
  })
})

// A Claude Code call as the scanner hands it over.
const scanned = (over: Partial<ScannedEvent> = {}): ScannedEvent => ({
  ...call({ route: 'plan', keyId: null, surface: 'claude-code', sessionId: 'sess-1' }),
  costUsd: null,
  costKind: 'plan',
  priceId: null,
  key: 'msg_1:req_1',
  cwd: 'C:/work/app',
  speed: null,
  ...over
})

describe('adding scanned calls', () => {
  it('gives a database from before scanning a source key, and can be migrated twice', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE usage_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)')
    migrateUsage(db)
    migrateUsage(db)
    const columns = db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('source_key')
  })

  it('costs a call as plan value and keeps one row per key', () => {
    const db = ledger()
    recordScanned(db, scanned({ input: 1_000, output: 500 }))
    recordScanned(db, scanned({ input: 1_000, output: 500 }))
    const rows = recent(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ costKind: 'plan', route: 'plan', surface: 'claude-code' })
    expect(rows[0].costUsd).toBeGreaterThan(0)
  })

  it('lets the version with the most output win, keeping the first time and session', () => {
    const db = ledger()
    recordScanned(db, scanned({ output: 8, at: T0, sessionId: 'sess-1' }))
    recordScanned(db, scanned({ output: 506, at: T0 + HOUR, sessionId: 'sess-2' }))
    recordScanned(db, scanned({ output: 100, at: T0 + 2 * HOUR }))
    const [row, ...others] = recent(db)
    expect(others).toEqual([])
    expect(row).toMatchObject({ output: 506, at: T0, sessionId: 'sess-1', costKind: 'plan' })
    const price = priceAt(db, 'claude-opus-5-5', T0)
    expect(row.priceId).toBe(price?.id)
    expect(row.costUsd).toBeCloseTo((506 * (price?.price.out ?? 0)) / 1_000_000, 10)
  })

  it('doubles the cost of a fast-mode call', () => {
    const db = ledger()
    recordScanned(db, scanned({ key: 'a', output: 1_000 }))
    recordScanned(db, scanned({ key: 'b', output: 1_000, speed: 'fast' }))
    const [b, a] = recent(db)
    expect(b.costUsd).toBeCloseTo((a.costUsd ?? 0) * 2, 10)
  })

  it('keeps live calls apart from scanned ones and from each other', () => {
    const db = ledger()
    record(db, call())
    record(db, call())
    recordScanned(db, scanned())
    expect(recent(db)).toHaveLength(3)
  })

  it('adds up one coding session', () => {
    const db = ledger()
    recordScanned(db, scanned({ key: 'a', input: 10, output: 20, cacheRead: 30, cacheWrite5m: 4 }))
    recordScanned(db, scanned({ key: 'b', input: 1, output: 2, cacheWrite1h: 3 }))
    recordScanned(db, scanned({ key: 'c', sessionId: 'other', output: 999 }))
    expect(sessionTotals(db, 'sess-1')).toMatchObject({
      input: 11,
      output: 22,
      cacheRead: 30,
      cacheWrite: 7
    })
    expect(sessionTotals(db, 'nobody')).toBeNull()
  })
})
