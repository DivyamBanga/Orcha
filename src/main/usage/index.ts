import { app } from 'electron'
import { join } from 'path'
import workerPath from './transcriptsWorker?modulePath'
import { database, projects } from '../db'
import { fetchPlanUsage } from '../planUsage'
import type { UsageSummary } from '../../shared/types'
import { computeInsights } from './insights'
import { seedPrices } from './pricing'
import { startScanner, type Scanner } from './scanner'
import { applyBatch, initUsageTables, loadPositions } from './sources'

// Starts and stops the usage pipeline: the price book, the ledger, and the
// scanner that fills it from Claude Code's and Codex's transcripts. Reading
// transcripts happens in a worker thread; this side only ever receives small
// batches of finished events and writes them in one transaction each.

let scanner: Scanner | null = null

// Call once the database is open.
export function startUsage(): void {
  const db = database()
  initUsageTables(db)
  seedPrices(db)
  // Chat turns are recorded by the chat engine itself, so the transcripts
  // that engine leaves in its session folder must not be scanned again.
  const chatFolder = join(app.getPath('userData'), 'chat')
  scanner = startScanner({
    workerPath,
    files: loadPositions(db),
    projects: () => projects.list(),
    onEvents: (events, sources) => applyBatch(db, events, sources, chatFolder)
  })
  app.on('before-quit', () => void scanner?.stop())
}

// The Usage dialog: Anthropic's real plan limits, and from the ledger what is
// using them.
export async function computeUsageSummary(force: boolean): Promise<UsageSummary> {
  const plan = await fetchPlanUsage(force)
  const session = plan.limits.find((l) => l.key === 'five_hour') ?? null
  const known = new Map(
    projects.list().map((p) => [p.id, { name: p.name, repoPath: p.repoPath }] as const)
  )
  const insights = computeInsights(database(), session, known)
  return { plan, insights, fetchedAt: Date.now() }
}
