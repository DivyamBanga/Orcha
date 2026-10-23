import type { Catalog, CatalogModel } from '../shared/types'

// The models this Orcha offers: Claude, on this computer's own Claude plan.

const model = (m: Omit<CatalogModel, 'chat'> & { chat?: boolean }): CatalogModel => ({
  chat: true,
  ...m
})

const CLAUDE: Catalog = {
  pools: [{ id: 'claude', label: 'Claude', order: 0, provider: 'anthropic' }],
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
    })
  ]
}

export function catalog(): Catalog {
  return CLAUDE
}

// The Codex models, and the one a new Codex tab starts on.
export function codexModels(): { ids: string[]; fallback: string } {
  const models = catalog().models.filter((m) => m.codex)
  const ids = models.map((m) => m.id)
  return { ids, fallback: models.find((m) => m.default)?.id ?? ids[0] ?? 'gpt-6-sol' }
}
