import type { MeteredUsage, UsageLine } from './meter'

// Every rate here is list price in USD per million tokens, checked on
// 2026-09-29 against platform.claude.com/docs/en/about-claude/pricing and the
// Azure blog post announcing GPT-6 in Foundry (the Azure pricing page itself
// still shows placeholders). When a provider changes a price, this file is the
// only thing to update.

// A budget pool: one balance a guest spends from. Every Claude model shares
// the "claude" pool; each Azure deployment has its own.
export type Pool = string
export type Provider = 'anthropic' | 'azure'

export const POOLS: Record<Pool, { label: string; order: number; provider: Provider }> = {
  claude: { label: 'Claude', order: 0, provider: 'anthropic' },
  sol: { label: 'GPT-6 Sol', order: 1, provider: 'azure' },
  astra: { label: 'GPT-6 Astra', order: 2, provider: 'azure' }
}

// ---- the model catalog -----------------------------------------------------------
//
// What Orcha offers, served to every paired device at /v1/me/models, so adding
// a model is an edit here plus a deploy — no app release. An Azure model also
// needs a deployment named exactly like its id (the request body goes upstream
// unchanged) and its rates in AZURE_RATES below.

// How a model thinks. 'toggle': adaptive thinking, can be turned off. 'always':
// thinking can't be turned off, so the toggle lowers effort instead. 'budget':
// older-style thinking with a token budget. 'reasoning': an Azure reasoning
// model (effort plus a reasoning summary).
export type ThinkingMode = 'toggle' | 'always' | 'budget' | 'reasoning'

export interface CatalogModel {
  id: string // what requests send as `model`
  label: string
  description: string // one line for the model picker
  pool: Pool
  provider: Provider
  chat: boolean // offered in chat
  codex: boolean // offered for Codex terminal tabs
  thinking: ThinkingMode
  webSearch: string | null // Anthropic tool type, 'web_search' on Azure, or null
  vision: boolean
  pdfPages: number | null // longest PDF it reads natively; null = no PDFs
  default?: boolean // first pick for a new chat on this provider
  title?: boolean // the cheap model that names chats
  rates: { in: number; out: number; cacheRead: number } // USD per million, for estimates
}

type ModelInfo = Omit<CatalogModel, 'provider' | 'rates'>

const CHAT_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Smart and fast, for most things',
    pool: 'claude',
    chat: true,
    codex: false,
    thinking: 'toggle',
    webSearch: 'web_search_20260209',
    vision: true,
    pdfPages: 600,
    default: true
  },
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'Deeper reasoning for hard problems',
    pool: 'claude',
    chat: true,
    codex: false,
    thinking: 'always',
    webSearch: 'web_search_20260209',
    vision: true,
    pdfPages: 600
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: 'Most capable, and the most expensive',
    pool: 'claude',
    chat: true,
    codex: false,
    thinking: 'always',
    webSearch: 'web_search_20250305',
    vision: true,
    pdfPages: 600
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Fastest and cheapest, for quick questions',
    pool: 'claude',
    chat: true,
    codex: false,
    thinking: 'budget',
    webSearch: 'web_search_20250305',
    vision: true,
    pdfPages: 100,
    title: true
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'Fast and capable',
    pool: 'sol',
    chat: true,
    codex: true,
    thinking: 'reasoning',
    webSearch: 'web_search',
    vision: true,
    pdfPages: 100,
    default: true,
    title: true
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: "OpenAI's most capable",
    pool: 'astra',
    chat: true,
    codex: true,
    thinking: 'reasoning',
    webSearch: 'web_search',
    vision: true,
    pdfPages: 100
  }
]

export function catalog(): CatalogModel[] {
  return CHAT_MODELS.map((m) => {
    const provider = POOLS[m.pool].provider
    if (provider === 'azure') {
      const r = AZURE_RATES[m.id].short
      return { ...m, provider, rates: { in: r.in, out: r.out, cacheRead: r.cached } }
    }
    const r = anthropicRates(m.id)
    return { ...m, provider, rates: { in: r.in, out: r.out, cacheRead: r.cr } }
  })
}

