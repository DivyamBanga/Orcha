import { Ledger, type GuestState } from './ledger'
import { anthropicMeter, peekModel, responsesMeter, type Meter } from './meter'
import { POOLS, poolForResponsesModel, type Pool } from './pricing'
import { joinPage } from './join'

export { Ledger }

interface Env {
  LEDGER: DurableObjectNamespace<Ledger>
  ADMIN_TOKEN: string
  ANTHROPIC_API_KEY: string
  AZURE_API_KEY: string
  AZURE_ENDPOINT: string // https://<resource>.openai.azure.com
  // Only set by the local end-to-end test, which points both providers at a
  // fake upstream; production always talks to api.anthropic.com.
  ANTHROPIC_UPSTREAM?: string
  DOWNLOAD_URL: string // where an invite page sends people to get Orcha
}

const INVITE_TTL_MS = 7 * 24 * 3_600_000
// How long a Worker isolate trusts a cached balance before asking the ledger
// again. A request that slips through in this window is the "tiny overshoot"
// the budget design accepts; it can't turn into more than a few requests.
const AUTH_CACHE_MS = 4000

// Request headers never forwarded upstream: our own auth and attribution,
// hop-by-hop headers, and Cloudflare's client metadata.
const DROP_HEADERS = new Set([
  'host',
  'authorization',
  'x-api-key',
  'api-key',
  'content-length',
  'connection',
  'cookie',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-orcha-project',
  'x-orcha-session'
])

function ledger(env: Env): DurableObjectStub<Ledger> {
  return env.LEDGER.get(env.LEDGER.idFromName('main'))
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra }
  })
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Crockford-ish base32 without look-alikes, grouped for reading aloud.
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
  const buf = crypto.getRandomValues(new Uint8Array(20))
  const chars = [...buf].map((b) => alphabet[b % alphabet.length]).join('')
  return chars.match(/.{5}/g)!.join('-')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearer(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return request.headers.get('x-api-key')
}

// ---- guest auth ---------------------------------------------------------------

const authCache = new Map<string, { guest: GuestState; at: number }>()

async function authorizeGuest(env: Env, token: string | null): Promise<GuestState | null> {
  if (!token || !token.startsWith('og_')) return null
  const hash = await sha256(token)
  const cached = authCache.get(hash)
  if (cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.guest
  const guest = await ledger(env).authorize(hash)
  if (guest) authCache.set(hash, { guest, at: Date.now() })
  else authCache.delete(hash)
  return guest
}

// Why a guest may not spend from `pool` right now, or null if they may.
function blockReason(guest: GuestState, pool: Pool): string | null {
  if (guest.status === 'revoked') {
    return `Orcha: access to ${guest.hostName}'s credits was turned off.`
  }
  const state = guest.pools.find((p) => p.pool === pool)
  if (!state || state.cap <= 0) {
    return `Orcha: no ${POOLS[pool].label} budget on this invite.`
  }
  if (state.spent >= state.cap) {
    return `Orcha: your ${POOLS[pool].label} budget ($${state.cap.toFixed(2)}) is used up. Ask ${guest.hostName} to top it up.`
  }
  return null
}

// Errors worded for the person reading them in the terminal. Claude Code shows
// an Anthropic-shaped error's message after "API Error: <status>"; the
// x-should-retry header stops it retrying a request that can only fail again.
function anthropicError(status: number, type: string, message: string): Response {
  return json({ type: 'error', error: { type, message } }, status, { 'x-should-retry': 'false' })
}

// Codex prints a 4xx body verbatim, so plain text reads as a sentence where a
// JSON error would show up as raw JSON. Only "not paired" keeps the standard
// JSON shape, which Codex treats as an auth failure.
function openaiError(status: number, code: string, message: string): Response {
  if (status === 401) return json({ error: { message, type: code, code, param: null } }, status)
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } })
}

// ---- metered proxying ---------------------------------------------------------

interface Attribution {
  project: string | null
  session: string | null
}

function attribution(request: Request): Attribution {
  const clean = (v: string | null): string | null => (v ? v.slice(0, 80) : null)
  return {
    project: clean(request.headers.get('x-orcha-project')),
    session: clean(request.headers.get('x-orcha-session'))
  }
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase()
    if (DROP_HEADERS.has(k) || k.startsWith('cf-')) continue
    headers.set(key, value)
  }
  return headers
}

