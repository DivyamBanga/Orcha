import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Workspace, WorkspaceAuth } from '../../../shared/types'

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// Anchored under the header's "Session" trigger. Houses per-session token
// usage (session-scoped, estimated — see claudeSessions.sessionUsage) and
// the auth-mode toggle (subscription login vs. an API key), which applies
// on the next restart of this workspace's pty.
function SessionPopover({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const usage = useStore((s) => s.usage[workspace.id])
  const ref = useRef<HTMLDivElement>(null)
  const [auth, setAuth] = useState<WorkspaceAuth>({ mode: 'subscription' })
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.orcha.workspaces.authGet(workspace.id).then((a) => {
      setAuth(a)
      setApiKeyInput(a.apiKey ?? '')
    })
  }, [workspace.id])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const handleApply = async (): Promise<void> => {
    const ok = confirm(
      'Restart this session to apply the new auth mode? The conversation resumes automatically.'
    )
    if (!ok) return
    setSaving(true)
    try {
      const next: WorkspaceAuth =
        auth.mode === 'apiKey'
          ? { mode: 'apiKey', apiKey: apiKeyInput.trim() }
          : { mode: 'subscription' }
      await window.orcha.workspaces.authSet(workspace.id, next)
      await window.orcha.pty.restart(workspace.id, 120, 30)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={ref}
      className="absolute right-4 top-11 z-40 w-72 rounded-lg border border-edge-bright bg-surface-1 p-3 shadow-lg"
    >
      <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-zinc-600">
        Usage this session
      </div>
      {usage ? (
        <div className="mb-3 flex items-center gap-3 font-mono text-[12px] text-zinc-300">
          <span>{formatTokens(usage.inputTokens)} in</span>
          <span>{formatTokens(usage.outputTokens)} out</span>
          {usage.estimatedCostUsd !== null && (
            <span className="text-zinc-500">~${usage.estimatedCostUsd.toFixed(2)}</span>
          )}
        </div>
      ) : (
        <div className="mb-3 font-mono text-[12px] text-zinc-600">No activity yet</div>
      )}

      <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-zinc-600">
        Auth mode
      </div>
      <div className="mb-2 flex rounded-md border border-edge">
        {(['subscription', 'apiKey'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setAuth((a) => ({ ...a, mode: m }))}
            className={`flex-1 px-2 py-1 text-[12px] ${
              auth.mode === m ? 'bg-surface-2 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {m === 'subscription' ? 'Subscription' : 'API key'}
          </button>
        ))}
      </div>
      {auth.mode === 'apiKey' && (
        <input
          type="password"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder="sk-ant-..."
          className="mb-2 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
        />
      )}
      <button
        onClick={handleApply}
        disabled={saving || (auth.mode === 'apiKey' && !apiKeyInput.trim())}
        className="w-full rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-50"
      >
        {saving ? 'Restarting…' : 'Restart to apply'}
      </button>
    </div>
  )
}

export default SessionPopover
