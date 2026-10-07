import * as db from './db'
import { isGuest, relayConfig } from './guest'
import type { Catalog, CatalogModel } from '../shared/types'

// The models this Orcha offers, from the relay's /v1/me/models: adding a
// model there makes it appear here with no app release. Cached so it's there
// at startup and offline. Before the first fetch (or against a relay too old
// to serve it) the built-in copy below stands in; it matches the relay's.

const KEY = 'catalog'

const model = (m: Omit<CatalogModel, 'chat'> & { chat?: boolean }): CatalogModel => ({
  chat: true,
  ...m
})

const BUILT_IN: Catalog = {
  pools: [
    { id: 'claude', label: 'Claude', order: 0, provider: 'anthropic', blocked: false },
    { id: 'sol', label: 'GPT-6 Sol', order: 1, provider: 'azure', blocked: false },
    { id: 'astra', label: 'GPT-6 Astra', order: 2, provider: 'azure', blocked: false }
  ],
  models: [
    model({
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      description: 'Smart and fast, for most things',
      pool: 'claude',
      provider: 'anthropic',
      codex: false,
      thinking: 'toggle',
      webSearch: 'web_search_20260209',
      vision: true,
      pdfPages: 600,
      default: true,
      rates: { in: 2, out: 10, cacheRead: 0.2 }
    }),
    model({
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Deeper reasoning for hard problems',
      pool: 'claude',
      provider: 'anthropic',
      codex: false,
      thinking: 'always',
      webSearch: 'web_search_20260209',
      vision: true,
      pdfPages: 600,
      rates: { in: 4, out: 20, cacheRead: 0.2 }
    }),
    model({
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      description: 'Most capable, and the most expensive',
      pool: 'claude',
      provider: 'anthropic',
      codex: false,
      thinking: 'always',
      webSearch: 'web_search_20250305',
      vision: true,
      pdfPages: 600,
      rates: { in: 10, out: 50, cacheRead: 0.25 }
    }),
    model({
      id: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      description: 'Fastest and cheapest, for quick questions',
      pool: 'claude',
      provider: 'anthropic',
      codex: false,
      thinking: 'budget',
      webSearch: 'web_search_20250305',
      vision: true,
      pdfPages: 100,
      title: true,
      rates: { in: 1, out: 5, cacheRead: 0.1 }
    }),
    model({
      id: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Fast and capable',
      pool: 'sol',
      provider: 'azure',
      codex: true,
      thinking: 'reasoning',
      webSearch: 'web_search',
      vision: true,
      pdfPages: 100,
      default: true,
      title: true,
      rates: { in: 2, out: 10, cacheRead: 0.2 }
    }),
    model({
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: "OpenAI's most capable",
      pool: 'astra',
      provider: 'azure',
      codex: true,
      thinking: 'reasoning',
      webSearch: 'web_search',
      vision: true,
      pdfPages: 100,
      rates: { in: 10, out: 50, cacheRead: 1 }
    })
  ]
}

// Without a relay, only Claude (on this computer's own login).
function local(): Catalog {
  return {
    pools: BUILT_IN.pools.filter((p) => p.provider === 'anthropic'),
    models: BUILT_IN.models.filter((m) => m.provider === 'anthropic')
  }
}

export function catalog(): Catalog {
  if (!relayConfig()) return local()
  try {
    const stored = JSON.parse(db.appState.get(KEY) ?? '') as Catalog
    if (Array.isArray(stored.pools) && Array.isArray(stored.models)) return stored
  } catch {
    // never fetched
  }
  // The host's Claude never goes through the relay.
  return isGuest()
    ? BUILT_IN
    : {
        ...BUILT_IN,
        pools: BUILT_IN.pools.map((p) => ({ ...p, blocked: p.provider === 'anthropic' }))
      }
}

export async function refreshCatalog(): Promise<Catalog> {
  const relay = relayConfig()
  if (!relay) return local()
  const response = await fetch(`${relay.relay}/v1/me/models`, {
    headers: { authorization: `Bearer ${relay.token}` },
    signal: AbortSignal.timeout(10_000)
  })
  if (response.ok) {
    const fresh = (await response.json()) as Catalog
    if (Array.isArray(fresh.pools) && Array.isArray(fresh.models)) {
      db.appState.set(KEY, JSON.stringify(fresh))
    }
  }
  return catalog()
}

// The Codex models, and the one a new Codex tab starts on.
export function codexModels(): { ids: string[]; fallback: string } {
  const models = catalog().models.filter((m) => m.codex)
  const ids = models.map((m) => m.id)
  return { ids, fallback: models.find((m) => m.default)?.id ?? ids[0] ?? 'gpt-6-sol' }
}
