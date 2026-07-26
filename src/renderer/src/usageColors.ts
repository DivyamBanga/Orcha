// Shared by UsageGlance and UsageDashboard so the sidebar ring and the quota
// bars agree. Takes a real utilization percent (0-100) straight from the API.
// Split into its own module (react-refresh only allows component exports from
// component files).
export function percentColors(percent: number): { text: string; bg: string; stroke: string } {
  if (percent >= 90) return { text: 'text-red-400', bg: 'bg-red-400', stroke: 'stroke-red-400' }
  if (percent >= 70)
    return { text: 'text-amber-500', bg: 'bg-amber-500', stroke: 'stroke-amber-500' }
  return { text: 'text-accent', bg: 'bg-accent', stroke: 'stroke-accent' }
}