// Streams the upstream body to the client while the meter gets a copy, then
// records the spend — all without JavaScript touching the stream per network
// chunk: on the free plan's 10ms CPU budget that alone measured 18-26ms on a
// short Codex reply, where native tee/pipe/collect measured 1-2ms. When the
// client hangs up mid-reply (Esc in the TUI) the native pipe fails, which
// cancels the upstream request — stopping generation and billing — and the
// meter still records what the reply cost up to then.
function meteredResponse(
  upstream: Response,
  meter: Meter,
  ctx: ExecutionContext,
  cancelUpstream: () => void,
  onUsage: (usage: NonNullable<ReturnType<Meter['finish']>>) => Promise<unknown>
): Response {
  const headers = new Headers(upstream.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  if (!upstream.body) return new Response(null, { status: upstream.status, headers })

  const started = Date.now()
  const [toClient, toMeter] = upstream.body.tee()
  const { readable, writable } = new IdentityTransformStream()
  ctx.waitUntil(toClient.pipeTo(writable).catch(() => cancelUpstream()))
  ctx.waitUntil(
    (async () => {
      let whole = toMeter
      if (meter.readsHead) {
        // Only the opening chunks go through JavaScript, and only until the
        // meter has what it needs from them.
        const [opening, rest] = toMeter.tee()
        whole = rest
        const reader = opening.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done || meter.head(value)) break
          }
        } catch {
          // cut off during the opening; finish() works with what arrived
        }
        reader.cancel().catch(() => {})
      }
      let body: Uint8Array | null
      try {
        body = new Uint8Array(await new Response(whole).arrayBuffer())
      } catch {
        body = null // cut off: the client hung up or the connection dropped
      }
      if (!upstream.ok) return
      const usage = meter.finish(body, Date.now() - started)
      if (usage) await onUsage(usage)
    })()
  )
  return new Response(readable, { status: upstream.status, headers })
}

async function proxyAnthropic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  search: string
): Promise<Response> {
  // Claude Code probes this for connection warming; nothing to meter.
  if (path === '/api/hello') return new Response(null, { status: 200 })
  const allowed = path === '/v1/messages' || path === '/v1/messages/count_tokens'
  if (!allowed || request.method !== 'POST') {
    return anthropicError(404, 'not_found_error', `Orcha relay: ${path} is not available.`)
  }

  const guest = await authorizeGuest(env, bearer(request))
  if (!guest) {
    return anthropicError(401, 'authentication_error', 'Orcha relay: this device is not paired.')
  }
  const reason = blockReason(guest, 'claude')
  // 400, not 403: Claude Code reads any 401/403 as a login problem and
  // prefixes "Please run /login", which would send a guest the wrong way.
  if (reason) return anthropicError(400, 'invalid_request_error', reason)

  const headers = forwardHeaders(request)
  headers.set('x-api-key', env.ANTHROPIC_API_KEY)
  const base = env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com'
  // Aborted when the client hangs up — before the reply starts (request.signal)
  // or mid-stream (meteredResponse) — which cancels generation and its bill.
  const cancel = new AbortController()
  const upstream = await fetch(`${base}${path}${search}`, {
    method: 'POST',
    headers,
    body: request.body,
    signal: AbortSignal.any([request.signal, cancel.signal])
  })
  // Token counting is free; pass it straight through.
  if (path !== '/v1/messages') return upstream

  const who = attribution(request)
  const meter = anthropicMeter(upstream.headers.get('content-type') ?? '')
  return meteredResponse(upstream, meter, ctx, () => cancel.abort(), (usage) =>
    ledger(env).record({ guestId: guest.id, pool: 'claude', usage, ...who })
  )
}

async function proxyResponses(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string
): Promise<Response> {
  if (path !== '/v1/responses' || request.method !== 'POST') {
    return openaiError(404, 'not_found', `Orcha relay: ${path} is not available.`)
  }
  const guest = await authorizeGuest(env, bearer(request))
  if (!guest) return openaiError(401, 'invalid_api_key', 'Orcha relay: this device is not paired.')

  // Buffered rather than streamed: the model has to be known before choosing
  // a budget, and a raw copy costs no parse. Only the first bytes are decoded.
  const body = await request.arrayBuffer()
  const model = peekModel(body)
  const pool = model ? poolForResponsesModel(model) : null
  if (!model || !pool) {
    return openaiError(
      400,
      'model_not_available',
      `Orcha relay: model "${model ?? '?'}" is not available. Use gpt-6-sol or gpt-6-astra.`
    )
  }
  const reason = blockReason(guest, pool)
  // 400 rather than 429 + insufficient_quota, which Codex would swap for its
  // generic "Quota exceeded. Check your plan and billing details."
  if (reason) return openaiError(400, 'budget_exhausted', reason)

  const headers = forwardHeaders(request)
  headers.set('api-key', env.AZURE_API_KEY)
  const endpoint = env.AZURE_ENDPOINT.replace(/\/+$/, '')
  // Azure deployments are named exactly after the model ids, so the body goes
  // upstream byte-for-byte as Codex sent it.
  const cancel = new AbortController()
  const upstream = await fetch(`${endpoint}/openai/v1/responses`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.any([request.signal, cancel.signal])
  })

  const who = attribution(request)
  const meter = responsesMeter(upstream.headers.get('content-type') ?? '', {
    model,
    requestBytes: body.byteLength
  })
  return meteredResponse(upstream, meter, ctx, () => cancel.abort(), (usage) =>
    ledger(env).record({ guestId: guest.id, pool, usage, ...who })
  )
}

// ---- guest account ------------------------------------------------------------

