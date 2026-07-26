import { useStore } from '../store'
import { percentColors } from '../usageColors'

function Ring({ percent }: { percent: number }): React.JSX.Element {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const filled = Math.min(Math.max(percent, 0), 100) / 100
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90 shrink-0">
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-edge-bright" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className={percentColors(percent).stroke}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - filled)}
      />
    </svg>
  )
}

function shortDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

// Always-visible sidebar widget: the real session-window percentage as a ring
// that fills and shifts color toward the cap, plus time to reset. Clicking
// opens UsageDashboard.
function UsageGlance(): React.JSX.Element | null {
  const summary = useStore((s) => s.usageSummary)
  const fetchedAt = useStore((s) => s.usageSummaryFetchedAt)
  const setShow = useStore((s) => s.setShowUsageDashboard)

  const session = summary?.plan.limits.find((l) => l.key === 'five_hour')
  if (!session) return null

  const percent = Math.floor(session.utilization)
  const stale = summary?.plan.status === 'stale'

  return (
    <button
      onClick={() => setShow(true)}
      className={`flex items-center gap-1.5 rounded px-1.5 py-1 font-mono text-[11px] hover:bg-surface-2 ${
        stale ? 'opacity-50' : ''
      }`}
      title={`Session window ${percent}% used${stale ? ' (last known)' : ''} — click for details`}
    >
      <Ring percent={session.utilization} />
      <span className={percentColors(session.utilization).text}>{percent}%</span>
      {session.resetsAt !== null && fetchedAt !== null && (
        <span className="text-zinc-600">{shortDuration(session.resetsAt - fetchedAt)}</span>
      )}
    </button>
  )
}

export default UsageGlance
