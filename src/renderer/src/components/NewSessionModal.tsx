import { useState } from 'react'
import { useStore } from '../store'

// Creates a parallel session: a git worktree + branch opened as another tab.
// Opened from a project's context menu, which preselects that project.
function NewSessionModal(): React.JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const show = useStore((s) => s.showNewSession)
  const setShow = useStore((s) => s.setShowNewSession)
  const createParallelSession = useStore((s) => s.createParallelSession)

  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [creating, setCreating] = useState(false)

  if (show === null) return null

  const selectedProject = projectId || show || projects[0]?.id || ''

  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || !selectedProject) return
    setCreating(true)
    try {
      await createParallelSession(selectedProject, name.trim(), model || null, effort || null)
      setName('')
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => setShow(null)}
    >
      <div
        className="w-96 rounded-lg border border-edge-bright bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-medium text-zinc-100">New parallel session</div>
        <div className="mb-3 font-mono text-[11px] leading-relaxed text-zinc-600">
          Separate worktree + branch on the same repo — work on a second feature while the main
          session keeps going.
        </div>

        <label className="mb-1 block text-zinc-500">Project</label>
        <select
          value={selectedProject}
          onChange={(e) => setProjectId(e.target.value)}
          className="mb-3 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-zinc-500">Task name (becomes the branch)</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="fix-auth-flow"
          className="mb-3 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
        />

        <label className="mb-1 block text-zinc-500">Model</label>
        <div className="mb-3 flex rounded-md border border-edge">
          {(
            [
              ['', 'Default'],
              ['opus', 'Opus'],
              ['sonnet', 'Sonnet'],
              ['haiku', 'Haiku']
            ] as [string, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setModel(value)}
              className={`flex-1 px-2 py-1.5 ${
                model === value ? 'bg-surface-2 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="mb-1 block text-zinc-500">Effort</label>
        <div className="mb-4 flex rounded-md border border-edge">
          {(
            [
              ['', 'Default'],
              ['low', 'Low'],
              ['medium', 'Medium'],
              ['high', 'High'],
              ['xhigh', 'X-High'],
              ['max', 'Max']
            ] as [string, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setEffort(value)}
              className={`flex-1 px-1 py-1.5 text-[11px] ${
                effort === value
                  ? 'bg-surface-2 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setShow(null)}
            className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default NewSessionModal
