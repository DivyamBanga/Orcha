import { useEffect, useRef, useState } from 'react'
import { useStore, useIsGuest, useCodexAvailable } from '../store'
import { codexModel, poolFor, poolState, sessionCost, usd } from '../money'
import type { Agent, Workspace, WorkspaceAuth } from '../../../shared/types'

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const CLAUDE_MODELS: [string, string][] = [
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
  ['haiku', 'Haiku']
]

function usePopoverDismiss(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void): void {
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
  }, [ref, onClose])
}

// Anchored under the header's "Session" trigger.
function SessionPopover({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const isGuest = useIsGuest()
  const codex = useCodexAvailable()
  const ref = useRef<HTMLDivElement>(null)
  usePopoverDismiss(ref, onClose)
  return (
    <div
      ref={ref}
      style={{ transformOrigin: 'top right' }}
      className="popover absolute right-4 top-12 z-40 w-[300px] p-3.5"
    >
      {isGuest ? (
        <AgentPicker workspace={workspace} onClose={onClose} showCost />
      ) : (
        <>
          {codex && <AgentPicker workspace={workspace} onClose={onClose} showCost={false} />}
          {workspace.agent === 'claude' && (
            <div className={codex ? 'mt-4 border-t border-edge pt-3.5' : ''}>
              <HostSession workspace={workspace} onClose={onClose} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// What the tab runs — Claude Code or Codex, and which model. A guest also
// sees what it has cost, and models whose budget is used up can't be picked.
function AgentPicker({
  workspace,
  onClose,
  showCost
}: {
  workspace: Workspace
  onClose: () => void
  showCost: boolean
}): React.JSX.Element {
  const balance = useStore((s) => s.guestBalance)
  const catalog = useStore((s) => s.catalog)
  const codexDefault = codexModel(null, catalog)?.id ?? 'gpt-6-sol'
  const codexChoices: [string, string][] = (catalog?.models ?? [])
    .filter((m) => m.codex)
    .map((m) => [m.id, m.label])
  const load = useStore((s) => s.load)
  const cost = sessionCost(balance, workspace.id)
  const [agent, setAgent] = useState<Agent>(workspace.agent)
  const [model, setModel] = useState<string>(
    workspace.model ?? (workspace.agent === 'codex' ? codexDefault : 'sonnet')
  )
  const [saving, setSaving] = useState(false)
  const models = agent === 'codex' ? codexChoices : CLAUDE_MODELS
  const empty = (a: Agent, m: string): boolean => {
    const p = poolState(balance, poolFor(a, m, catalog))
    return p !== null && p.spent >= p.cap
  }
  const current = workspace.model ?? (workspace.agent === 'codex' ? codexDefault : 'sonnet')
  const changed = agent !== workspace.agent || model !== current

  const pickAgent = (next: Agent): void => {
    setAgent(next)
    setModel(next === 'codex' ? codexDefault : 'sonnet')
  }

  const apply = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.orcha.session.setAgent(workspace.id, agent, model)
      await load()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="eyebrow">This tab</span>
        {showCost && (
          <span className="tnum text-[12px] text-zinc-400">
            {cost === null ? 'nothing spent yet' : `${usd(cost)} so far`}
          </span>
        )}
      </div>

      <div className="field-label">Agent</div>
      <div className="segmented mb-3">
        {(
          [
            ['claude', 'Claude Code'],
            ['codex', 'Codex']
          ] as [Agent, string][]
        ).map(([a, label]) => (
          <button key={a} data-active={agent === a} onClick={() => pickAgent(a)}>
            {label}
          </button>
        ))}
      </div>

      <div className="field-label">Model</div>
      <div className="segmented mb-4">
        {models.map(([m, label]) => (
          <button
            key={m}
            data-active={model === m}
            disabled={empty(agent, m)}
            onClick={() => setModel(m)}
            title={empty(agent, m) ? 'This budget is used up' : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        onClick={apply}
        disabled={saving || !changed || empty(agent, model)}
        className="btn btn-primary w-full"
      >
        {saving ? 'Restarting…' : changed ? 'Switch and restart' : 'No changes'}
      </button>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-500">
        The tab restarts on the new model. Claude picks up its conversation where it left off;
        switching agent starts that agent&apos;s own history in this folder.
      </p>
    </>
  )
}

// The host's own session: local token usage, plus the auth-mode override
// (subscription login vs. an API key), which applies on the next restart.
function HostSession({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const usage = useStore((s) => s.usage[workspace.id])
  const [auth, setAuth] = useState<WorkspaceAuth>({ mode: 'subscription' })
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.orcha.workspaces.authGet(workspace.id).then((a) => {
      setAuth(a)
      setApiKeyInput(a.apiKey ?? '')
    })
  }, [workspace.id])

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
    <>
      <div className="eyebrow mb-2">Usage this session</div>
      {usage ? (
        <div className="tnum mb-4 flex items-center gap-3 font-mono text-[12px] text-zinc-300">
          <span>{formatTokens(usage.inputTokens)} in</span>
          <span>{formatTokens(usage.outputTokens)} out</span>
          {usage.estimatedCostUsd !== null && (
            <span className="text-zinc-500">~${usage.estimatedCostUsd.toFixed(2)}</span>
          )}
        </div>
      ) : (
        <div className="mb-4 font-mono text-[12px] text-zinc-600">No activity yet</div>
      )}

      <div className="eyebrow mb-2">Auth mode</div>
      <div className="segmented mb-2.5">
        {(['subscription', 'apiKey'] as const).map((m) => (
          <button
            key={m}
            data-active={auth.mode === m}
            onClick={() => setAuth((a) => ({ ...a, mode: m }))}
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
          className="input mb-2.5"
        />
      )}
      <button
        onClick={handleApply}
        disabled={saving || (auth.mode === 'apiKey' && !apiKeyInput.trim())}
        className="btn btn-primary w-full"
      >
        {saving ? 'Restarting…' : 'Restart to apply'}
      </button>
    </>
  )
}

export default SessionPopover
