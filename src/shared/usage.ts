import type { Price } from './models'

// What the usage dashboard asks the ledger for, and what the price book
// reports back (main/usage/ledger.ts and pricing.ts fill these in; the
// window only reads them).

// How totals are split up: calendar day, model (as priced), route, project,
// surface (chat, title, memory...) or Anthropic key.
export type UsageGroup = 'day' | 'model' | 'route' | 'project' | 'surface' | 'key'

export interface TotalsQuery {
  from: number // ms epoch, included
  to: number // ms epoch, not included
  groupBy: UsageGroup
  // 'day' groups cut at local midnight unless this is set (UTC midnight).
  utc?: boolean
  // Incognito calls count by default; false leaves them out.
  includeIncognito?: boolean
}

// One group's sums. Cash and Max-plan value are kept apart on purpose: plan
// value is what the same calls would cost at list price, never money spent.
export interface UsageTotals {
  // The day ('2026-10-22'), model, route, project id, surface or key id; null
  // for calls with none (no project, no key). Incognito calls have no
  // project, so they fall in the null group of a project split.
  key: string | null
  events: number
  input: number // fresh input tokens (cache reads and writes are separate)
  cacheRead: number
  cacheWrite: number // every cache-write bucket added together
  output: number // includes reasoning
  reasoning: number
  webSearches: number
  billedUsd: number // real money on a key or Azure
  planUsd: number // Max plan calls, priced as if they were API calls
  unpriced: number // calls Orcha has no price for (left out of both sums)
}

// One change to the price book, for the change log.
export interface PriceChange {
  model: string
  before: Price | null // null when the model had no price yet
  after: Price
  effectiveFrom: number
  note: string // plain words: what changed
}