async function redeem(request: Request, env: Env): Promise<Response> {
  let code = ''
  try {
    code = String(((await request.json()) as { code?: unknown }).code ?? '')
  } catch {
    return json({ error: 'Send {"code": "..."}' }, 400)
  }
  code = code.trim().toUpperCase()
  if (!/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code)) {
    return json({ error: 'That invite code is not valid.' }, 400)
  }
  const token = `og_${randomToken(32)}`
  const result = await ledger(env).redeem(await sha256(code), await sha256(token))
  if ('error' in result) return json(result, 400)
  return json({ token, guest: result })
}

async function guestAccount(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const guest = await authorizeGuest(env, bearer(request))
  if (!guest) return json({ error: 'This device is not paired.' }, 401)
  const since = Number(url.searchParams.get('since')) || Date.now() - 86_400_000
  if (path === '/v1/me/balance') {
    return json(await ledger(env).balance(guest.id, since))
  }
  if (path === '/v1/me/usage') {
    return json(await ledger(env).usage(guest.id, since))
  }
  return json({ error: 'Not found' }, 404)
}

// An invite link opened in a browser rather than pasted into Orcha.
async function join(env: Env, url: URL): Promise<Response> {
  const code = url.pathname.slice('/join/'.length).toUpperCase()
  const info = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code)
    ? await ledger(env).inviteInfo(await sha256(code))
    : null
  const html = joinPage({
    link: `${url.origin}/join/${code}`,
    hostName: info?.hostName ?? null,
    usable: info?.usable ?? false,
    downloadUrl: env.DOWNLOAD_URL
  })
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' }
  })
}

// ---- admin --------------------------------------------------------------------

async function admin(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const token = bearer(request)
  if (!env.ADMIN_TOKEN || !token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: 'Not authorized' }, 401)
  }
  const stub = ledger(env)
  const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

  if (path === '/admin/guests' && request.method === 'GET') {
    return json(await stub.listGuests())
  }
  if (path === '/admin/guests' && request.method === 'POST') {
    const name = String(body.name ?? '').trim().slice(0, 60)
    const hostName = String(body.hostName ?? '').trim().slice(0, 60) || 'your host'
    if (!name) return json({ error: 'name is required' }, 400)
    const caps = (body.caps ?? {}) as Partial<Record<Pool, number>>
    const guest = await stub.createGuest(name, hostName, caps)
    const code = inviteCode()
    await stub.createInvite(guest.id, await sha256(code), INVITE_TTL_MS)
    return json({ guest, invite: code, inviteUrl: `${url.origin}/join/${code}` })
  }

  const match = path.match(
    /^\/admin\/guests\/([0-9a-f-]{36})\/(invite|topup|revoke|restore|usage|remove)$/
  )
  if (!match) return json({ error: 'Not found' }, 404)
  const [, guestId, action] = match
  if (action === 'remove' && request.method === 'POST') {
    const removed = await stub.removeGuest(guestId)
    authCache.clear()
    return removed ? json({ removed: true }) : json({ error: 'Unknown guest' }, 404)
  }
  if (action === 'invite' && request.method === 'POST') {
    const code = inviteCode()
    const ok = await stub.createInvite(guestId, await sha256(code), INVITE_TTL_MS)
    return ok
      ? json({ invite: code, inviteUrl: `${url.origin}/join/${code}` })
      : json({ error: 'Unknown guest' }, 404)
  }
  if (action === 'topup' && request.method === 'POST') {
    const pool = String(body.pool) as Pool
    const amount = Number(body.amount)
    const guest = await stub.topUp(guestId, pool, amount)
    authCache.clear()
    return guest ? json(guest) : json({ error: 'Unknown guest or pool' }, 400)
  }
  if ((action === 'revoke' || action === 'restore') && request.method === 'POST') {
    const guest = await stub.setStatus(guestId, action === 'revoke' ? 'revoked' : 'active')
    authCache.clear()
    return guest ? json(guest) : json({ error: 'Unknown guest' }, 404)
  }
  if (action === 'usage' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since')) || Date.now() - 14 * 86_400_000
    const [balance, usage] = await Promise.all([
      stub.balance(guestId, Date.now() - 86_400_000),
      stub.usage(guestId, since)
    ])
    return balance ? json({ ...balance, usage }) : json({ error: 'Unknown guest' }, 404)
  }
  return json({ error: 'Not found' }, 404)
}

// ---- router -------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (path === '/' || path === '/health') return json({ ok: true, service: 'orcha-relay' })
      if (path.startsWith('/anthropic/')) {
        return await proxyAnthropic(request, env, ctx, path.slice('/anthropic'.length), url.search)
      }
      if (path.startsWith('/openai/')) {
        return await proxyResponses(request, env, ctx, path.slice('/openai'.length))
      }
      if (path === '/v1/redeem' && request.method === 'POST') return await redeem(request, env)
      if (path.startsWith('/join/') && request.method === 'GET') return await join(env, url)
      if (path.startsWith('/v1/me/')) return await guestAccount(request, env, path, url)
      if (path.startsWith('/admin/')) return await admin(request, env, path, url)
      return json({ error: 'Not found' }, 404)
    } catch (err) {
      return json({ error: 'relay_error', message: err instanceof Error ? err.message : String(err) }, 502)
    }
  }
} satisfies ExportedHandler<Env>
