import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { NO_USAGE } from '../chat/provider'
import { recent } from './ledger'
import { seedPrices } from './pricing'
import { applyBatch, initUsageTables, isInFolder, loadPositions } from './sources'
import type { ScannedEvent } from './transcripts'

const event = (key: string, cwd: string | null): ScannedEvent => ({
  ...NO_USAGE,
  at: Date.UTC(2026, 9, 22),
  route: 'plan',
  keyId: null,
  model: 'claude-opus-5-5',
  spec: null,
  surface: 'claude-code',
  projectId: null,
  chatId: null,
  sessionId: 's',
  images: 0,
  audioSeconds: 0,
  durationMs: null,
  ttftMs: null,
  incognito: false,
  costUsd: null,
  costKind: 'plan',
  priceId: null,
  output: 10,
  key,
  cwd,
  speed: null
})

const CHAT = 'C:\\Users\\me\\AppData\\Roaming\\orcha\\chat'
const at = (size: number): { size: number; offset: number } => ({ size, offset: size })

function database(): Database.Database {
  const db = new Database(':memory:')
  initUsageTables(db)
  seedPrices(db)
  return db
}

describe('which folders are Orcha chat', () => {
  it('matches the folder and what is inside it, in either slash style', () => {
    expect(isInFolder('c:/users/me/appdata/roaming/orcha/chat', CHAT)).toBe(true)
    expect(isInFolder('C:\\Users\\me\\AppData\\Roaming\\orcha\\chat\\abc', CHAT)).toBe(true)
    expect(isInFolder('C:\\Users\\me\\AppData\\Roaming\\orcha\\chat2', CHAT)).toBe(false)
    expect(isInFolder(null, CHAT)).toBe(false)
  })
})

describe('taking a batch from the scanner', () => {
  it('records events, saves positions, and leaves out Orcha chat transcripts', () => {
    const db = database()
    const events = [event('a', 'C:/work/app'), event('b', `${CHAT}\\x`)]
    applyBatch(db, events, { files: { '/t/one.jsonl': at(10) }, removed: [] }, CHAT)
    expect(recent(db)).toHaveLength(1)
    expect(loadPositions(db)).toEqual({ '/t/one.jsonl': at(10) })
  })

  it('forgets positions of files that are gone, and updates the rest', () => {
    const db = database()
    const files = { '/t/one.jsonl': at(1), '/t/two.jsonl': at(2) }
    applyBatch(db, [], { files, removed: [] }, CHAT)
    applyBatch(db, [], { files: { '/t/one.jsonl': at(5) }, removed: ['/t/two.jsonl'] }, CHAT)
    expect(loadPositions(db)).toEqual({ '/t/one.jsonl': at(5) })
  })

  it('saves nothing when an event fails, so the batch can come again', () => {
    const db = database()
    db.exec('DROP TABLE usage_events')
    const sources = { files: { '/t/one.jsonl': at(1) }, removed: [] }
    expect(() => applyBatch(db, [event('a', null)], sources, CHAT)).toThrow()
    expect(loadPositions(db)).toEqual({})
  })
})
