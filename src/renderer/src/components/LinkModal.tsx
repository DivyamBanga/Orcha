import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useStore } from '../store'

// One modal for both link features: live share (public read-only terminal
// view) and phone connect (Claude Code Remote Control). Kicks off the request
// when opened, shows progress, then the QR + link.
function LinkModal(): React.JSX.Element | null {
  const modal = useStore((s) => s.linkModal)
  const setLinkModal = useStore((s) => s.setLinkModal)
  if (!modal) return null
  return (
    <LinkModalInner
      key={`${modal.kind}:${modal.workspaceId}`}
      kind={modal.kind}
      workspaceId={modal.workspaceId}
      onClose={() => setLinkModal(null)}
    />
  )
}

function LinkModalInner({
  kind,
  workspaceId,
  onClose
}: {
  kind: 'share' | 'phone'
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const sharePhase = useStore((s) => s.shareStatus[workspaceId]?.phase)
  const [url, setUrl] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    const request =
      kind === 'share'
        ? window.orcha.share.start(workspaceId)
        : window.orcha.session.remoteControl(workspaceId)
    request
      .then((r) => alive && setUrl(r.url))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [kind, workspaceId, attempt])

  useEffect(() => {
    if (!url) return
    QRCode.toDataURL(url, { margin: 1, width: 208 })
      .then(setQr)
      .catch(() => {})
  }, [url])

  const title = kind === 'share' ? 'Share live view' : 'Connect your phone'
  const working =
    kind === 'phone'
      ? 'connecting — typing /remote-control into the session…'
      : sharePhase === 'downloading'
        ? 'downloading tunnel helper (one time, ~60 MB)…'
        : sharePhase === 'tunnel'
          ? 'opening secure tunnel…'
          : 'starting share…'

  const copy = (): void => {
    if (!url) return
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const stopShare = (): void => {
    window.orcha.share.stop(workspaceId).catch(() => {})
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg border border-edge-bright bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-medium text-zinc-100">
          {title}
          {workspace && <span className="text-zinc-500"> — {workspace.name}</span>}
        </div>
        <div className="mb-3 font-mono text-[11px] leading-relaxed text-zinc-600">
          {kind === 'share'
            ? 'Anyone with this link can watch the terminal live (read-only) in a browser until you stop sharing. No install needed on their end.'
            : 'Steer this session from the Claude app or claude.ai/code. The session keeps running on this machine.'}
        </div>

        {error ? (
          <div className="mb-4 select-text rounded border border-red-900/60 bg-red-950/30 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-400">
            {error}
          </div>
        ) : url ? (
          <div className="mb-4 flex flex-col items-center gap-3">
            {qr && (
              <div className="rounded-md bg-white p-2">
                <img src={qr} alt="QR code" className="block h-52 w-52" />
              </div>
            )}
            <div className="flex w-full items-center gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-zinc-300"
              />
              <button
                onClick={copy}
                className="shrink-0 rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {kind === 'phone' && (
              <div className="font-mono text-[11px] text-zinc-600">
                scan with your phone camera — opens in the Claude app
              </div>
            )}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 py-6 font-mono text-[12px] text-zinc-500">
            <span className="busy-ring" />
            {working}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {error && (
            <button
              onClick={() => {
                setError(null)
                setAttempt((a) => a + 1)
              }}
              className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30"
            >
              Try again
            </button>
          )}
          {kind === 'share' && url && (
            <button
              onClick={stopShare}
              className="rounded-md border border-red-900/60 px-3 py-1.5 text-red-400 hover:bg-red-950/40"
            >
              Stop sharing
            </button>
          )}
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

export default LinkModal
