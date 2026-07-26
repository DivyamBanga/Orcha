import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { PlanLimit, PlanUsage } from '../shared/types'

// Real subscription limits, read from the same endpoint Claude Code's own
// `/usage` view calls, with the OAuth token the CLI already keeps in
// ~/.claude/.credentials.json. These are account-wide and authoritative:
// they include usage from claude.ai and other machines, which no amount of
// local transcript parsing can see.
const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const REFRESH_MIN_MS = 30_000
const BACKOFF_MS = 5 * 60_000

// Well-known limit keys, in display order. The endpoint returns null for any
// limit that doesn't apply to the plan (on Pro today only `five_hour` is
// populated), so nulls are skipped and a Pro -> Max upgrade makes the weekly
// bars appear on their own.
const NAMED_LIMITS: { key: string; label: string }[] = [
  { key: 'five_hour', label: 'Session' },
  { key: 'seven_day', label: 'Week' },
  { key: 'seven_day_opus', label: 'Week · Opus' },
  { key: 'seven_day_sonnet', label: 'Week · Sonnet' }
]

interface RawLimit {
  utilization?: number | null
  resets_at?: string | number | null
}

interface RawScopedLimit {
  kind?: string
  percent?: number | null
  resets_at?: string | number | null
  scope?: { model?: { display_name?: string } } | null
}

interface RawUsage {
  limits?: RawScopedLimit[]
  [key: string]: unknown
}

interface Credentials {
  accessToken: string
  subscriptionType: string | null
}

let cache: { limits: PlanLimit[]; plan: string | null; fetchedAt: number } | null = null
let backoffUntil = 0

function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; subscriptionType?: string }
    }
    const oauth = parsed.claudeAiOauth
    if (!oauth?.accessToken) return null
    return { accessToken: oauth.accessToken, subscriptionType: oauth.subscriptionType ?? null }
  } catch {
    return null
  }
}

// resets_at comes back as an ISO string today, but the CLI also handles a
// unix-seconds number, so accept both rather than depend on which one.
function parseResetsAt(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return value * 1000
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function normalize(raw: RawUsage): PlanLimit[] {
  const limits: PlanLimit[] = []

  for (const { key, label } of NAMED_LIMITS) {
    const entry = raw[key] as RawLimit | null | undefined
    if (!entry || typeof entry.utilization !== 'number') continue
    limits.push({
      key,
      label,
      utilization: entry.utilization,
      resetsAt: parseResetsAt(entry.resets_at)
    })
  }

  // Model-scoped weekly limits arrive only in the generic `limits` array
  // (this is how the CLI surfaces "Current week (Opus)"), so pick up any that
  // the named fields above didn't already cover.
  for (const entry of raw.limits ?? []) {
    const name = entry.scope?.model?.display_name
    if (entry.kind !== 'weekly_scoped' || !name || typeof entry.percent !== 'number') continue
    const key = `weekly_scoped:${name}`
    if (limits.some((l) => l.label === `Week · ${name}`)) continue
    limits.push({
      key,
      label: `Week · ${name}`,
      utilization: entry.percent,
      resetsAt: parseResetsAt(entry.resets_at)
    })
  }

  return limits
}

function fromCache(message: string): PlanUsage {
  if (!cache) return { status: 'unavailable', plan: null, limits: [], message }
  return { status: 'stale', plan: cache.plan, limits: cache.limits, message }
}

export async function fetchPlanUsage(): Promise<PlanUsage> {
  const credentials = readCredentials()
  if (!credentials) {
    return {
      status: 'no-auth',
      plan: null,
      limits: [],
      message: 'No Claude subscription login found — plan limits need `claude` to be signed in.'
    }
  }

  const now = Date.now()
  if (cache && now - cache.fetchedAt < REFRESH_MIN_MS) {
    return { status: 'ok', plan: cache.plan, limits: cache.limits, message: null }
  }
  if (now < backoffUntil) return fromCache('Usage endpoint is rate limited — showing last known.')

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    })
  } catch {
    return fromCache('Could not reach the usage endpoint — showing last known.')
  }

  if (response.status === 429) {
    backoffUntil = Date.now() + BACKOFF_MS
    return fromCache('Usage endpoint is rate limited — showing last known.')
  }
  if (response.status === 401) {
    // The CLI refreshes this token as it runs, so a 401 usually means the
    // login has gone stale rather than anything Orcha can fix.
    return fromCache('Claude login expired — run any Claude session to refresh it.')
  }
  if (!response.ok) return fromCache(`Usage endpoint returned ${response.status}.`)

  let raw: RawUsage
  try {
    raw = (await response.json()) as RawUsage
  } catch {
    return fromCache('Usage endpoint returned an unreadable response.')
  }

  const limits = normalize(raw)
  cache = { limits, plan: credentials.subscriptionType, fetchedAt: Date.now() }
  return { status: 'ok', plan: credentials.subscriptionType, limits, message: null }
}