// Codex and chat requests name a model; the Azure deployments carry the same
// names, so the name alone picks the pool. Anything not listed is refused.
export function poolForResponsesModel(model: string): Pool | null {
  return AZURE_RATES[model]?.pool ?? null
}

export function responsesModelIds(): string[] {
  return Object.keys(AZURE_RATES)
}

// ---- Anthropic ------------------------------------------------------------------

// in = base input, cw5m / cw1h = cache writes by TTL, cr = cache reads.
interface Rates {
  in: number
  cw5m: number
  cw1h: number
  cr: number
  out: number
}

const ANTHROPIC: Record<string, Rates> = {
  'claude-fable-5-1': { in: 10, cw5m: 12.5, cw1h: 20, cr: 0.25, out: 50 },
  'claude-fable-5': { in: 10, cw5m: 12.5, cw1h: 20, cr: 1, out: 50 },
  'claude-mythos-5-1': { in: 10, cw5m: 12.5, cw1h: 20, cr: 0.25, out: 50 },
  'claude-mythos-5': { in: 10, cw5m: 12.5, cw1h: 20, cr: 1, out: 50 },
  'claude-opus-5-5': { in: 4, cw5m: 5, cw1h: 8, cr: 0.2, out: 20 },
  'claude-opus-5': { in: 5, cw5m: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  'claude-opus-4-8': { in: 5, cw5m: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  'claude-opus-4-7': { in: 5, cw5m: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  'claude-opus-4-6': { in: 5, cw5m: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  'claude-opus-4-5': { in: 5, cw5m: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  'claude-opus-4-1': { in: 15, cw5m: 18.75, cw1h: 30, cr: 1.5, out: 75 },
  'claude-opus-4-2': { in: 15, cw5m: 18.75, cw1h: 30, cr: 1.5, out: 75 },
  'claude-sonnet-5-5': { in: 2, cw5m: 2.5, cw1h: 4, cr: 0.2, out: 10 },
  'claude-sonnet-5': { in: 2, cw5m: 2.5, cw1h: 4, cr: 0.2, out: 10 },
  'claude-sonnet-4-6': { in: 3, cw5m: 3.75, cw1h: 6, cr: 0.3, out: 15 },
  'claude-sonnet-4': { in: 3, cw5m: 3.75, cw1h: 6, cr: 0.3, out: 15 },
  'claude-haiku-4-5': { in: 1, cw5m: 1.25, cw1h: 2, cr: 0.1, out: 5 },
  'claude-3-5-haiku': { in: 0.8, cw5m: 1, cw1h: 1.6, cr: 0.08, out: 4 }
}

// Fast mode (usage.speed === 'fast') has its own base rates; cache multipliers
// apply on top the same way.
const ANTHROPIC_FAST: Record<string, Rates> = {
  'claude-opus-5-5': { in: 8, cw5m: 10, cw1h: 16, cr: 0.4, out: 40 },
  'claude-opus-5': { in: 10, cw5m: 12.5, cw1h: 20, cr: 1, out: 50 },
  'claude-opus-4-8': { in: 10, cw5m: 12.5, cw1h: 20, cr: 1, out: 50 }
}

// US-only inference (usage.inference_geo === 'us') costs 1.1x on every token.
const GEO_US_MULTIPLIER = 1.1
const ANTHROPIC_WEB_SEARCH_USD = 0.01

// Longest table key the model id starts with, so dated ids
// ("claude-haiku-4-5-20251001") and newer point releases find their family.
function lookup(table: Record<string, Rates>, model: string | null): Rates | null {
  const id = (model ?? '').toLowerCase().replace(/\[1m\]$/, '')
  if (!id) return null
  let best: string | null = null
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key
  }
  return best ? table[best] : null
}

// An id we have no price for is charged at its family's priciest current
// rate, and anything unrecognisable at the top rate — an unknown model should
// never be cheaper for a guest than the real bill is for the host.
function anthropicRates(model: string | null): Rates {
  const known = lookup(ANTHROPIC, model)
  if (known) return known
  const id = (model ?? '').toLowerCase()
  if (id.includes('haiku')) return ANTHROPIC['claude-haiku-4-5']
  if (id.includes('sonnet')) return ANTHROPIC['claude-sonnet-4-6']
  if (id.includes('opus')) return ANTHROPIC['claude-opus-5']
  return ANTHROPIC['claude-fable-5-1']
}

function anthropicLineCost(line: UsageLine, usage: MeteredUsage): number {
  const rates =
    (usage.speed === 'fast' ? lookup(ANTHROPIC_FAST, line.model) : null) ??
    anthropicRates(line.model)
  const geo = usage.inferenceGeo === 'us' ? GEO_US_MULTIPLIER : 1
  return (
    (geo *
      (line.inputTokens * rates.in +
        line.cachedTokens * rates.cr +
        line.cacheWrite5mTokens * rates.cw5m +
        line.cacheWrite1hTokens * rates.cw1h +
        line.outputTokens * rates.out)) /
    1_000_000
  )
}

// ---- Azure OpenAI (Global Standard deployments) ---------------------------------

interface ResponsesRates {
  in: number
  cached: number
  write: number // cache writes, 1.25x input
  out: number
}

// Per deployment (= model id): its pool, and short/long-context rates.
const AZURE_RATES: Record<string, { pool: Pool; short: ResponsesRates; long: ResponsesRates }> = {
  'gpt-6-sol': {
    pool: 'sol',
    short: { in: 2, cached: 0.2, write: 2.5, out: 10 },
    long: { in: 4, cached: 0.4, write: 5, out: 15 }
  },
  'gpt-6-astra': {
    pool: 'astra',
    short: { in: 10, cached: 1, write: 12.5, out: 50 },
    long: { in: 20, cached: 2, write: 25, out: 75 }
  }
}

// A line's model if it's a known deployment, else the priciest deployment in
// the pool — never cheaper for a guest than the real bill is for the host.
function azureRates(pool: Pool, model: string | null): { short: ResponsesRates; long: ResponsesRates } {
  const known = model ? AZURE_RATES[model] : undefined
  if (known && known.pool === pool) return known
  const inPool = Object.values(AZURE_RATES).filter((r) => r.pool === pool)
  return inPool.sort((a, b) => b.short.out - a.short.out)[0] ?? AZURE_RATES['gpt-6-astra']
}

// A request whose total input exceeds this is billed at the long-context
// rates for the whole request (input and output).
const LONG_CONTEXT_OVER_TOKENS = 272_000
// Built-in web search on Azure bills through Grounding with Bing.
const AZURE_WEB_SEARCH_USD = 0.014
// Azure hasn't published GPT-6 Priority Processing rates; OpenAI's own
// priority tier is 2x standard, so a priority reply is charged at that.
const PRIORITY_MULTIPLIER = 2

function responsesLineCost(pool: Pool, line: UsageLine, tier: string | null): number {
  const totalInput = line.inputTokens + line.cachedTokens + line.cacheWrite5mTokens
  const table = azureRates(pool, line.model)
  const rates = totalInput > LONG_CONTEXT_OVER_TOKENS ? table.long : table.short
  const multiplier = tier === 'priority' ? PRIORITY_MULTIPLIER : 1
  return (
    (multiplier *
      (line.inputTokens * rates.in +
        line.cachedTokens * rates.cached +
        line.cacheWrite5mTokens * rates.write +
        line.outputTokens * rates.out)) /
    1_000_000
  )
}

// ---- total ----------------------------------------------------------------------

export function costOf(pool: Pool, usage: MeteredUsage): number {
  if (POOLS[pool]?.provider !== 'azure') {
    let cost = usage.webSearches * ANTHROPIC_WEB_SEARCH_USD
    for (const line of usage.lines) cost += anthropicLineCost(line, usage)
    return cost
  }
  let cost = usage.webSearches * AZURE_WEB_SEARCH_USD
  for (const line of usage.lines) cost += responsesLineCost(pool, line, usage.serviceTier)
  return cost
}
