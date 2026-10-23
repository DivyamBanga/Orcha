import type Database from 'better-sqlite3'
import type {
  BurnRate,
  DailyUsagePoint,
  ModelUsage,
  PlanLimit,
  ProjectUsage,
  UsageInsights
} from '../../shared/types'

// The numbers behind the usage dashboard's "what is burning it" part, read
// from the ledger. They answer what is using the Max plan's limits, so they
// count the plan's calls only (Claude Code tabs and chats on the Max plan):
// their dollars are plan value, what the same calls would cost at list price,
// never money spent. Codex runs on a ChatGPT plan, which is a different quota,
// so it isn't here.

type Db = Database.Database

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_WINDOW_DAYS = 14
const PROJECTS_SHOWN = 5
// How far back "burn rate right now" looks. Long enough to survive the gap
// between two turns, short enough to react when you stop or switch models.
const RECENT_MS = 30 * 60 * 1000

const PLAN_CALLS = "cost_kind = 'plan' AND surface <> 'codex'"

export interface KnownProject {
  name: string
  repoPath: string
}

// "opus", "sonnet", "fable"...: the family part of a model's id.
export function tierOf(model: string): string {
  const claude = /claude-([a-z]+)/.exec(model)
  if (claude) return claude[1]
  return model.startsWith('gpt') ? 'gpt' : 'other'
}

function costBetween(db: Db, from: number, to: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events
       WHERE ${PLAN_CALLS} AND at >= ? AND at < ?`
    )
    .get(from, to) as { usd: number }
  return row.usd
}

function withShares<T extends { costUsd: number }>(rows: T[]): (T & { share: number })[] {
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0)
  return rows.map((r) => ({ ...r, share: total > 0 ? r.costUsd / total : 0 }))
}

// Orcha projects by name. Calls that belong to no Orcha project are lumped as
// "Chats" (the chat engine's own) or "Other folders" (Claude Code run
// somewhere Orcha doesn't know), because the ledger keeps no folder paths.
function computeProjects(
  db: Db,
  known: Map<string, KnownProject>,
  from: number,
  to: number
): ProjectUsage[] {
  const rows = db
    .prepare(
      `SELECT project_id, surface = 'chat' AS chat, SUM(cost_usd) AS usd FROM usage_events
       WHERE ${PLAN_CALLS} AND at >= ? AND at < ? AND cost_usd IS NOT NULL
       GROUP BY project_id, chat`
    )
    .all(from, to) as { project_id: string | null; chat: number; usd: number }[]
  // The dashboard keys its rows by cwd, so a lump gets its name in place of one.
  const byCwd = new Map<string, { cwd: string; name: string; costUsd: number }>()
  for (const r of rows) {
    const project = r.project_id ? known.get(r.project_id) : undefined
    const name = project?.name ?? (r.chat ? 'Chats' : 'Other folders')
    const cwd = project?.repoPath ?? name
    const held = byCwd.get(cwd)
    if (held) held.costUsd += r.usd
    else byCwd.set(cwd, { cwd, name, costUsd: r.usd })
  }
  return withShares([...byCwd.values()])
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, PROJECTS_SHOWN)
}

function computeModels(db: Db, from: number, to: number): ModelUsage[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(spec, model) AS model, SUM(cost_usd) AS usd FROM usage_events
       WHERE ${PLAN_CALLS} AND at >= ? AND at < ? AND cost_usd IS NOT NULL GROUP BY model`
    )
    .all(from, to) as { model: string; usd: number }[]
  const byTier = new Map<string, number>()
  for (const r of rows) byTier.set(tierOf(r.model), (byTier.get(tierOf(r.model)) ?? 0) + r.usd)
  return withShares([...byTier].map(([tier, costUsd]) => ({ tier, costUsd }))).sort(
    (a, b) => b.costUsd - a.costUsd
  )
}

