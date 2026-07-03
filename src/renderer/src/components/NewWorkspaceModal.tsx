import { useState } from 'react'
import { useStore } from '../store'

function NewWorkspaceModal(): React.JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const show = useStore((s) => s.showNewWorkspace)
  const setShow = useStore((s) => s.setShowNewWorkspace)
  const createWorkspace = useStore((s) => s.createWorkspace)

  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  if (!show) return null

  const selectedProject = projectId || projects[0]?.id || ''

  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || !selectedProject) return
    setCreating(true)
    try {
      await createWorkspace(selectedProject, name.trim())
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
      onClick={() => setShow(false)}
    >
      <div
        className="w-96 rounded-lg border border-zinc-800 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-medium text-zinc-100">New workspace</div>

        <label className="mb-1 block text-zinc-500">Project</label>
        <select
          value={selectedProject}
          onChange={(e) => setProjectId(e.target.value)}
          className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-zinc-500">Task name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="fix-auth-flow"
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setShow(false)}
            className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="rounded-md bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default NewWorkspaceModal
