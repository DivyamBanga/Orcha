import type Database from 'better-sqlite3'
import type { PriceRow } from '../../shared/ai'
import { MODEL_SPECS, specFor, type Family, type Price } from '../../shared/models'
import type { PriceChange } from '../../shared/usage'
import type { TokenUsage } from '../chat/provider'
import { mergeRates, readMeters, sameUsd, type ModelRates, type RetailItem } from './azureMeters'

// The price book: what each model costs per million tokens, as it stood from
// a date. Rows are only ever added, never edited, so a call keeps the price
// it was costed with even after prices change. Prices come from three places:
// the table in shared/models.ts (checked by hand against Anthropic's and
// Microsoft's pages, and updated with each release), Azure's public price
// list (refreshAzurePrices), and by hand ('manual').

type Db = Database.Database

export const PRICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS prices (
    id             INTEGER PRIMARY KEY,
    model          TEXT NOT NULL,
    effective_from INTEGER NOT NULL,
    price          TEXT NOT NULL,
    source         TEXT NOT NULL,
    note           TEXT
  );
  CREATE INDEX IF NOT EXISTS prices_model ON prices (model, effective_from);
`

interface PriceRecord {
  id: number
  model: string
  effective_from: number
  price: string
  source: string
  note: string | null
}

const toPriceRow = (r: PriceRecord): PriceRow => ({
  id: r.id,
  model: r.model,
  effectiveFrom: r.effective_from,
  price: JSON.parse(r.price) as Price,
  source: r.source as PriceRow['source'],
  note: r.note
})

const TOP_KEYS = ['in', 'out', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite'] as const
const LONG_KEYS = ['above', 'in', 'out', 'cacheRead', 'cacheWrite'] as const

function samePrice(a: Price, b: Price): boolean {
  if (!TOP_KEYS.every((key) => sameUsd(a[key], b[key]))) return false
  const [long, other] = [a.long, b.long]
  if (!long || !other) return !long && !other
  return LONG_KEYS.every((key) => sameUsd(long[key], other[key]))
}

// "input $2 → $2.5, cached input $0.2 → $0.1": what differs between two prices.
const PARTS: [string, (price: Price) => number | undefined][] = [
  ['input', (p) => p.in],
  ['output', (p) => p.out],
  ['cached input', (p) => p.cacheRead],
  ['cache write', (p) => p.cacheWrite],
  ['5-minute cache write', (p) => p.cacheWrite5m],
  ['1-hour cache write', (p) => p.cacheWrite1h],
  ['long-context input', (p) => p.long?.in],
  ['long-context output', (p) => p.long?.out],
  ['long-context cached input', (p) => p.long?.cacheRead],
  ['long-context cache write', (p) => p.long?.cacheWrite]
]

function describeChange(before: Price, after: Price): string {
  const usd = (n: number | undefined): string =>
    n === undefined ? 'none' : `$${Number(n.toPrecision(6))}`
  const changes = PARTS.filter(([, get]) => !sameUsd(get(before), get(after))).map(
    ([label, get]) => `${label} ${usd(get(before))} → ${usd(get(after))}`
  )
  if (!sameUsd(before.long?.above, after.long?.above)) {
    changes.push(`long prompts start above ${after.long?.above ?? 'no'} tokens`)
  }
  return changes.join(', ') || 'no rate changed'
}

export function addPrice(db: Db, row: Omit<PriceRow, 'id'>): number {
  const result = db
    .prepare(
      'INSERT INTO prices (model, effective_from, price, source, note) VALUES (?, ?, ?, ?, ?)'
    )
    .run(row.model, row.effectiveFrom, JSON.stringify(row.price), row.source, row.note)
  return Number(result.lastInsertRowid)
}

// The row in force for a model at a moment: the newest one that had begun by
// then. Null when the model has no price from before that moment.
export function priceAt(db: Db, model: string, at: number): PriceRow | null {
  const row = db
    .prepare(
      `SELECT * FROM prices WHERE model = ? AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(model, at) as PriceRecord | undefined
  return row ? toPriceRow(row) : null
}

// Puts the built-in prices (shared/models.ts) in the book. A model's first
// price counts from the beginning of time, so old calls found later (a
// transcript scanned days after) still get a price. When a release changes a
// model's built-in price, a new row starts now and the old one stays. It
// compares against the last *built-in* row, so an Azure row that is newer is
// never overwritten by an unchanged built-in. Returns how many rows it added.
export function seedPrices(db: Db, now: number = Date.now()): number {
  const lastBuiltIn = db.prepare(
    `SELECT price FROM prices WHERE model = ? AND source = 'built-in'
     ORDER BY effective_from DESC, id DESC LIMIT 1`
  )
  let added = 0
  db.transaction(() => {
    for (const spec of MODEL_SPECS) {
      const row = lastBuiltIn.get(spec.id) as { price: string } | undefined
      const before = row ? (JSON.parse(row.price) as Price) : null
      if (before && samePrice(before, spec.price)) continue
      addPrice(db, {
        model: spec.id,
        effectiveFrom: before ? now : 0,
        price: spec.price,
        source: 'built-in',
        note: before ? `Built-in price updated: ${describeChange(before, spec.price)}` : null
      })
      added++
    }
  })()
  return added
}