// Share of prompt tokens that came from cache rather than being re-read at
// full price. High reuse is why a long session costs far less than its token
// count suggests; a sudden drop means the context keeps being invalidated.
function computeCacheHitRate(db: Db, from: number, to: number): number | null {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cache_read), 0) AS cached,
              COALESCE(SUM(input + cache_write_5m + cache_write_1h + cache_write), 0) AS fresh
       FROM usage_events WHERE ${PLAN_CALLS} AND at >= ? AND at < ?`
    )
    .get(from, to) as { cached: number; fresh: number }
  const total = row.cached + row.fresh
  return total > 0 ? row.cached / total : null
}

// The quota isn't denominated in dollars, so the dollar figure is calibrated
// against the real utilization each window: whatever fraction of the window's
// spend happened in the last 30 minutes maps onto the same fraction of real
// quota percent. Usage from another device inflates the rate rather than
// hiding it, so the projection errs toward warning early.
function computeBurn(
  session: PlanLimit,
  windowStart: number,
  windowCost: number,
  recentCost: number,
  now: number
): BurnRate | null {
  if (session.resetsAt === null) return null

  let pctPerHour: number
  if (windowCost > 0 && recentCost > 0) {
    const pctPerUsd = session.utilization / windowCost
    pctPerHour = (recentCost * pctPerUsd) / (RECENT_MS / 3_600_000)
  } else {
    // No local activity to calibrate against (idle, or driven from elsewhere)
    // — fall back to the window's average using only the API's own numbers.
    const elapsedHours = (now - windowStart) / 3_600_000
    pctPerHour = elapsedHours > 0 ? session.utilization / elapsedHours : 0
  }

  const remaining = Math.max(100 - session.utilization, 0)
  if (pctPerHour <= 0 || remaining <= 0) {
    return { pctPerHour, hitsLimitAt: null, reachesReset: remaining > 0 }
  }
  const hitsLimitAt = now + (remaining / pctPerHour) * 3_600_000
  return { pctPerHour, hitsLimitAt, reachesReset: hitsLimitAt >= session.resetsAt }
}

function localDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

// Last 14 days, zero-filled so the chart has a stable x-axis. Days are cut at
// local midnight, in the same clock the chart's labels use.
function computeDaily(db: Db, now: number): DailyUsagePoint[] {
  const rows = db
    .prepare(
      `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS usd
       FROM usage_events WHERE ${PLAN_CALLS} AND at >= ? AND at < ? GROUP BY day`
    )
    .all(now - (DAILY_WINDOW_DAYS + 1) * DAY_MS, now + 1) as { day: string; usd: number }[]
  const byDay = new Map(rows.map((r) => [r.day, r.usd]))
  const points: DailyUsagePoint[] = []
  for (let i = DAILY_WINDOW_DAYS - 1; i >= 0; i--) {
    const date = localDateKey(now - i * DAY_MS)
    points.push({ date, costUsd: byDay.get(date) ?? 0 })
  }
  return points
}

export function computeInsights(
  db: Db,
  session: PlanLimit | null,
  known: Map<string, KnownProject>,
  now: number = Date.now()
): UsageInsights {
  // Anchor attribution to the real session window when the API gives us one,
  // so "what's burning it" lines up exactly with the percentage shown.
  const windowStart =
    session?.resetsAt != null ? session.resetsAt - FIVE_HOURS_MS : now - FIVE_HOURS_MS
  const windowCostUsd = costBetween(db, windowStart, now + 1)
  const weekCostUsd = costBetween(db, now - WEEK_MS, now + 1)

  // Fall back to the week when the current window is empty, so the breakdown
  // still says something useful on a fresh window.
  const from = windowCostUsd > 0 ? windowStart : now - WEEK_MS
  return {
    projects: computeProjects(db, known, from, now + 1),
    models: computeModels(db, from, now + 1),
    cacheHitRate: computeCacheHitRate(db, now - WEEK_MS, now + 1),
    burn: session
      ? computeBurn(
          session,
          windowStart,
          windowCostUsd,
          costBetween(db, Math.max(windowStart, now - RECENT_MS), now + 1),
          now
        )
      : null,
    windowCostUsd,
    weekCostUsd,
    monthlyProjectionUsd: (weekCostUsd / 7) * 30,
    daily: computeDaily(db, now)
  }
}
