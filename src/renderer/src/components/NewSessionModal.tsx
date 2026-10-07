import { useState } from 'react'
import { useStore, useIsGuest, useCodexAvailable } from '../store'
import { codexModel, poolFor, poolState } from '../money'
import Modal from './Modal'
import type { Agent } from '../../../shared/types'

// Creates a parallel session: a git worktree + branch opened as another tab.
// Opened from a project's context menu, which preselects that project.
function NewSessionModal(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const show = useStore((s) => s.showNewSession)
  const setShow = useStore((s) => s.setShowNewSession)
  const createParallelSession = useStore((s) => s.createParallelSession)
  const balance = useStore((s) => s.guestBalance)
  const isGuest = useIsGuest()
  const codexAvailable = useCodexAvailable()
  const catalog = useStore((s) => s.catalog)
  const codexDefault = codexModel(null, catalog)?.id ?? 'gpt-6-sol'

  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<Agent>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remember which project the dialog was opened for, so its contents stay put
  // while it animates closed.
  const [lastShow, setLastShow] = useState(show)
  if (show !== null && show !== lastShow) setLastShow(show)

  const selectedProject = projectId || lastShow || projects[0]?.id || ''

  const empty = (a: Agent, m: string): boolean => {
    const p = poolState(balance, poolFor(a, m || null, catalog))
    return p !== null && p.spent >= p.cap
  }

  const modelChoices: [string, string][] =
    agent === 'codex'
      ? (catalog?.models ?? [])
          .filter((m) => m.codex)
          .map((m): [string, string] => [m.id === codexDefault ? '' : m.id, m.label])
      : isGuest
        ? [
            ['', 'Sonnet'],
            ['opus', 'Opus'],
            ['haiku', 'Haiku']
          ]
        : [
            ['', 'Default'],
            ['opus', 'Opus'],
            ['sonnet', 'Sonnet'],
            ['haiku', 'Haiku']
          ]

  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || !selectedProject) return
    setCreating(true)
    setError(null)
    try {
      const chosen = agent === 'codex' ? model || codexDefault : model || null
      await createParallelSession(selectedProject, name.trim(), chosen, effort || null, agent)
      setName('')
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : String(err)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal open={show !== null} onClose={() => setShow(null)} dismissable={!creating} width={420}>
      <div className="text-[15px] font-semibold tracking-tight text-zinc-50">
        New parallel session
      </div>
      <p className="mt-1 mb-5 text-[12.5px] leading-relaxed text-zinc-500">
        Its own worktree and branch on the same repo — work on a second thing while the main session
        keeps going.
      </p>

      <label className="field-label">Project</label>
      <select
        value={selectedProject}
        onChange={(e) => setProjectId(e.target.value)}
        className="input mb-3"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <label className="field-label" htmlFor="task-name">
        Task name <span className="font-normal text-zinc-600">(becomes the branch)</span>
      </label>
      <input
        id="task-name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        placeholder="fix-auth-flow"
        className="input mb-3"
      />

      {codexAvailable && (
        <>
          <label className="field-label">Agent</label>
          <div className="segmented mb-3">
            {(
              [
                ['claude', 'Claude Code'],
                ['codex', 'Codex']
              ] as [Agent, string][]
            ).map(([a, label]) => (
              <button
                key={a}
                data-active={agent === a}
                onClick={() => {
                  setAgent(a)
                  setModel('')
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="field-label">Model</label>
      <div className="segmented mb-3">
        {modelChoices.map(([value, label]) => (
          <button
            key={value}
            type="button"
            data-active={model === value}
            disabled={isGuest && empty(agent, value)}
            title={isGuest && empty(agent, value) ? 'This budget is used up' : undefined}
            onClick={() => setModel(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {agent === 'claude' && (
        <>
          <label className="field-label">Effort</label>
          <div className="segmented mb-5">
            {(
              [
                ['', 'Default'],
                ['low', 'Low'],
                ['medium', 'Med'],
                ['high', 'High'],
                ['xhigh', 'X-High'],
                ['max', 'Max']
              ] as [string, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-active={effort === value}
                onClick={() => setEffort(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {error && <div className="mb-3 text-[12px] text-red-400">{error}</div>}

      <div className={`flex justify-end gap-2 ${agent === 'codex' ? 'mt-5' : ''}`}>
        <button onClick={() => setShow(null)} className="btn btn-ghost">
          Cancel
        </button>
        <button
          onClick={handleCreate}
          disabled={creating || !name.trim() || (isGuest && empty(agent, model))}
          className="btn btn-primary"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  )
}

export default NewSessionModal
