import type Database from 'better-sqlite3'
import { migrateUsage, recordScanned, USAGE_SCHEMA } from './ledger'
import { PRICE_SCHEMA } from './pricing'
import type { SourceUpdates } from './scanner'
import type { FileState, ScannedEvent } from './transcripts'

// The database side of transcript scanning: the tables, and the one
// transaction that takes a batch from the scanner. No Electron in here, so the
// tests can run it on an in-memory database.

type Db = Database.Database

// How far the scanner got in each transcript. Kept in its own table, in the
// same transaction as the events read up to those positions, so a crash can
// never leave events counted whose position wasn't saved (they would be
// counted twice) or the reverse (they would be lost).
const SOURCES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_sources (
    path  TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );
`

export function initUsageTables(db: Db): void {
  db.exec(PRICE_SCHEMA)
  db.exec(USAGE_SCHEMA)
  db.exec(SOURCES_SCHEMA)
  migrateUsage(db)
}

export function loadPositions(db: Db): Record<string, FileState> {
  const rows = db.prepare('SELECT path, state FROM usage_sources').all() as {
    path: string
    state: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.path, JSON.parse(r.state) as FileState]))
}

const normal = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// Orcha's own chat engine records its turns itself (surface 'chat'), but they
// also run through Claude Code's engine and leave a transcript in this
// folder. Counting that transcript as well would count each turn twice.
export function isInFolder(cwd: string | null, folder: string): boolean {
  if (!cwd) return false
  const here = normal(cwd)
  const root = normal(folder)
  return here === root || here.startsWith(`${root}/`)
}

export function applyBatch(
  db: Db,
  events: ScannedEvent[],
  sources: SourceUpdates,
  chatFolder: string
): void {
  const save = db.prepare(
    'INSERT INTO usage_sources (path, state) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET state = excluded.state'
  )
  const drop = db.prepare('DELETE FROM usage_sources WHERE path = ?')
  db.transaction(() => {
    for (const event of events) {
      if (!isInFolder(event.cwd, chatFolder)) recordScanned(db, event)
    }
    for (const [path, state] of Object.entries(sources.files)) save.run(path, JSON.stringify(state))
    for (const path of sources.removed) drop.run(path)
  })()
}