// ---- what a call costs ----

// Web search is billed per search on top of the tokens: Anthropic's tool
// charges $10 per 1,000, Azure's (Bing grounding) $14 per 1,000.
const SEARCH_USD_PER_1000: Record<Family, number> = { claude: 10, gpt: 14 }

// Anthropic's fast mode (Opus) charges double on every token rate, cache
// rates included. Searches cost the same.
const FAST_MULTIPLIER = 2

export interface CostOptions {
  fast?: boolean
  // Decides the web-search fee. Left out, it is read from the price: only
  // Claude prices split cache writes by lifetime.
  family?: Family
}

interface Rates {
  in: number
  out: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheWrite: number
}

// The rates one call is billed at. A prompt over the long-context line (cache
// reads and writes count toward it) is billed entirely at the long rates, as
// is any call the provider reported as long. A long tier lists no cache-write
// rates for Claude (Haiku 5.5 charges 1.25x and 2x its long input rate, as it
// does its short one), so those keep the same multiple of input.
function ratesFor(price: Price, usage: TokenUsage): Rates {
  const { long } = price
  const prompt =
    usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWrite
  if (!long || !(usage.longContext || prompt > long.above)) {
    return {
      in: price.in,
      out: price.out,
      cacheRead: price.cacheRead,
      cacheWrite5m: price.cacheWrite5m ?? 0,
      cacheWrite1h: price.cacheWrite1h ?? 0,
      cacheWrite: price.cacheWrite ?? 0
    }
  }
  const scale = price.in > 0 ? long.in / price.in : 1
  return {
    in: long.in,
    out: long.out,
    cacheRead: long.cacheRead,
    cacheWrite5m: (price.cacheWrite5m ?? 0) * scale,
    cacheWrite1h: (price.cacheWrite1h ?? 0) * scale,
    cacheWrite: long.cacheWrite ?? (price.cacheWrite ?? 0) * scale
  }
}

const familyOf = (price: Price): Family =>
  price.cacheWrite5m !== undefined || price.cacheWrite1h !== undefined ? 'claude' : 'gpt'

// Dollars for one call at a price. Token buckets are exclusive, so each is
// charged once at its own rate; reasoning is part of output and isn't added
// again. Not rounded: the ledger keeps the exact figure.
export function costOf(price: Price, usage: TokenUsage, opts: CostOptions = {}): number {
  const rate = ratesFor(price, usage)
  // tokens x dollars per million = millionths of a dollar
  const microUsd =
    usage.input * rate.in +
    usage.cacheRead * rate.cacheRead +
    usage.cacheWrite5m * rate.cacheWrite5m +
    usage.cacheWrite1h * rate.cacheWrite1h +
    usage.cacheWrite * rate.cacheWrite +
    usage.output * rate.out
  const searches = (usage.webSearches * SEARCH_USD_PER_1000[opts.family ?? familyOf(price)]) / 1000
  return (microUsd / 1_000_000) * (opts.fast ? FAST_MULTIPLIER : 1) + searches
}

// ---- Azure's price list ----

// Microsoft publishes list prices with no sign-in, as one list of "meters".
// The list only ever shows what is current, so a price that changes is only
// noticed by looking again; refreshAzurePrices does that, and every change it
// finds becomes a new row.

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>

export interface RefreshOptions {
  now?: number
  // Ask Azure even though the last answer is under a day old.
  force?: boolean
  sleep?: (ms: number) => Promise<void>
}

const RETAIL_HOST = 'prices.azure.com'
// Every Azure OpenAI product, one region (Global prices are the same
// everywhere), Global meters only (their names say 'Gl', 'Glbl', 'global'),
// all in one query. That is about 660 rows, which fit on one page.
const RETAIL_FILTER =
  "serviceName eq 'Foundry Models' and contains(productName, 'Azure OpenAI') " +
  "and armRegionName eq 'eastus2' and priceType eq 'Consumption' " +
  "and (contains(meterName, 'Gl') or contains(meterName, 'gl'))"
const FIRST_PAGE = `https://${RETAIL_HOST}/api/retail/prices?api-version=2023-01-01-preview&$filter=${encodeURIComponent(RETAIL_FILTER)}`

const MAX_PAGES = 10
const PAGE_PAUSE_MS = 2000 // rapid page requests are what Azure throttles
const REQUEST_TIMEOUT_MS = 30_000
const MAX_TRIES = 5
const DEFAULT_WAIT_MS = 8000 // when a 429 doesn't say how long to wait
const MAX_WAIT_MS = 120_000
const CACHE_MS = 24 * 60 * 60 * 1000

