import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useStore, useIsGuest } from '../store'
import { levelColors, poolLevel, usd } from '../money'
import Modal from './Modal'
import GuestsPanel from './GuestsPanel'
import { Check as CheckIcon, Circle } from './Icon'
import type { CodexStatus, MobileInfo } from '../../../shared/types'

function Check({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={ok ? 'text-zinc-200' : 'text-zinc-600'}>
        {ok ? <CheckIcon size={14} /> : <Circle size={14} />}
      </span>
      <span className={ok ? 'text-zinc-300' : 'text-zinc-500'}>{label}</span>
    </span>
  )
}

function SettingsModal(): React.JSX.Element {
  const show = useStore((s) => s.showSettings)
  const setShow = useStore((s) => s.setShowSettings)
  const isGuest = useIsGuest()
  const onClose = (): void => setShow(false)

  return (
    <Modal open={show} onClose={onClose} width={480}>
      <div className="mb-5 text-[15px] font-semibold tracking-tight text-zinc-50">Settings</div>
      {isGuest ? <GuestSettings onClose={onClose} /> : <HostSettings />}
      <div className="flex justify-end">
        <button onClick={onClose} className="btn btn-ghost">
          Close
        </button>
      </div>
    </Modal>
  )
}

// A guest's settings are about the credits they're using.
function GuestSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const balance = useStore((s) => s.guestBalance)
  const guest = useStore((s) => s.guest)
  const openCredits = useStore((s) => s.setShowCredits)
  const [leaving, setLeaving] = useState(false)
  const [copied, setCopied] = useState(false)

  // Something to paste to the host when Orcha misbehaves on this computer.
  const copyDiagnostics = async (): Promise<void> => {
    await window.orcha.clipboard.copy(await window.orcha.app.diagnostics())
    setCopied(true)
  }

  const leave = async (): Promise<void> => {
    if (
      !confirm(
        `Stop using ${guest?.hostName ?? 'your host'}'s credits on this computer? You'd need a new invite link to come back.`
      )
    ) {
      return
    }
    setLeaving(true)
    await window.orcha.guest.leave()
    window.location.reload()
  }

  return (
    <section className="mb-5">
      <div className="eyebrow mb-2.5">Credits</div>
      <div className="card p-3.5">
        <div className="mb-3 text-[12.5px] text-zinc-400">
          Shared with you by <span className="text-zinc-200">{guest?.hostName}</span>
        </div>
        <div className="flex flex-col gap-2">
          {(balance?.pools ?? []).map((p) => {
            const level = poolLevel(p)
            return (
              <div key={p.pool} className="tnum flex items-baseline justify-between text-[12.5px]">
                <span className="text-zinc-400">{p.label}</span>
                <span className={level === 'ok' ? 'text-zinc-200' : levelColors(level).text}>
                  {usd(Math.max(p.cap - p.spent, 0))} left
                  <span className="text-zinc-600"> of {usd(p.cap)}</span>
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-3.5 flex gap-1.5 border-t border-edge pt-3">
          <button
            onClick={() => {
              onClose()
              openCredits(true)
            }}
            className="btn btn-secondary btn-sm"
          >
            Usage details
          </button>
          <button
            onClick={leave}
            disabled={leaving}
            className="btn btn-ghost btn-sm ml-auto text-zinc-500"
          >
            Unpair this computer
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-zinc-500">
        Something not working?
        <button onClick={copyDiagnostics} className="btn btn-ghost btn-sm -ml-1.5 text-zinc-400">
          {copied ? `Copied, send it to ${guest?.hostName ?? 'your host'}` : 'Copy diagnostics'}
        </button>
      </div>
    </section>
  )
}

function HostSettings(): React.JSX.Element {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mobile, setMobile] = useState<MobileInfo | null>(null)
  const [pairQr, setPairQr] = useState<string | null>(null)

  const refresh = (): void => {
    window.orcha.codex.status().then(setStatus)
    window.orcha.mobile.info().then(setMobile)
  }

  useEffect(() => {
    refresh()
  }, [])

  // The QR only ever renders behind the `mobile.urls.length > 0` gate below,
  // so a stale data URL from a previous open can never show.
  useEffect(() => {
    if (!mobile || mobile.urls.length === 0) return
    let alive = true
    const payload = JSON.stringify({ v: 1, urls: mobile.urls, token: mobile.token })
    QRCode.toDataURL(payload, { margin: 1, width: 176 })
      .then((data) => alive && setPairQr(data))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mobile])

  const handleSetup = async (): Promise<void> => {
    setWorking(true)
    setError(null)
    try {
      await window.orcha.codex.setup()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <>
      <GuestsPanel />

      <section className="mb-5">
        <div className="eyebrow mb-2.5">Phone</div>
        <div className="card p-3.5">
          {mobile && mobile.urls.length > 0 ? (
            <div className="flex items-start gap-3.5">
              {pairQr && (
                <div className="shrink-0 rounded-lg bg-white p-1.5">
                  <img src={pairQr} alt="Pairing QR code" className="block h-32 w-32" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Check
                  ok={mobile.pushReady}
                  label={mobile.pushReady ? 'Phone paired' : 'No phone paired yet'}
                />
                <div className="mt-2 text-[12px] leading-relaxed text-zinc-500">
                  Scan from the Orcha app on your phone. Both devices need Tailscale signed in to
                  the same account.
                </div>
                <div className="mt-2 truncate font-mono text-[10.5px] text-zinc-600">
                  {mobile.urls[0]}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[12px] leading-relaxed text-zinc-500">
              {mobile === null
                ? 'Starting the companion server…'
                : "Companion server isn't running (no reachable address). Check that this machine has a network connection, then reopen Settings."}
            </div>
          )}
        </div>
      </section>

      <section className="mb-5">
        <div className="eyebrow mb-2.5">Codex plugin</div>
        <div className="card p-3.5">
          <div className="flex flex-col gap-2">
            <Check ok={status?.pluginInstalled ?? false} label="Claude Code plugin installed" />
            <Check ok={status?.cliInstalled ?? false} label="Codex CLI installed" />
            <Check ok={status?.authenticated ?? false} label="Codex CLI authenticated" />
          </div>

          {status && !status.cliInstalled && (
            <div className="mt-3 rounded-md bg-surface-0 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-500">
              Install and sign in to the Codex CLI first, from any terminal:
              <br />
              npm install -g @openai/codex
              <br />
              codex login --with-api-key
            </div>
          )}

          {error && <div className="mt-3 text-[12px] text-red-400">{error}</div>}

          <button
            onClick={handleSetup}
            disabled={working || (status?.pluginInstalled ?? false)}
            className="btn btn-secondary mt-3 w-full"
          >
            {working
              ? 'Setting up…'
              : status?.pluginInstalled
                ? 'Plugin installed'
                : 'Set up Codex plugin'}
          </button>
          <div className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-600">
            Adds OpenAI&apos;s official Claude Code plugin so any session can call out to Codex via{' '}
            <code className="font-mono">/codex:review</code>,{' '}
            <code className="font-mono">/codex:rescue</code>, etc. Applies to every Claude Code
            session on this machine, not just Orcha&apos;s.
          </div>
        </div>
      </section>
    </>
  )
}

export default SettingsModal
