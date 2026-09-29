import { DurableObject } from 'cloudflare:workers'
import { costOf, POOLS, type Pool } from './pricing'
import type { MeteredUsage } from './meter'

// One Durable Object holds every guest's budgets and usage. Single-threaded,
// so budget checks and spend updates can never race each other.
//
// Usage is written pre-aggregated (hourly per model, daily per project, per
// session) so that the frequent reads Orcha makes — balance and live tab cost
// — touch a handful of rows. That keeps a busy guest well inside the free
// plan's daily row-read allowance.

export interface PoolState {
  pool: Pool
  label: string
  cap: number
  spent: number
}

export interface GuestState {
  id: string
  name: string
  hostName: string
  status: 'active' | 'revoked'
  pools: PoolState[]
}

export interface UsageEventInput {
  guestId: string
  pool: Pool
  usage: MeteredUsage
  project: string | null
  session: string | null
}

// Polled every few seconds by Orcha, so it touches only a handful of rows:
// the guest, their pools, and the session tabs active since `since` (found
// through an index). Pace and runway come from UsageReply's hourly data.
export interface BalanceReply {
  guest: GuestState
  // Spend per Orcha session tab, per pool.
  sessions: { session: string; pool: Pool; cost: number; updatedAt: number }[]
}

export interface UsageReply {
  hourly: { hour: number; pool: Pool; model: string; cost: number; requests: number }[]
  projects: { project: string; pool: Pool; cost: number }[]
  models: {
    pool: Pool
    model: string
    cost: number
    requests: number
    input: number
    cached: number
    output: number
  }[]
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

// The ledger needs no bindings of its own.
type LedgerEnv = Record<string, never>

export class Ledger extends DurableObject<LedgerEnv> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: LedgerEnv) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS guests (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        host_name   TEXT NOT NULL,
        token_hash  TEXT UNIQUE,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pools (
        guest_id TEXT NOT NULL,
        pool     TEXT NOT NULL,
        cap      REAL NOT NULL,
        spent    REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (guest_id, pool)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS invites (
        code_hash  TEXT PRIMARY KEY,
        guest_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        guest_id TEXT, pool TEXT, model TEXT, project TEXT, session TEXT, ts INTEGER,
        input INTEGER, cached INTEGER, cache_write INTEGER, output INTEGER,
        reasoning INTEGER, web_searches INTEGER, cost REAL, estimated INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage_hour (
        guest_id TEXT, hour INTEGER, pool TEXT, model TEXT,
        cost REAL, input INTEGER, cached INTEGER, output INTEGER, requests INTEGER,
        PRIMARY KEY (guest_id, hour, pool, model)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS usage_project (
        guest_id TEXT, day INTEGER, project TEXT, pool TEXT, cost REAL,
        PRIMARY KEY (guest_id, day, project, pool)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        guest_id TEXT, session TEXT, pool TEXT, cost REAL, updated_at INTEGER,
        PRIMARY KEY (guest_id, session, pool)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS sessions_recent ON sessions (guest_id, updated_at);
      CREATE TABLE IF NOT EXISTS topups (guest_id TEXT, pool TEXT, amount REAL, ts INTEGER);
    `)
  }

  private guestRow(where: string, value: string): GuestState | null {
    const rows = this.sql
      .exec<{
        id: string
        name: string
        host_name: string
        status: string
      }>(`SELECT id, name, host_name, status FROM guests WHERE ${where} = ?`, value)
      .toArray()
    const row = rows[0]
    if (!row) return null
    const pools = this.sql
      .exec<{ pool: string; cap: number; spent: number }>(
        'SELECT pool, cap, spent FROM pools WHERE guest_id = ?',
        row.id
      )
      .toArray()
      .filter((p) => p.pool in POOLS)
      .map((p) => ({
        pool: p.pool as Pool,
        label: POOLS[p.pool as Pool].label,
        cap: p.cap,
        spent: p.spent
      }))
    pools.sort((a, b) => POOLS[a.pool].order - POOLS[b.pool].order)
    return {
      id: row.id,
      name: row.name,
      hostName: row.host_name,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      pools
    }
  }

  // ---- guest-facing ---------------------------------------------------------

  authorize(tokenHash: string): GuestState | null {
    return this.guestRow('token_hash', tokenHash)
  }

  // Trades a one-time invite for this device's token. Redeeming again (a new
  // invite for the same guest) replaces the token, so a lost laptop stops
  // working the moment the new one pairs.
  redeem(codeHash: string, tokenHash: string): GuestState | { error: string } {
    const invite = this.sql
      .exec<{ guest_id: string; expires_at: number; used_at: number | null }>(
        'SELECT guest_id, expires_at, used_at FROM invites WHERE code_hash = ?',
        codeHash
      )
      .toArray()[0]
    if (!invite) return { error: 'That invite code is not valid.' }
    if (invite.used_at !== null) return { error: 'That invite code was already used.' }
    if (invite.expires_at < Date.now()) return { error: 'That invite code has expired.' }
    const guest = this.guestRow('id', invite.guest_id)
    if (!guest || guest.status === 'revoked') return { error: 'This invite was revoked.' }
    this.sql.exec('UPDATE invites SET used_at = ? WHERE code_hash = ?', Date.now(), codeHash)
    this.sql.exec('UPDATE guests SET token_hash = ? WHERE id = ?', tokenHash, invite.guest_id)
    return this.guestRow('id', invite.guest_id)!
  }

  // For the browser landing page of an invite link: who sent it, and whether
  // it can still be redeemed. Reveals nothing a code holder couldn't redeem.
  inviteInfo(codeHash: string): { hostName: string; guestName: string; usable: boolean } | null {
    const row = this.sql
      .exec<{ host_name: string; name: string; expires_at: number; used_at: number | null; status: string }>(
        `SELECT g.host_name, g.name, g.status, i.expires_at, i.used_at
         FROM invites i JOIN guests g ON g.id = i.guest_id WHERE i.code_hash = ?`,
        codeHash
      )
      .toArray()[0]
    if (!row) return null
    return {
      hostName: row.host_name,
      guestName: row.name,
      usable: row.used_at === null && row.expires_at > Date.now() && row.status !== 'revoked'
    }
  }

  record(event: UsageEventInput): number {
    const u = event.usage
    if (u.estimated && u.cachedTokens === 0 && u.inputTokens > 0 && event.pool !== 'claude') {
      // An interrupted Responses reply: re-split the estimated input using the
      // cache-hit ratio of this guest's last exact reply on the same model
      // (consecutive turns share almost their whole prefix).
      const prior = this.sql
        .exec<{ input: number; cached: number }>(
          `SELECT input, cached FROM events
           WHERE guest_id = ? AND model = ? AND estimated = 0 AND input + cached > 0
           ORDER BY rowid DESC LIMIT 1`,
          event.guestId,
          u.model ?? ''
        )
        .toArray()[0]
      if (prior && u.lines.length === 1) {
        const ratio = prior.cached / (prior.input + prior.cached)
        const line = u.lines[0]
        line.cachedTokens = Math.floor(line.inputTokens * ratio)
        line.inputTokens -= line.cachedTokens
        u.cachedTokens = line.cachedTokens
        u.inputTokens = line.inputTokens
      }
    }

    const cost = costOf(event.pool, u)
    const now = Date.now()
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS
    const day = Math.floor(now / DAY_MS) * DAY_MS
    const model = u.model ?? 'unknown'
    const project = (event.project ?? 'Other').slice(0, 80)
    const cacheWrite = u.cacheWrite5mTokens + u.cacheWrite1hTokens

    this.sql.exec(
      'UPDATE pools SET spent = spent + ? WHERE guest_id = ? AND pool = ?',
      cost,
      event.guestId,
      event.pool
    )
    this.sql.exec(
      `INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.guestId,
      event.pool,
      model,
      project,
      event.session,
      now,
      u.inputTokens,
      u.cachedTokens,
      cacheWrite,
      u.outputTokens,
      u.reasoningTokens,
      u.webSearches,
      cost,
      u.estimated ? 1 : 0
    )
    this.sql.exec(
      `INSERT INTO usage_hour VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (guest_id, hour, pool, model) DO UPDATE SET
         cost = cost + excluded.cost, input = input + excluded.input,
         cached = cached + excluded.cached, output = output + excluded.output,
         requests = requests + 1`,
      event.guestId,
      hour,
      event.pool,
      model,
      cost,
      u.inputTokens + cacheWrite,
      u.cachedTokens,
      u.outputTokens
    )
    this.sql.exec(
      `INSERT INTO usage_project VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guest_id, day, project, pool) DO UPDATE SET cost = cost + excluded.cost`,
      event.guestId,
      day,
      project,
      event.pool,
      cost
    )
    if (event.session) {
      this.sql.exec(
        `INSERT INTO sessions VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guest_id, session, pool) DO UPDATE SET
           cost = cost + excluded.cost, updated_at = excluded.updated_at`,
        event.guestId,
        event.session.slice(0, 80),
        event.pool,
        cost,
        now
      )
    }
    return cost
  }

  balance(guestId: string, since: number): BalanceReply | null {
    const guest = this.guestRow('id', guestId)
    if (!guest) return null
    const sessions = this.sql
      .exec<{ session: string; pool: string; cost: number; updated_at: number }>(
        'SELECT session, pool, cost, updated_at FROM sessions WHERE guest_id = ? AND updated_at >= ?',
        guestId,
        since
      )
      .toArray()
      .map((s) => ({ session: s.session, pool: s.pool as Pool, cost: s.cost, updatedAt: s.updated_at }))
    return { guest, sessions }
  }

  usage(guestId: string, since: number): UsageReply {
    const hourly = this.sql
      .exec<{ hour: number; pool: string; model: string; cost: number; requests: number }>(
        'SELECT hour, pool, model, cost, requests FROM usage_hour WHERE guest_id = ? AND hour >= ?',
        guestId,
        since
      )
      .toArray()
      .map((r) => ({ ...r, pool: r.pool as Pool }))
    const projects = this.sql
      .exec<{ project: string; pool: string; cost: number }>(
        `SELECT project, pool, SUM(cost) AS cost FROM usage_project
         WHERE guest_id = ? AND day >= ? GROUP BY project, pool ORDER BY cost DESC`,
        guestId,
        since
      )
      .toArray()
      .map((r) => ({ ...r, pool: r.pool as Pool }))
    const models = this.sql
      .exec<{
        pool: string
        model: string
        cost: number
        requests: number
        input: number
        cached: number
        output: number
      }>(
        `SELECT pool, model, SUM(cost) AS cost, SUM(requests) AS requests, SUM(input) AS input,
                SUM(cached) AS cached, SUM(output) AS output
         FROM usage_hour WHERE guest_id = ? AND hour >= ? GROUP BY pool, model ORDER BY cost DESC`,
        guestId,
        since
      )
      .toArray()
      .map((r) => ({ ...r, pool: r.pool as Pool }))
    return { hourly, projects, models }
  }

  // ---- admin ----------------------------------------------------------------

  createGuest(name: string, hostName: string, caps: Partial<Record<Pool, number>>): GuestState {
    const id = crypto.randomUUID()
    this.sql.exec(
      'INSERT INTO guests (id, name, host_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      name,
      hostName,
      'active',
      Date.now()
    )
    for (const pool of Object.keys(POOLS) as Pool[]) {
      this.sql.exec(
        'INSERT INTO pools (guest_id, pool, cap, spent) VALUES (?, ?, ?, 0)',
        id,
        pool,
        Math.max(0, caps[pool] ?? 0)
      )
    }
    return this.guestRow('id', id)!
  }

  createInvite(guestId: string, codeHash: string, ttlMs: number): boolean {
    if (!this.guestRow('id', guestId)) return false
    const now = Date.now()
    this.sql.exec(
      'INSERT INTO invites (code_hash, guest_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      codeHash,
      guestId,
      now,
      now + ttlMs
    )
    return true
  }

  listGuests(): (GuestState & { createdAt: number; lastActiveAt: number | null; paired: boolean })[] {
    const rows = this.sql
      .exec<{ id: string; created_at: number; token_hash: string | null }>(
        'SELECT id, created_at, token_hash FROM guests ORDER BY created_at'
      )
      .toArray()
    return rows.map((r) => {
      const last = this.sql
        .exec<{ at: number | null }>(
          'SELECT MAX(hour) AS at FROM usage_hour WHERE guest_id = ?',
          r.id
        )
        .toArray()[0]
      return {
        ...this.guestRow('id', r.id)!,
        createdAt: r.created_at,
        lastActiveAt: last?.at ?? null,
        paired: r.token_hash !== null
      }
    })
  }

  topUp(guestId: string, pool: Pool, amount: number): GuestState | null {
    if (!(pool in POOLS) || !Number.isFinite(amount)) return null
    this.sql.exec(
      'UPDATE pools SET cap = MAX(0, cap + ?) WHERE guest_id = ? AND pool = ?',
      amount,
      guestId,
      pool
    )
    this.sql.exec('INSERT INTO topups VALUES (?, ?, ?, ?)', guestId, pool, amount, Date.now())
    return this.guestRow('id', guestId)
  }

  setStatus(guestId: string, status: 'active' | 'revoked'): GuestState | null {
    this.sql.exec('UPDATE guests SET status = ? WHERE id = ?', status, guestId)
    return this.guestRow('id', guestId)
  }
}
