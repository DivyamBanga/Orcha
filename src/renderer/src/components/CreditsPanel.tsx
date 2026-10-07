import { useStore } from '../store'
import { useAnimatedNumber } from '../motion'
import { levelColors, poolLevel, usd } from '../money'
import type { PoolBalance } from '../../../shared/types'

function Row({ pool }: { pool: PoolBalance }): React.JSX.Element {
  const level = poolLevel(pool)
  const colors = levelColors(level)
  const left = Math.max(pool.cap - pool.spent, 0)
  const shown = useAnimatedNumber(left)
  const usedPct = pool.cap > 0 ? Math.min((pool.spent / pool.cap) * 100, 100) : 100
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-zinc-400">{pool.label}</span>
        <span className={`tnum font-medium ${level === 'ok' ? 'text-zinc-200' : colors.text}`}>
          {level === 'empty' ? 'used up' : usd(shown)}
        </span>
      </div>
      <div className="meter mt-1.5 h-[3px]">
        <div className={`meter-fill ${colors.fill}`} style={{ width: `${usedPct}%` }} />
      </div>
    </div>
  )
}

// Always-visible budgets at the foot of a guest's sidebar: what's left in each,
// at a glance. Clicking opens the full credits view.
function CreditsPanel(): React.JSX.Element | null {
  const balance = useStore((s) => s.guestBalance)
  const open = useStore((s) => s.setShowCredits)
  if (!balance || balance.pools.length === 0) return null
  return (
    <button
      onClick={() => open(true)}
      className={`fade-late group mb-1.5 flex w-full flex-col gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-overlay/[0.04] ${
        balance.error ? 'opacity-60' : ''
      }`}
      title={balance.error ?? 'Your credits — click for details'}
    >
      <span className="eyebrow flex items-center justify-between">
        Credits left
        <span className="normal-case tracking-normal text-zinc-600 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          details →
        </span>
      </span>
      {balance.pools.map((p) => (
        <Row key={p.pool} pool={p} />
      ))}
    </button>
  )
}

export default CreditsPanel