const UNREADABLE = "Azure's price list came back in a form Orcha couldn't read."

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// How long to wait after a 429: what Azure's Retry-After header says (it asks
// for 60 seconds), else 8 seconds doubling each time.
function backoffMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get('retry-after'))
  const ms = seconds > 0 ? seconds * 1000 : DEFAULT_WAIT_MS * 2 ** (attempt - 1)
  return Math.min(ms, MAX_WAIT_MS)
}

async function getPage(
  url: string,
  fetchFn: FetchLike,
  sleep: (ms: number) => Promise<void>
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new Error("Couldn't reach Azure's price list. Check the connection and try again.")
    }
    if (res.status === 429) {
      if (attempt >= MAX_TRIES) {
        throw new Error('Azure is limiting price checks right now. Try again in a few minutes.')
      }
      await sleep(backoffMs(res, attempt))
      continue
    }
    if (!res.ok) {
      throw new Error(`Azure's price list isn't answering right now (error ${res.status}).`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error(UNREADABLE)
    }
  }
}

// Where the list continues, or null at the end. It must stay on Azure's own
// host: the link comes from the response and Orcha will request it.
function nextPage(link: unknown): string | null {
  if (typeof link !== 'string' || !link) return null
  try {
    const url = new URL(link)
    if (url.protocol === 'https:' && url.hostname === RETAIL_HOST) return url.href
  } catch {
    // falls through to the error below
  }
  throw new Error(UNREADABLE)
}

function isRetailItem(value: unknown): value is RetailItem {
  const item = value as Partial<RetailItem> | null
  return (
    typeof item?.meterName === 'string' &&
    typeof item.retailPrice === 'number' &&
    typeof item.unitOfMeasure === 'string'
  )
}

async function fetchRetailItems(
  fetchFn: FetchLike,
  sleep: (ms: number) => Promise<void>
): Promise<RetailItem[]> {
  const items: RetailItem[] = []
  let url: string | null = FIRST_PAGE
  for (let page = 0; url && page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_PAUSE_MS)
    const body = (await getPage(url, fetchFn, sleep)) as {
      Items?: unknown
      NextPageLink?: unknown
    } | null
    if (!Array.isArray(body?.Items)) throw new Error(UNREADABLE)
    items.push(...body.Items.filter(isRetailItem))
    url = nextPage(body.NextPageLink)
  }
  return items
}

const latestStart = (db: Db, model: string): number =>
  (
    db
      .prepare('SELECT COALESCE(MAX(effective_from), 0) AS at FROM prices WHERE model = ?')
      .get(model) as { at: number }
  ).at

// Adds a row for each model whose price Azure now lists differently from the
// book. The row counts from the day Azure says the new price began, but never
// before the model's newest row (so it wins over it) and never in the future.
function recordChanges(db: Db, rates: Map<string, ModelRates>, now: number): PriceChange[] {
  const changes: PriceChange[] = []
  db.transaction(() => {
    for (const [model, found] of rates) {
      const current = priceAt(db, model, now)
      const before = current?.price ?? specFor(model)?.price
      if (!before) continue
      const { price: after, since } = mergeRates(before, found)
      if (samePrice(before, after)) continue
      const effectiveFrom = Math.min(now, Math.max(since ?? now, latestStart(db, model)))
      const listed =
        since === null ? '' : ` (listed from ${new Date(since).toISOString().slice(0, 10)})`
      const note = `Azure retail price, per million tokens: ${describeChange(before, after)}${listed}`
      addPrice(db, { model, effectiveFrom, price: after, source: 'azure-retail', note })
      changes.push({ model, before: current?.price ?? null, after, effectiveFrom, note })
    }
  })()
  return changes
}

// What Azure answered last, per database, so asking again within a day costs
// nothing and a double click can't hit the throttle.
const answers = new WeakMap<Db, { at: number; rates: Map<string, ModelRates> }>()

// Looks at Azure's price list and adds a row for every GPT model whose price
// changed, returning the changes for the change log. One query, normally one
// request (a longer list is followed page by page, with a pause between), and
// it backs off when Azure says to slow down. It throws with a sentence that
// can be shown as is if Azure can't be read; the book is left as it was.
export async function refreshAzurePrices(
  db: Db,
  fetchFn: FetchLike = fetch,
  opts: RefreshOptions = {}
): Promise<PriceChange[]> {
  const now = opts.now ?? Date.now()
  let answer = answers.get(db)
  if (opts.force || !answer || now - answer.at >= CACHE_MS) {
    const rates = readMeters(await fetchRetailItems(fetchFn, opts.sleep ?? pause))
    if (rates.size === 0) {
      throw new Error("Azure's price list had no GPT prices Orcha could read, so nothing changed.")
    }
    answer = { at: now, rates }
    answers.set(db, answer)
  }
  return recordChanges(db, answer.rates, now)
}
