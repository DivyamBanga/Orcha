import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { levelColors, poolLevel, usd } from '../money'
import type { AdminGuest, CreditPool } from '../../../shared/types'

// What a new invite starts with in each budget, before you change it.
const DEFAULT_CAP = '50'

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function lastSeen(at: number | null, now: number): string {
  if (at === null) return 'no usage yet'
  const hours = Math.floor((now - at) / 3_600_000)
  if (hours < 1) return 'active this hour'
  if (hours < 24) return `active ${hours}h ago`
  return `active ${Math.floor(hours / 24)}d ago`
}

function InviteLink({ url, name }: { url: string; name: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="card fade-late mt-3 p-3">
      <div className="mb-2 text-[12px] text-zinc-400">
        Send this to {name}. It works once, for 7 days, and needs nothing else.
      </div>
      <div className="flex gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="input font-mono text-[11px]"
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="btn btn-primary h-8 shrink-0"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

function GuestCard({
  guest,
  now,
  onChange
}: {
  guest: AdminGuest
  now: number
  onChange: (next: AdminGuest) => void
}): React.JSX.Element {
  const [topUp, setTopUp] = useState<{ pool: CreditPool; amount: string } | null>(null)
  const [invite, setInvite] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const applyTopUp = (): Promise<void> | void => {
    if (!topUp) return
    const amount = Number(topUp.amount)
    if (!Number.isFinite(amount) || amount === 0) return
    return act(async () => {
      onChange(await window.orcha.relayAdmin.topUp(guest.id, topUp.pool, amount))
      setTopUp(null)
    })
  }

  const revoked = guest.status === 'revoked'

  return (
    <div className="card p-3.5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium text-zinc-100">{guest.name}</span>
          <span className="ml-2 text-[11.5px] text-zinc-500">
            {revoked
              ? 'access off'
              : guest.paired
                ? lastSeen(guest.lastActiveAt, now)
                : 'invite not used yet'}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {guest.pools.map((p) => {
          const level = poolLevel(p)
          const colors = levelColors(level)
          const pct = p.cap > 0 ? Math.min((p.spent / p.cap) * 100, 100) : 100
          return (
            <div key={p.pool}>
              <div className="tnum flex items-baseline justify-between text-[12px]">
                <span className="text-zinc-400">{p.label}</span>
                <span className="flex items-center gap-2">
                  <span className={level === 'ok' ? 'text-zinc-300' : colors.text}>
                    {usd(p.spent)} <span className="text-zinc-600">of</span> {usd(p.cap)}
                  </span>
                  <button
                    onClick={() => setTopUp({ pool: p.pool, amount: '25' })}
                    className="btn btn-ghost btn-sm h-5 px-1.5 text-[11px] text-zinc-500"
                  >
                    Top up
                  </button>
                </span>
              </div>
              <div className="meter mt-1.5 h-1">
                <div className={`meter-fill ${colors.fill}`} style={{ width: `${pct}%` }} />
              </div>
              {topUp?.pool === p.pool && (
                <div className="fade-late mt-2 flex items-center gap-2">
                  {[10, 25, 50].map((n) => (
                    <button
                      key={n}
                      data-active={topUp.amount === String(n)}
                      onClick={() => setTopUp({ pool: p.pool, amount: String(n) })}
                      className="btn btn-secondary btn-sm"
                    >
                      +${n}
                    </button>
                  ))}
                  <input
                    value={topUp.amount}
                    onChange={(e) => setTopUp({ pool: p.pool, amount: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && applyTopUp()}
                    className="input tnum h-6 w-16 px-2 text-[12px]"
                    aria-label="Top-up amount in dollars"
                  />
                  <button
                    onClick={applyTopUp}
                    disabled={busy}
                    className="btn btn-primary btn-sm ml-auto"
                  >
                    Add
                  </button>
                  <button onClick={() => setTopUp(null)} className="btn btn-ghost btn-sm">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {error && <div className="mt-2.5 text-[12px] text-red-400">{error}</div>}
      {invite && <InviteLink url={invite} name={guest.name} />}

      <div className="mt-3 flex gap-1.5 border-t border-edge pt-3">
        <button
          onClick={() =>
            act(async () => setInvite((await window.orcha.relayAdmin.invite(guest.id)).inviteUrl))
          }
          disabled={busy || revoked}
          className="btn btn-ghost btn-sm"
          title="A fresh one-time link — for a new computer. Using it signs out the old one."
        >
          New link
        </button>
        <button
          onClick={() =>
            act(async () =>
              onChange(
                await window.orcha.relayAdmin.access(guest.id, revoked ? 'restore' : 'revoke')
              )
            )
          }
          disabled={busy}
          className={`btn btn-sm ${revoked ? 'btn-secondary' : 'btn-ghost text-zinc-500'}`}
        >
          {revoked ? 'Turn access back on' : 'Turn off access'}
        </button>
      </div>
    </div>
  )
}

function InviteForm({
  onCreated
}: {
  onCreated: (guest: AdminGuest, url: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [hostName, setHostName] = useState('')
  // Every budget the relay has (the catalog lists them all, Claude included).
  const pools = useStore((s) => s.catalog?.pools ?? [])
  const [caps, setCaps] = useState<Record<CreditPool, string>>({})
  const capFor = (pool: CreditPool): string => caps[pool] ?? DEFAULT_CAP
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.orcha.ui
      .getState('hostName')
      .then((v) => v && setHostName(v))
      .catch(() => {})
  }, [])

  const create = async (): Promise<void> => {
    if (!name.trim() || !hostName.trim()) return
    setBusy(true)
    setError(null)
    try {
      window.orcha.ui.saveState('hostName', hostName.trim()).catch(() => {})
      const numbers = Object.fromEntries(
        pools.map((p) => [p.id, Math.max(0, Number(capFor(p.id)) || 0)])
      ) as Record<CreditPool, number>
      const { guest, inviteUrl } = await window.orcha.relayAdmin.create(
        name.trim(),
        hostName.trim(),
        numbers
      )
      onCreated(guest, inviteUrl)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card fade-late mb-3 p-3.5">
      <div className="mb-3 flex gap-2">
        <div className="flex-1">
          <label className="field-label">Their name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex"
            className="input"
          />
        </div>
        <div className="flex-1">
          <label className="field-label">Your name</label>
          <input
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder="shown to them"
            className="input"
          />
        </div>
      </div>
      <label className="field-label">Budgets (one-time, top up anytime)</label>
      <div
        className="mb-3 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(pools.length, 1)}, minmax(0, 1fr))` }}
      >
        {pools.map((p) => (
          <div key={p.id}>
            <div className="mb-1 text-[11.5px] text-zinc-500">{p.label}</div>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500">
                $
              </span>
              <input
                value={capFor(p.id)}
                onChange={(e) => setCaps((c) => ({ ...c, [p.id]: e.target.value }))}
                className="input tnum pl-5"
                aria-label={`${p.label} budget in dollars`}
              />
            </div>
          </div>
        ))}
      </div>
      {error && <div className="mb-2 text-[12px] text-red-400">{error}</div>}
      <button
        onClick={create}
        disabled={busy || !name.trim() || !hostName.trim()}
        className="btn btn-primary w-full"
      >
        {busy ? 'Creating…' : 'Create invite link'}
      </button>
    </div>
  )
}

// Settings → Guests, on the host's machine: everyone invited to use your
// credits through your relay, live.
function GuestsPanel(): React.JSX.Element | null {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [guests, setGuests] = useState<AdminGuest[] | null>(null)
  const [now, setNow] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null)

  const refresh = useCallback((): void => {
    window.orcha.relayAdmin
      .guests()
      .then((list) => {
        setGuests(list)
        setNow(Date.now())
        setError(null)
      })
      .catch((err) => setError(cleanError(err)))
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    window.orcha.relayAdmin.status().then((s) => {
      setConfigured(s.configured)
      if (!s.configured) return
      refresh()
      timer = setInterval(refresh, 20_000)
    })
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [refresh])

  if (!configured) return null

  return (
    <section className="mb-5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="eyebrow">Guests</span>
        {!inviting && (
          <button
            onClick={() => {
              setInviting(true)
              setCreated(null)
            }}
            className="btn btn-ghost btn-sm -mr-2"
          >
            Invite someone
          </button>
        )}
      </div>

      {inviting && (
        <InviteForm
          onCreated={(guest, url) => {
            setInviting(false)
            setCreated({ name: guest.name, url })
            setGuests((g) => [...(g ?? []), guest])
          }}
        />
      )}
      {created && <InviteLink url={created.url} name={created.name} />}

      {error && <div className="mb-2 text-[12px] text-red-400">{error}</div>}
      {guests === null ? (
        !error && (
          <div className="flex items-center gap-2 py-3 text-[12px] text-zinc-500">
            <span className="busy-ring" /> Loading guests…
          </div>
        )
      ) : guests.length === 0 && !inviting ? (
        <div className="text-[12.5px] leading-relaxed text-zinc-500">
          Nobody yet. Invite someone to give them Orcha on your credits, with a cap on each budget.
        </div>
      ) : (
        <div className={`flex flex-col gap-2.5 ${created ? 'mt-3' : ''}`}>
          {guests.map((g) => (
            <GuestCard
              key={g.id}
              guest={g}
              now={now ?? g.createdAt}
              onChange={(next) =>
                setGuests((list) =>
                  (list ?? []).map((x) => (x.id === next.id ? { ...x, ...next } : x))
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default GuestsPanel
