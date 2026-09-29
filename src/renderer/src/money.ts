import type { CreditPool, GuestBalance, GuestUsage, PoolBalance } from '../../shared/types'

// Money shown to a guest: always real dollars from the relay's ledger, two
// decimals, never rounded in the guest's favour.

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${n.toFixed(2)}`
}

// For tight spots (the sidebar): whole dollars once there's more than $10.
export function usdShort(n: number): string {
  return n >= 10 ? `$${Math.floor(n)}` : usd(n)
}

// The thresholds the host chose for warnings: a heads-up at 80% used, a
// stronger one at 95%, and blocked at the cap.
export type PoolLevel = 'ok' | 'low' | 'critical' | 'empty'

export function poolLevel(p: PoolBalance): PoolLevel {
  if (p.cap <= 0 || p.spent >= p.cap) return 'empty'
  const used = p.spent / p.cap
  if (used >= 0.95) return 'critical'
  if (used >= 0.8) return 'low'
  return 'ok'
}

// Quota isn't session state, so it stays neutral until it's worth noticing.
export function levelColors(level: PoolLevel): { text: string; fill: string } {
  if (level === 'empty' || level === 'critical') return { text: 'text-red-400', fill: 'bg-red-400' }
  if (level === 'low') return { text: 'text-wait', fill: 'bg-wait' }
  return { text: 'text-zinc-300', fill: 'bg-zinc-300' }
}

// Which budget a tab draws from.
export function poolFor(agent: 'claude' | 'codex', model: string | null): CreditPool {
  if (agent === 'claude') return 'claude'
  return model === 'gpt-6-astra' ? 'astra' : 'sol'
}

export function poolState(balance: GuestBalance | null, pool: CreditPool): PoolBalance | null {
  return balance?.pools.find((p) => p.pool === pool) ?? null
}

// What one tab has cost, summed over every pool it has drawn from.
export function sessionCost(balance: GuestBalance | null, workspaceId: string): number | null {
  if (!balance) return null
  const rows = balance.sessions.filter((s) => s.session === workspaceId)
  return rows.length === 0 ? null : rows.reduce((sum, s) => sum + s.cost, 0)
}

// "claude-sonnet-5-5-20260928" → "Sonnet 5.5", "gpt-6-astra" → "GPT-6 Astra".
export function modelName(id: string): string {
  const gpt = id.match(/^gpt-(\d+(?:\.\d+)?)-(\w+)/)
  if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}`
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/)
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1)
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  return id
}

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

const DAY_MS = 86_400_000

// Average daily spend over the last week, measured from the first spend in
// that window so a guest who started two days ago isn't told they're
// spending a seventh of what they are. Never extrapolates from less than a day.
export function perDay(usage: GuestUsage | null, pool: CreditPool, now: number): number {
  if (!usage) return 0
  const rows = usage.hourly.filter((h) => h.pool === pool && h.hour >= now - 7 * DAY_MS)
  if (rows.length === 0) return 0
  const total = rows.reduce((sum, h) => sum + h.cost, 0)
  const first = Math.min(...rows.map((h) => h.hour))
  return total / Math.max((now - first) / DAY_MS, 1)
}

// "About how long this budget lasts at the current pace", in words.
export function runway(left: number, dailySpend: number): string | null {
  if (left <= 0) return null
  if (dailySpend <= 0) return null
  const days = left / dailySpend
  if (days < 1) return `about ${Math.max(1, Math.round(days * 24))} hours left at this pace`
  if (days < 14)
    return `about ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} left at this pace`
  if (days < 60) return `about ${Math.round(days / 7)} weeks left at this pace`
  return 'months left at this pace'
}

// Local-time day buckets for the last `days` days, per pool, from hourly data.
export function dailyByPool(
  usage: GuestUsage | null,
  days: number,
  now: number
): { date: string; label: string; byPool: Record<CreditPool, number>; total: number }[] {
  const out: { date: string; label: string; byPool: Record<CreditPool, number>; total: number }[] =
    []
  const key = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const index = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * DAY_MS
    index.set(key(ts), out.length)
    out.push({
      date: key(ts),
      label: new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      byPool: { claude: 0, sol: 0, astra: 0 },
      total: 0
    })
  }
  for (const h of usage?.hourly ?? []) {
    const at = index.get(key(h.hour))
    if (at === undefined) continue
    out[at].byPool[h.pool] += h.cost
    out[at].total += h.cost
  }
  return out
}
