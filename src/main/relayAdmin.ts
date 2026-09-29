import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AdminGuest, CreditPool, GuestUsage } from '../shared/types'

// The host side of guest mode: managing the people you've given credits to,
// on the relay you deployed. `npm run setup` in relay/ writes the relay URL and
// its admin token to this file; its presence is what makes Settings → Guests
// appear. Same trust model as Claude Code's own ~/.claude/.credentials.json.
const ADMIN_FILE = join(homedir(), '.orcha', 'relay-admin.json')

interface AdminConfig {
  url: string
  adminToken: string
}

function adminConfig(): AdminConfig | null {
  if (!existsSync(ADMIN_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) as Partial<AdminConfig>
    return parsed.url && parsed.adminToken
      ? { url: parsed.url, adminToken: parsed.adminToken }
      : null
  } catch {
    return null
  }
}

export function relayAdminStatus(): { configured: boolean; url: string | null } {
  const c = adminConfig()
  return { configured: c !== null, url: c?.url ?? null }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const c = adminConfig()
  if (!c) throw new Error('No relay set up on this machine yet — run `npm run setup` in relay/.')
  let response: Response
  try {
    response = await fetch(`${c.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${c.adminToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new Error("Couldn't reach your relay. Check your internet connection.")
  }
  const reply = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(reply.error ?? `Relay answered ${response.status}`)
  return reply
}

export const relayAdmin = {
  guests: (): Promise<AdminGuest[]> => call('/admin/guests'),

  create: (
    name: string,
    hostName: string,
    caps: Record<CreditPool, number>
  ): Promise<{ guest: AdminGuest; inviteUrl: string }> =>
    call('/admin/guests', { name, hostName, caps }),

  // A fresh one-time link for an existing guest (new computer, lost link).
  // Redeeming it replaces the old device's token.
  invite: (guestId: string): Promise<{ inviteUrl: string }> =>
    call(`/admin/guests/${guestId}/invite`, {}),

  topUp: (guestId: string, pool: CreditPool, amount: number): Promise<AdminGuest> =>
    call(`/admin/guests/${guestId}/topup`, { pool, amount }),

  setAccess: (guestId: string, access: 'revoke' | 'restore'): Promise<AdminGuest> =>
    call(`/admin/guests/${guestId}/${access}`, {}),

  usage: (guestId: string): Promise<{ usage: GuestUsage }> =>
    call(`/admin/guests/${guestId}/usage?since=${Date.now() - 14 * 86_400_000}`)
}
