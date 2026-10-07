import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useAnimatedNumber } from '../motion'
import {
  dailyByPool,
  levelColors,
  modelName,
  perDay,
  poolLevel,
  runway,
  tokens,
  usd
} from '../money'
import Modal from './Modal'
import { Refresh } from './Icon'
import type { CreditPool, GuestUsage, PoolBalance } from '../../../shared/types'

// Neutral shades per budget, in budget order, for the stacked chart — budgets
// aren't session state, so they get tone, not colour.
const SHADES = [
  'bg-zinc-300',
  'bg-zinc-500',
  'bg-zinc-700',
  'bg-zinc-400',
  'bg-zinc-600',
  'bg-zinc-800'
]
const POOL_ORDER: Record<CreditPool, number> = { claude: 0, sol: 1, astra: 2 }
const shade = (pool: CreditPool): string => SHADES[(POOL_ORDER[pool] ?? 3) % SHADES.length]

function PoolCard({
  pool,
  usage,
  now
}: {
  pool: PoolBalance
  usage: GuestUsage | null
  now: number | null
}): React.JSX.Element {
  const level = poolLevel(pool)
  const colors = levelColors(level)
  const left = Math.max(pool.cap - pool.spent, 0)
  const shownLeft = useAnimatedNumber(left)
  const usedPct = pool.cap > 0 ? Math.min((pool.spent / pool.cap) * 100, 100) : 100
  const daily = now !== null ? perDay(usage, pool.pool, now) : 0
  const lasts = runway(left, daily)

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-[3px] ${shade(pool.pool)}`} />
          <span className="font-medium text-zinc-100">{pool.label}</span>
        </div>
        <div className="tnum">
          <span
            className={`text-[20px] font-semibold tracking-tight ${level === 'ok' ? 'text-zinc-50' : colors.text}`}
          >
            {usd(shownLeft)}
          </span>
          <span className="ml-1.5 text-[12px] text-zinc-500">left</span>
        </div>
      </div>
      <div className="meter mt-3">
        <div className={`meter-fill ${colors.fill}`} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="tnum mt-2.5 flex items-baseline justify-between text-[12px] text-zinc-500">
        <span>
          {usd(pool.spent)} used of {usd(pool.cap)}
        </span>
        <span>
          {level === 'empty'
            ? 'used up'
            : daily > 0
              ? `${usd(daily)}/day · ${lasts}`
              : usage
                ? 'no spend this week'
                : ''}
        </span>
      </div>
    </div>
  )
}

function DailyChart({
  usage,
  now,
  pools
}: {
  usage: GuestUsage
  now: number
  pools: CreditPool[]
}): React.JSX.Element {
  const days = dailyByPool(usage, 14, now)
  const max = Math.max(...days.map((d) => d.total), 0.01)
  // Stacked bottom-up in budget order.
  const stacked = [...pools].reverse()
  return (
    <div>
      <div className="flex h-20 items-end gap-[3px]">
        {days.map((d) => (
          <div
            key={d.date}
            className="group relative flex h-full flex-1 flex-col justify-end"
            title={`${d.label}: ${usd(d.total)}`}
          >
            {stacked.map((p) =>
              (d.byPool[p] ?? 0) > 0 ? (
                <div
                  key={p}
                  className={`w-full ${shade(p)} opacity-80 transition-opacity duration-150 first:rounded-t-[2px] group-hover:opacity-100`}
                  style={{ height: `${Math.max((d.byPool[p] / max) * 100, 2)}%` }}
                />
              ) : null
            )}
            {d.total === 0 && <div className="h-[2px] w-full rounded-full bg-overlay/[0.06]" />}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-600">
        <span>{days[0]?.label}</span>
        <span>today</span>
      </div>
    </div>
  )
}

function Breakdown({
  rows
}: {
  rows: { key: string; label: string; cost: number; note?: string }[]
}): React.JSX.Element {
  const max = Math.max(...rows.map((r) => r.cost), 0.0001)
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-[12.5px] text-zinc-300" title={r.label}>
            {r.label}
          </span>
          <div className="meter h-1 flex-1">
            <div className="meter-fill bg-zinc-500" style={{ width: `${(r.cost / max) * 100}%` }} />
          </div>
          <span className="tnum w-16 shrink-0 text-right text-[12px] text-zinc-400">
            {usd(r.cost)}
          </span>
          {r.note !== undefined && (
            <span className="tnum hidden w-24 shrink-0 text-right font-mono text-[10.5px] text-zinc-600 sm:block">
              {r.note}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// A guest's view of their credits: what's left in each budget, how fast it's
// going, and where it went. Every figure is the relay's own ledger — real
// dollars from real usage, the same numbers the budgets are enforced on.
function CreditsDashboard(): React.JSX.Element {
  const show = useStore((s) => s.showCredits)
  const setShow = useStore((s) => s.setShowCredits)
  const balance = useStore((s) => s.guestBalance)
  const usage = useStore((s) => s.guestUsage)
  const usageAt = useStore((s) => s.guestUsageAt)
  const workspaces = useStore((s) => s.workspaces)
  const projects = useStore((s) => s.projects)
  const [refreshing, setRefreshing] = useState(false)

  // Breakdowns are only fetched while this is open (they read more rows).
  useEffect(() => {
    if (!show) return
    const s = useStore.getState()
    const load = (): void => {
      s.loadGuestUsage().catch(() => {})
      s.loadGuestBalance(true).catch(() => {})
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [show])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    const s = useStore.getState()
    await Promise.all([s.loadGuestBalance(true), s.loadGuestUsage()]).catch(() => {})
    setRefreshing(false)
  }

  const projectRows = (() => {
    const totals = new Map<string, number>()
    for (const p of usage?.projects ?? [])
      totals.set(p.project, (totals.get(p.project) ?? 0) + p.cost)
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([project, cost]) => ({ key: project, label: project, cost }))
  })()

  const modelRows = (usage?.models ?? []).slice(0, 6).map((m) => ({
    key: `${m.pool}:${m.model}`,
    label: modelName(m.model),
    cost: m.cost,
    note: `${tokens(m.input + m.cached)} in · ${tokens(m.output)} out`
  }))

  const tabRows = (balance?.sessions ?? [])
    .reduce<{ session: string; cost: number; updatedAt: number }[]>((acc, s) => {
      const row = acc.find((r) => r.session === s.session)
      if (row) {
        row.cost += s.cost
        row.updatedAt = Math.max(row.updatedAt, s.updatedAt)
      } else acc.push({ session: s.session, cost: s.cost, updatedAt: s.updatedAt })
      return acc
    }, [])
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((r) => {
      const w = workspaces.find((x) => x.id === r.session)
      const project = w ? projects.find((p) => p.id === w.projectId)?.name : null
      const label =
        r.session === 'mission-control'
          ? 'Mission Control'
          : w
            ? `${project ?? w.name} · ${w.kind === 'main' ? 'main' : w.name}`
            : 'Closed tab'
      return { key: r.session, label, cost: r.cost }
    })

  return (
    <Modal open={show} onClose={() => setShow(false)} width={540}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold tracking-tight text-zinc-50">Credits</div>
          {balance && (
            <div className="text-[12px] text-zinc-500">Shared with you by {balance.hostName}</div>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="btn btn-ghost btn-icon text-zinc-500"
          title={
            balance ? `Updated ${new Date(balance.fetchedAt).toLocaleTimeString()}` : 'Refresh'
          }
        >
          <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
            <Refresh size={14} />
          </span>
        </button>
      </div>

      {balance?.error && (
        <div className="mb-3 rounded-lg border border-edge bg-surface-2/60 px-3 py-2 text-[12px] text-zinc-400">
          {balance.error} Showing the last known numbers.
        </div>
      )}
      {balance?.status === 'revoked' && (
        <div className="mb-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-[12px] text-red-300">
          {balance.hostName} has turned off access to these credits.
        </div>
      )}

      {!balance || balance.pools.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[12px] text-zinc-500">
          <span className="busy-ring" /> Loading your credits…
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {balance.pools.map((p) => (
            <PoolCard key={p.pool} pool={p} usage={usage} now={usageAt} />
          ))}
        </div>
      )}

      {usage && usageAt !== null && (
        <div className="fade-late">
          <div className="mt-6 mb-2.5 flex items-center justify-between">
            <span className="eyebrow">Last 14 days</span>
            <span className="flex gap-3 text-[11px] text-zinc-500">
              {(balance?.pools ?? []).map(({ pool: p }) => (
                <span key={p} className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-[2px] ${shade(p)}`} />
                  {balance?.pools.find((x) => x.pool === p)?.label ?? p}
                </span>
              ))}
            </span>
          </div>
          <DailyChart
            usage={usage}
            now={usageAt}
            pools={(balance?.pools ?? []).map((p) => p.pool)}
          />

          {projectRows.length > 0 && (
            <>
              <div className="eyebrow mt-6 mb-2.5">By project · 14 days</div>
              <Breakdown rows={projectRows} />
            </>
          )}
          {modelRows.length > 0 && (
            <>
              <div className="eyebrow mt-6 mb-2.5">By model · 14 days</div>
              <Breakdown rows={modelRows} />
            </>
          )}
          {tabRows.length > 0 && (
            <>
              <div className="eyebrow mt-6 mb-2.5">Recent tabs</div>
              <Breakdown rows={tabRows} />
            </>
          )}
        </div>
      )}

      <p className="mt-6 text-[11.5px] leading-relaxed text-zinc-600">
        Exact dollars from each provider&apos;s own usage reports. A reply you interrupt is billed
        for what was already generated.
      </p>
    </Modal>
  )
}

export default CreditsDashboard
