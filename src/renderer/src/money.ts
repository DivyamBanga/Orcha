import type { PoolBalance } from '../../shared/types'
import type { ChatModel } from '../../shared/ai'

// Dollars as the Guests panel and chat replies show them: two decimals, and a
// small spend never shows as nothing.

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

// The Codex model a tab runs, by Azure deployment name: its own if still on
// offer, else GPT-6 Sol, else the first deployment.
export function codexModel(model: string | null, models: ChatModel[]): ChatModel | null {
  const azure = models.filter((m) => m.route === 'azure')
  return (
    azure.find((m) => m.apiModel === model) ??
    azure.find((m) => m.apiModel === 'gpt-6-sol') ??
    azure[0] ??
    null
  )
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
