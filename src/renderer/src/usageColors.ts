// Shared by UsageGlance and UsageDashboard so the sidebar ring and the quota
// bars agree. Takes a real utilization percent (0-100) straight from the API.
// Split into its own module (react-refresh only allows component exports from
// component files).
// Neutral until it is worth reacting to: quota is not session state, so it
// only earns colour once it is close to the cap.
export function percentColors(percent: number): { text: string; bg: string; stroke: string } {
  if (percent >= 90) return { text: 'text-red-400', bg: 'bg-red-400', stroke: 'stroke-red-400' }
  if (percent >= 70) return { text: 'text-wait', bg: 'bg-wait', stroke: 'stroke-wait' }
  return { text: 'text-zinc-400', bg: 'bg-zinc-400', stroke: 'stroke-zinc-400' }
}
