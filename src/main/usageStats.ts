import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { estimateCostUsd } from './claudeSessions'
import { fetchPlanUsage } from './planUsage'
import type {
  UsageSummary,
  UsageInsights,
  ProjectUsage,
  ModelUsage,
  DailyUsagePoint,
  BurnRate,
  PlanLimit
} from '../shared/types'

// Everything here is derived from local ~/.claude/projects transcripts, so it
// only sees Claude Code runs on this machine. It answers "what is burning the
// quota", never "how much quota is left" — that comes from planUsage.ts.
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_WINDOW_DAYS = 14
// How far back "burn rate right now" looks. Long enough to survive the gap
// between two turns, short enough to react when you stop or switch models.
const RECENT_MS = 30 * 60 * 1000

interface UsageEvent {
  timestamp: number
  cwd: string
  tier: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  uid: string | null
}

interface FileCacheEntry {
  size: number
  mtimeMs: number
  events: UsageEvent[]
}

// Keyed by transcript file path; re-parsed only when size/mtime change so
// repeated polls stay cheap — in steady state only the 1-2 currently-active
// session files have actually changed.
const fileCache = new Map<string, FileCacheEntry>()

function modelTier(model: string | null | undefined): string | null {
  if (!model) return null
  if (model.includes('opus')) return 'opus'
  if (model.includes('sonnet')) return 'sonnet'
  if (model.includes('haiku')) return 'haiku'
  return null
}

function allTranscriptFiles(): string[] {
  if (!existsSync(PROJECTS_ROOT)) return []
  const files: string[] = []
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const dirPath = join(PROJECTS_ROOT, dir)
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      continue
    }
    for (const f of entries) {
      if (f.endsWith('.jsonl')) files.push(join(dirPath, f))
    }
  }
  return files
}

function parseFile(path: string): UsageEvent[] {
  const events: UsageEvent[] = []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return events
  }
  for (const line of raw.trim().split('\n')) {
    // Most lines are tool results, often tens of KB each; only assistant
    // turns carry a usage block, so skip the JSON.parse for the rest. The
    // active transcript is re-read on every poll, so this is not just a
    // cold-start saving.
    if (!line || !line.includes('"usage"')) continue
    let entry: {
      timestamp?: string
      cwd?: string
      requestId?: string
      message?: { id?: string; model?: string; usage?: Record<string, number> }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry.message?.usage
    if (!usage || !entry.timestamp || !entry.cwd) continue
    const timestamp = Date.parse(entry.timestamp)
    if (Number.isNaN(timestamp)) continue
    const tier = modelTier(entry.message?.model)
    if (!tier) continue
    const tokens = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0
    }
    const costUsd = estimateCostUsd(tier, tokens, timestamp)
    if (costUsd === null) continue
    const messageId = entry.message?.id
    events.push({
      timestamp,
      cwd: entry.cwd,
      tier,
      costUsd,
      ...tokens,
      uid: messageId && entry.requestId ? `${messageId}:${entry.requestId}` : null
    })
  }
  return events
}

// Every usage event on this machine that's recent enough to show, ascending
// by time. Two things keep this honest and cheap:
//   - transcripts last written before the oldest window we display can't hold
//     an event inside it, so they're never opened (most of the corpus)
//   - resuming a conversation copies earlier turns into the new transcript,
//     so identical (message id, request id) pairs are counted once — without
//     this, totals roughly double
function allEvents(): UsageEvent[] {
  const events: UsageEvent[] = []
  const seen = new Set<string>()
  const cutoff = Date.now() - (DAILY_WINDOW_DAYS + 1) * DAY_MS
  for (const path of allTranscriptFiles()) {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.mtimeMs < cutoff) continue
    const cached = fileCache.get(path)
    let parsed: UsageEvent[]
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      parsed = cached.events
    } else {
      parsed = parseFile(path)
      fileCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, events: parsed })
    }
    for (const event of parsed) {
      if (event.uid) {
        if (seen.has(event.uid)) continue
        seen.add(event.uid)
      }
      events.push(event)
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp)
  return events
}

function sumCost(events: UsageEvent[]): number {
  return events.reduce((total, e) => total + e.costUsd, 0)
}

