import * as db from './db'
import type { CreditPool, GuestBalance, GuestStatus, GuestUsage } from '../shared/types'

// Guest mode: this Orcha runs on someone else's credits, through the budget
// relay they host (see relay/ in this repo). It is paired once from an invite
// link; from then on every Claude session, every Codex session and Mission
// Control bill that relay instead of any login on this machine — the guest's
// own Claude/ChatGPT logins stay untouched and keep working outside Orcha.

const CONFIG_KEY = 'guest:config'
const BALANCE_TTL_MS = 5000

interface GuestConfig {
  relay: string // https://orcha-relay.<account>.workers.dev
  token: string // og_…, this device's relay token
  name: string
  hostName: string
}

// https for any relay; plain http only for one on this machine (local testing).
export const INVITE_LINK =
  /(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)\/join\/[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){3}/

function config(): GuestConfig | null {
  const raw = db.appState.get(CONFIG_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as GuestConfig
  } catch {
    return null
  }
}

export function isGuest(): boolean {
  return config() !== null
}

export function guestStatus(): GuestStatus {
  const c = config()
  return { paired: c !== null, name: c?.name ?? null, hostName: c?.hostName ?? null }
}

export async function redeemInvite(link: string): Promise<GuestStatus> {
  const match = link.trim().match(INVITE_LINK)
  if (!match) throw new Error("That doesn't look like an Orcha invite link.")
  const url = new URL(match[0])
  const code = url.pathname.slice('/join/'.length)
  let response: Response
  try {
    response = await fetch(`${url.origin}/v1/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new Error(
      "Couldn't reach the invite server. Check your internet connection and try again."
    )
  }
  const body = (await response.json().catch(() => ({}))) as {
    token?: string
    error?: string
    guest?: { name: string; hostName: string }
  }
  if (!response.ok || !body.token || !body.guest) {
    throw new Error(body.error ?? `The invite server answered ${response.status}.`)
  }
  db.appState.set(
    CONFIG_KEY,
    JSON.stringify({
      relay: url.origin,
      token: body.token,
      name: body.guest.name,
      hostName: body.guest.hostName
    } satisfies GuestConfig)
  )
  balanceCache = null
  return guestStatus()
}

export function leaveGuestMode(): void {
  db.appState.set(CONFIG_KEY, '')
  balanceCache = null
}

// ---- reading the budget -----------------------------------------------------------

let balanceCache: GuestBalance | null = null

async function relayGet<T>(c: GuestConfig, path: string): Promise<T> {
  const response = await fetch(`${c.relay}${path}`, {
    headers: { authorization: `Bearer ${c.token}` },
    signal: AbortSignal.timeout(10_000)
  })
  if (response.status === 401)
    throw new Error('This device was unpaired. Ask for a new invite link.')
  if (!response.ok) throw new Error(`The relay answered ${response.status}.`)
  return (await response.json()) as T
}

interface BalanceReply {
  guest: {
    name: string
    hostName: string
    status: 'active' | 'revoked'
    pools: GuestBalance['pools']
  }
  sessions: GuestBalance['sessions']
}

// Balance and per-tab spend. Cached briefly because every open
// tab and the sidebar read it; on a network failure the last known numbers
// come back with `error` set rather than the UI going blank.
export async function guestBalance(force = false): Promise<GuestBalance | null> {
  const c = config()
  if (!c) return null
  if (!force && balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_TTL_MS) {
    return balanceCache
  }
  try {
    const since = Date.now() - 7 * 86_400_000
    const reply = await relayGet<BalanceReply>(c, `/v1/me/balance?since=${since}`)
    balanceCache = {
      name: reply.guest.name,
      hostName: reply.guest.hostName,
      status: reply.guest.status,
      pools: reply.guest.pools,
      sessions: reply.sessions,
      fetchedAt: Date.now(),
      error: null
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    balanceCache = balanceCache
      ? { ...balanceCache, fetchedAt: Date.now(), error }
      : {
          name: c.name,
          hostName: c.hostName,
          status: 'active',
          pools: [],
          sessions: [],
          fetchedAt: Date.now(),
          error
        }
  }
  return balanceCache
}

// Hourly spend per model plus per-project totals over the last 14 days, for
// the breakdown views. Only fetched while the usage view is open.
export async function guestUsage(): Promise<GuestUsage | null> {
  const c = config()
  if (!c) return null
  return relayGet<GuestUsage>(c, `/v1/me/usage?since=${Date.now() - 14 * 86_400_000}`)
}

// Whether `pool` still has money, from the last known balance. Unknown (not
// fetched yet, or unreachable) counts as open — the relay enforces the cap
// either way; this only decides what the UI offers.
export function poolOpen(pool: CreditPool): boolean {
  const state = balanceCache?.pools.find((p) => p.pool === pool)
  return !state || state.spent < state.cap
}

// ---- wiring sessions to the relay -------------------------------------------------

// HTTP header values must be printable ASCII; a project name with anything
// else (accents, emoji) would make every request fail, so it's flattened.
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)
}

export function attributionHeaders(project: string, session: string): Record<string, string> {
  return { 'X-Orcha-Project': headerSafe(project), 'X-Orcha-Session': headerSafe(session) }
}

// Environment for a Claude Code process (a session's TUI, or the Agent SDK
// behind Mission Control) so it talks to the relay. ANTHROPIC_AUTH_TOKEN wins
// over any claude.ai login on the machine and, unlike ANTHROPIC_API_KEY, never
// asks the "use this key?" question. Project/session ride along as headers so
// the relay can break spend down per project and per tab. Every inherited
// ANTHROPIC_* setting and provider switch (CLAUDE_CODE_USE_BEDROCK/VERTEX/…)
// is dropped first: any of them would send the session somewhere other than
// the relay.
export function claudeRelayEnv(
  base: Record<string, string>,
  project: string,
  session: string
): Record<string, string> {
  const c = config()
  if (!c) return base
  const env = Object.fromEntries(
    Object.entries(base).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k))
  )
  env.ANTHROPIC_BASE_URL = `${c.relay}/anthropic`
  env.ANTHROPIC_AUTH_TOKEN = c.token
  env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(attributionHeaders(project, session))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return env
}

// orcha://join/<code>?relay=<origin> (the invite page's "Open in Orcha"
// button) as the invite link it stands for, or null if it isn't one.
export function inviteFromDeepLink(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'orcha:' || u.hostname !== 'join') return null
    const link = `${u.searchParams.get('relay') ?? ''}/join${u.pathname}`
    return link.match(INVITE_LINK)?.[0] === link ? link : null
  } catch {
    return null
  }
}

// An invite that arrived as an orcha:// link (possibly before the window
// existed), waiting for the welcome screen to show it. Never redeemed on its
// own: any web page can open an orcha:// link, so the person confirms it.
let pendingInvite: string | null = null

export function queueInviteLink(url: string): string | null {
  const link = inviteFromDeepLink(url)
  if (link) pendingInvite = link
  return link
}

export function takePendingInvite(): string | null {
  const link = isGuest() ? null : pendingInvite
  pendingInvite = null
  return link
}

export function relayConfig(): { relay: string; token: string } | null {
  const c = config()
  return c ? { relay: c.relay, token: c.token } : null
}
