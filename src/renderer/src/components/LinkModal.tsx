import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useStore } from '../store'
import Modal from './Modal'

// One modal for both link features: live share (public read-only terminal
// view) and phone connect (Claude Code Remote Control). Kicks off the request
// when opened, shows progress, then the QR + link.
function LinkModal(): React.JSX.Element {
  const modal = useStore((s) => s.linkModal)
  const setLinkModal = useStore((s) => s.setLinkModal)
  // The last request stays rendered while the dialog animates closed.
  const [last, setLast] = useState(modal)
  if (modal !== null && modal !== last) setLast(modal)
  return (
    <Modal open={modal !== null} onClose={() => setLinkModal(null)} width={400}>
      {last && (
        <LinkModalInner
          key={`${last.kind}:${last.workspaceId}`}
          kind={last.kind}
          workspaceId={last.workspaceId}
          onClose={() => setLinkModal(null)}
        />
      )}
    </Modal>
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
      ? 'Connecting — typing /remote-control into the session…'
      : sharePhase === 'downloading'
        ? 'Downloading the tunnel helper (one time, ~60 MB)…'
        : sharePhase === 'tunnel'
          ? 'Opening a secure tunnel…'
          : 'Starting the share…'

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
    <>
      <div className="text-[15px] font-semibold tracking-tight text-zinc-50">
        {title}
        {workspace && <span className="font-normal text-zinc-500"> · {workspace.name}</span>}
      </div>
      <p className="mt-1 mb-5 text-[12.5px] leading-relaxed text-zinc-500">
        {kind === 'share'
          ? 'Anyone with this link can watch the terminal live (read-only) in a browser until you stop sharing. Nothing to install on their end.'
          : 'Steer this session from the Claude app or claude.ai/code. It keeps running on this machine.'}
      </p>

      {error ? (
        <div className="mb-5 select-text rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-red-300">
          {error}
        </div>
      ) : url ? (
        <div className="fade-late mb-5 flex flex-col items-center gap-3.5">
          {qr && (
            <div className="rounded-xl bg-white p-2">
              <img src={qr} alt="QR code" className="block h-52 w-52" />
            </div>
          )}
          <div className="flex w-full items-center gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="input font-mono text-[11px]"
            />
            <button onClick={copy} className="btn btn-primary h-8 shrink-0">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {kind === 'phone' && (
            <div className="text-[12px] text-zinc-500">
              Scan with your phone camera — it opens in the Claude app
            </div>
          )}
        </div>
      ) : (
        <div className="mb-5 flex items-center gap-2.5 py-6 text-[12.5px] text-zinc-400">
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
            className="btn btn-primary"
          >
            Try again
          </button>
        )}
        {kind === 'share' && url && (
          <button onClick={stopShare} className="btn btn-danger">
            Stop sharing
          </button>
        )}
        <button onClick={onClose} className="btn btn-ghost">
          Close
        </button>
      </div>
    </>
  )
}

export default LinkModal
