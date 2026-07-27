import { useState } from 'react'
import { useStore } from '../store'
import { percentColors } from '../usageColors'
import { Refresh } from './Icon'
import type {
  PlanLimit,
  PlanUsage,
  ProjectUsage,
  ModelUsage,
  DailyUsagePoint,
  BurnRate
} from '../../../shared/types'

function formatUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="font-mono text-[11px] uppercase tracking-wide text-zinc-600">{children}</div>
  )
}

function LimitBar({ limit, now }: { limit: PlanLimit; now: number | null }): React.JSX.Element {
  const colors = percentColors(limit.utilization)
  const width = Math.min(Math.max(limit.utilization, 0), 100)
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-500">
          {limit.label}
        </span>
        <span className={`font-mono text-[12px] ${colors.text}`}>
          {Math.floor(limit.utilization)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${colors.bg}`} style={{ width: `${width}%` }} />
      </div>
      {limit.resetsAt !== null && now !== null && (
        <div className="mt-1 text-right font-mono text-[11px] text-zinc-600">
          resets in {formatDuration(limit.resetsAt - now)}
        </div>
      )}
    </div>
  )
}

// The one actionable line: whether the current pace runs out the window before
// it resets. Rate is calibrated locally, so it's a projection, not a promise.
function BurnLine({
  burn,
  session,
  now
}: {
  burn: BurnRate
  session: PlanLimit
  now: number
}): React.JSX.Element {
  if (burn.pctPerHour <= 0) {
    return <div className="mb-3 text-[12px] text-zinc-600">No usage yet this window</div>
  }

  const rate = `${burn.pctPerHour.toFixed(burn.pctPerHour < 10 ? 1 : 0)}%/hr`
  if (burn.hitsLimitAt === null || burn.reachesReset) {
    return (
      <div className="mb-3 text-[12px] text-zinc-500">
        <span className="text-zinc-300">{rate}</span> · won&apos;t hit 100% before reset
      </div>
    )
  }
  const early = session.resetsAt !== null ? session.resetsAt - burn.hitsLimitAt : 0
  return (
    <div className="mb-3 text-[12px] text-zinc-500">
      <span className="text-amber-500">{rate}</span> · hits 100% in{' '}
      <span className="text-zinc-300">{formatDuration(burn.hitsLimitAt - now)}</span>
      {early > 0 && `, ${formatDuration(early)} before reset`}
    </div>
  )
}

function ProjectBars({ projects }: { projects: ProjectUsage[] }): React.JSX.Element | null {
  if (projects.length === 0) return null
  const max = Math.max(...projects.map((p) => p.share), 0.01)
  return (
    <div className="flex flex-col gap-1">
      {projects.map((p) => (
        <div key={p.cwd} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-[12px] text-zinc-400" title={p.cwd}>
            {p.name}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-zinc-600"
              style={{ width: `${(p.share / max) * 100}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-zinc-500">
            {Math.round(p.share * 100)}%
          </span>
        </div>
      ))}
    </div>
  )
}

function ModelMix({
  models,
  cacheHitRate
}: {
  models: ModelUsage[]
  cacheHitRate: number | null
}): React.JSX.Element | null {
  if (models.length === 0 && cacheHitRate === null) return null
  return (
    <div className="mt-2 flex items-baseline justify-between font-mono text-[11px] text-zinc-500">
      <span>
        {models.map((m, i) => (
          <span key={m.tier}>
            {i > 0 && <span className="text-zinc-700"> · </span>}
            <span className="capitalize text-zinc-400">{m.tier}</span> {Math.round(m.share * 100)}%
          </span>
        ))}
      </span>
      {cacheHitRate !== null && <span>cache {Math.round(cacheHitRate * 100)}%</span>}
    </div>
  )
}

function DailyChart({ data }: { data: DailyUsagePoint[] }): React.JSX.Element {
  const width = 384
  const height = 40
  const gap = 2
  const barWidth = width / data.length - gap
  const max = Math.max(...data.map((d) => d.costUsd), 0.01)
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="text-zinc-500">
      {data.map((d, i) => {
        const h = d.costUsd > 0 ? Math.max((d.costUsd / max) * height, 2) : 0
        return (
          <rect
            key={d.date}
            x={i * (barWidth + gap)}
            y={height - h}
            width={barWidth}
            height={h}
            fill="currentColor"
            opacity={0.7}
            rx={1}
          >
            <title>
              {d.date}: {formatUsd(d.costUsd)}
            </title>
          </rect>
        )
      })}
    </svg>
  )
}

