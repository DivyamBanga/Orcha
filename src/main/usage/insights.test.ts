import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { NO_USAGE } from '../chat/provider'
import { computeInsights, tierOf, type KnownProject } from './insights'
import { record, recordScanned, type UsageInput } from './ledger'
import { seedPrices } from './pricing'
import { initUsageTables } from './sources'
import type { PlanLimit } from '../../shared/types'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 22, 18)

function ledger(): Database.Database {
  const db = new Database(':memory:')
  initUsageTables(db)
  seedPrices(db)
  return db
}

// One Opus 5.5 call on the Max plan with 1M output tokens ($20 at list price).
const plan = (over: Partial<UsageInput> = {}): UsageInput => ({
  ...NO_USAGE,
  at: NOW - HOUR,
  route: 'plan',
  keyId: null,
  model: 'claude-opus-5-5',
  spec: null,
  surface: 'claude-code',
  projectId: 'p1',
  chatId: null,
  sessionId: null,
  images: 0,
  audioSeconds: 0,
  durationMs: null,
  ttftMs: null,
  incognito: false,
  output: 1_000_000,
  ...over
})

const known = new Map<string, KnownProject>([['p1', { name: 'Orcha', repoPath: 'C:/work/orcha' }]])
const session = (utilization: number): PlanLimit => ({
  key: 'five_hour',
  label: 'Session',
  utilization,
  resetsAt: NOW + 2 * HOUR
})

describe('model tiers', () => {
  it('names the family', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('claude-fable-5-1')).toBe('fable')
    expect(tierOf('gpt-6-sol')).toBe('gpt')
    expect(tierOf('llama3')).toBe('other')
  })
})

describe('usage insights', () => {
  it('counts plan value only: not billed calls, not Codex', () => {
    const db = ledger()
    record(db, plan())
    record(db, plan({ route: 'api', keyId: 'k' }))
    record(db, plan({ surface: 'codex' }))
    const insights = computeInsights(db, null, known, NOW)
    expect(insights.weekCostUsd).toBeCloseTo(20, 6)
    expect(insights.monthlyProjectionUsd).toBeCloseTo((20 / 7) * 30, 6)
    expect(insights.daily).toHaveLength(14)
    expect(insights.daily.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(20, 6)
  })

  it('splits the window by project and model, with lumps for the rest', () => {
    const db = ledger()
    record(db, plan())
    record(db, plan({ model: 'claude-sonnet-5-5', projectId: null, output: 500_000 }))
    record(db, plan({ surface: 'chat', projectId: null, output: 100_000 }))
    const { projects, models, windowCostUsd } = computeInsights(db, session(30), known, NOW)
    expect(projects.map((p) => p.name)).toEqual(['Orcha', 'Other folders', 'Chats'])
    expect(projects[0].cwd).toBe('C:/work/orcha')
    expect(projects.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 6)
    expect(models.map((m) => m.tier)).toEqual(['opus', 'sonnet'])
    expect(windowCostUsd).toBeGreaterThan(20)
  })

  it('falls back to the week when the window is empty', () => {
    const db = ledger()
    record(db, plan({ at: NOW - 30 * HOUR }))
    const insights = computeInsights(db, session(0), known, NOW)
    expect(insights.windowCostUsd).toBe(0)
    expect(insights.projects.map((p) => p.name)).toEqual(['Orcha'])
  })

  it('projects the burn from the share of the window spent in the last half hour', () => {
    const db = ledger()
    record(db, plan({ at: NOW - 2 * HOUR }))
    record(db, plan({ at: NOW - 10 * 60_000 }))
    const burn = computeInsights(db, session(40), known, NOW).burn
    // Half the window's spend was recent: 20% of quota in half an hour.
    expect(burn?.pctPerHour).toBeCloseTo(40, 6)
    expect(burn?.reachesReset).toBe(false)
  })

  it('reports how much of the prompt came from cache', () => {
    const db = ledger()
    recordScanned(db, {
      ...plan({ input: 100, cacheRead: 700, cacheWrite5m: 100, output: 1 }),
      costUsd: null,
      costKind: 'plan',
      priceId: null,
      key: 'k',
      cwd: null,
      speed: null
    })
    expect(computeInsights(db, null, known, NOW).cacheHitRate).toBeCloseTo(0.78, 2)
    expect(computeInsights(ledger(), null, known, NOW).cacheHitRate).toBeNull()
  })
})
