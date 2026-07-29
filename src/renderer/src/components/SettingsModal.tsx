import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useStore } from '../store'
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

function SettingsModal(): React.JSX.Element | null {
  const show = useStore((s) => s.showSettings)
  const setShow = useStore((s) => s.setShowSettings)
  const onClose = (): void => setShow(false)

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
    if (show) refresh()
  }, [show])

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

  if (!show) return null

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[26rem] rounded-lg border border-edge-bright bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-medium text-zinc-100">Settings</div>

        <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-zinc-600">
          Phone
        </div>
        <div className="mb-3 rounded-lg border border-edge bg-surface-2/40 p-3">
          {mobile && mobile.urls.length > 0 ? (
            <div className="flex items-start gap-3">
              {pairQr && (
                <div className="shrink-0 rounded-md bg-white p-1.5">
                  <img src={pairQr} alt="Pairing QR code" className="block h-32 w-32" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Check
                  ok={mobile.pushReady}
                  label={mobile.pushReady ? 'Phone paired' : 'No phone paired yet'}
                />
                <div className="mt-2 font-mono text-[11px] leading-relaxed text-zinc-500">
                  Scan from the Orcha app on your phone. Both devices need Tailscale signed in to
                  the same account.
                </div>
                <div className="mt-2 truncate font-mono text-[10px] text-zinc-600">
                  {mobile.urls[0]}
                </div>
              </div>
            </div>
          ) : (
            <div className="font-mono text-[11px] leading-relaxed text-zinc-500">
              Companion server isn&apos;t running (no reachable address). Check that this machine
              has a network connection, then reopen Settings.
            </div>
          )}
        </div>

        <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-zinc-600">
          Codex
        </div>
        <div className="mb-3 rounded-lg border border-edge bg-surface-2/40 p-3">
          <div className="flex flex-col gap-2">
            <Check ok={status?.pluginInstalled ?? false} label="Claude Code plugin installed" />
            <Check ok={status?.cliInstalled ?? false} label="Codex CLI installed" />
            <Check ok={status?.authenticated ?? false} label="Codex CLI authenticated" />
          </div>

          {status && !status.cliInstalled && (
            <div className="mt-3 rounded-md bg-surface-0/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-500">
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
            className="mt-3 w-full rounded-md border border-zinc-100 bg-zinc-100 px-3 py-1.5 font-medium text-surface-0 hover:border-white hover:bg-white disabled:opacity-50"
          >
            {working
              ? 'Setting up…'
              : status?.pluginInstalled
                ? 'Plugin installed'
                : 'Set up Codex plugin'}
          </button>
        </div>

        <div className="mb-4 font-mono text-[11px] leading-relaxed text-zinc-600">
          Adds OpenAI&apos;s official Claude Code plugin so any session can call out to Codex via{' '}
          <code>/codex:review</code>, <code>/codex:rescue</code>, etc. Applies to every Claude Code
          session on this machine, not just Orcha&apos;s.
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-surface-2"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