function PlanNotice({ plan }: { plan: PlanUsage }): React.JSX.Element | null {
  if (plan.status === 'ok' || plan.message === null) return null
  return (
    <div className="mb-3 rounded-md border border-edge bg-surface-2/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-500">
      {plan.message}
    </div>
  )
}

// Opened by clicking UsageGlance. Real plan limits up top (from Anthropic's
// own usage endpoint, so they cover every device and claude.ai), then local
// transcript-derived attribution for what's consuming them.
function UsageDashboard(): React.JSX.Element | null {
  const show = useStore((s) => s.showUsageDashboard)
  const setShow = useStore((s) => s.setShowUsageDashboard)
  const summary = useStore((s) => s.usageSummary)
  const now = useStore((s) => s.usageSummaryFetchedAt)
  const loadUsageSummary = useStore((s) => s.loadUsageSummary)
  const [refreshing, setRefreshing] = useState(false)

  if (!show) return null
  const onClose = (): void => setShow(false)

  // Forces past the main process's short refresh cache, so this re-reads the
  // credentials file (plan changes) and re-asks the endpoint (new window
  // after a reset) rather than replaying what it already had.
  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await loadUsageSummary(true)
    } finally {
      setRefreshing(false)
    }
  }

  const session = summary?.plan.limits.find((l) => l.key === 'five_hour') ?? null
  const insights = summary?.insights
  const attributionLabel =
    (insights?.windowCostUsd ?? 0) > 0 ? 'this session window' : 'last 7 days'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[26rem] rounded-lg border border-edge-bright bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="font-medium text-zinc-100">Usage</span>
          <span className="flex items-center gap-2">
            {summary?.plan.plan && (
              <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-500">
                {summary.plan.plan} plan
              </span>
            )}
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded p-1 leading-none text-zinc-500 hover:bg-surface-2 hover:text-zinc-300 disabled:hover:bg-transparent"
              title={
                now !== null
                  ? `Refresh — updated ${new Date(now).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit'
                    })}`
                  : 'Refresh'
              }
            >
              <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`}>
                <Refresh size={14} />
              </span>
            </button>
          </span>
        </div>

        {!summary ? (
          <div className="font-mono text-[12px] text-zinc-600">Loading…</div>
        ) : (
          <>
            <PlanNotice plan={summary.plan} />

            {summary.plan.limits.map((limit) => (
              <LimitBar key={limit.key} limit={limit} now={now} />
            ))}

            {insights?.burn && session && now !== null && (
              <BurnLine burn={insights.burn} session={session} now={now} />
            )}

            {insights && insights.projects.length > 0 && (
              <div className="mb-4 border-t border-edge pt-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <Label>What&apos;s burning it</Label>
                  <span className="font-mono text-[10px] text-zinc-700">
                    {attributionLabel} · this machine
                  </span>
                </div>
                <ProjectBars projects={insights.projects} />
                <ModelMix models={insights.models} cacheHitRate={insights.cacheHitRate} />
              </div>
            )}

            {insights && (
              <div className="mb-4 border-t border-edge pt-3">
                <Label>If this were the API</Label>
                <div className="mt-1.5 flex items-baseline justify-between">
                  <span className="text-[12px] text-zinc-400">
                    Last 7 days{' '}
                    <span className="font-mono text-zinc-200">
                      {formatUsd(insights.weekCostUsd)}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-zinc-500">
                    ≈ {formatUsd(insights.monthlyProjectionUsd)}/mo at this rate
                  </span>
                </div>
              </div>
            )}

            {insights && (
              <>
                <Label>Last 14 days</Label>
                <div className="mt-1">
                  <DailyChart data={insights.daily} />
                </div>
              </>
            )}
          </>
        )}

        <div className="mt-3 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-surface-2"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default UsageDashboard