function computeProjects(events: UsageEvent[]): ProjectUsage[] {
  const totals = new Map<string, number>()
  for (const e of events) totals.set(e.cwd, (totals.get(e.cwd) ?? 0) + e.costUsd)
  const total = sumCost(events)
  return [...totals.entries()]
    .map(([cwd, costUsd]) => ({
      cwd,
      name: basename(cwd),
      costUsd,
      share: total > 0 ? costUsd / total : 0
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5)
}

function computeModels(events: UsageEvent[]): ModelUsage[] {
  const totals = new Map<string, number>()
  for (const e of events) totals.set(e.tier, (totals.get(e.tier) ?? 0) + e.costUsd)
  const total = sumCost(events)
  return [...totals.entries()]
    .map(([tier, costUsd]) => ({ tier, costUsd, share: total > 0 ? costUsd / total : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

// Share of prompt tokens that came from cache rather than being re-read at
// full price. High reuse is why a long session costs far less than its token
// count suggests; a sudden drop means the context keeps being invalidated.
function computeCacheHitRate(events: UsageEvent[]): number | null {
  let cached = 0
  let fresh = 0
  for (const e of events) {
    cached += e.cacheReadTokens
    fresh += e.inputTokens + e.cacheCreationTokens
  }
  const total = cached + fresh
  return total > 0 ? cached / total : null
}

// The quota isn't denominated in dollars, so the local dollar figure is
// calibrated against the real utilization each window: whatever fraction of
// the window's local spend happened in the last 30 minutes maps onto the same
// fraction of real quota percent. Usage from another device inflates the rate
// rather than hiding it, so the projection errs toward warning early.
function computeBurn(
  session: PlanLimit,
  windowStart: number,
  windowEvents: UsageEvent[],
  now: number
): BurnRate | null {
  if (session.resetsAt === null) return null

  const windowCost = sumCost(windowEvents)
  const recentCost = sumCost(windowEvents.filter((e) => e.timestamp >= now - RECENT_MS))

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

// Last 14 days, zero-filled so the chart has a stable x-axis.
function computeDaily(events: UsageEvent[], now: number): DailyUsagePoint[] {
  const cutoff = now - DAILY_WINDOW_DAYS * DAY_MS
  const totals = new Map<string, number>()
  for (const e of events) {
    if (e.timestamp < cutoff) continue
    const key = localDateKey(e.timestamp)
    totals.set(key, (totals.get(key) ?? 0) + e.costUsd)
  }
  const points: DailyUsagePoint[] = []
  for (let i = DAILY_WINDOW_DAYS - 1; i >= 0; i--) {
    const key = localDateKey(now - i * DAY_MS)
    points.push({ date: key, costUsd: totals.get(key) ?? 0 })
  }
  return points
}

export async function computeUsageSummary(force = false): Promise<UsageSummary> {
  const plan = await fetchPlanUsage(force)
  const events = allEvents()
  const now = Date.now()

  // Anchor attribution to the real session window when the API gives us one,
  // so "what's burning it" lines up exactly with the percentage shown.
  const session = plan.limits.find((l) => l.key === 'five_hour') ?? null
  const windowStart =
    session?.resetsAt != null ? session.resetsAt - FIVE_HOURS_MS : now - FIVE_HOURS_MS
  const windowEvents = events.filter((e) => e.timestamp >= windowStart)
  const weekEvents = events.filter((e) => e.timestamp >= now - WEEK_MS)

  // Fall back to the week when the current window is empty, so the breakdown
  // still says something useful on a fresh window.
  const attributed = windowEvents.length > 0 ? windowEvents : weekEvents
  const weekCostUsd = sumCost(weekEvents)

  const insights: UsageInsights = {
    projects: computeProjects(attributed),
    models: computeModels(attributed),
    cacheHitRate: computeCacheHitRate(weekEvents),
    burn: session ? computeBurn(session, windowStart, windowEvents, now) : null,
    windowCostUsd: sumCost(windowEvents),
    weekCostUsd,
    monthlyProjectionUsd: (weekCostUsd / 7) * 30,
    daily: computeDaily(events, now)
  }

  return { plan, insights, fetchedAt: now }
}
