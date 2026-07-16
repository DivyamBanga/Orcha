import { useEffect, useState } from 'react'
import { useStore } from '../store'

type Mode = 'new' | 'github' | 'local' | 'remote'

function NewProjectModal(): React.JSX.Element | null {
  const show = useStore((s) => s.showNewProject)
  const setShow = useStore((s) => s.setShowNewProject)
  const load = useStore((s) => s.load)
  const setActive = useStore((s) => s.setActive)

  const [mode, setMode] = useState<Mode>('new')
  const [name, setName] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [repos, setRepos] = useState<{ nameWithOwner: string; name: string }[] | null>(null)
  const [filter, setFilter] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [remotePath, setRemotePath] = useState('')

  // Load the GitHub repo list once when that tab is opened.
  useEffect(() => {
    if (show && mode === 'github' && repos === null) {
      window.orcha.projects
        .listGithub()
        .then(setRepos)
        .catch((err) => alert(err instanceof Error ? err.message : String(err)))
    }
  }, [show, mode, repos])

  if (!show) return null

  const finish = async (projectRepoPath?: string): Promise<void> => {
    await load()
    const state = useStore.getState()
    const project = projectRepoPath
      ? state.projects.find((p) => p.repoPath === projectRepoPath)
      : undefined
    const main = state.workspaces.find(
      (w) => project && w.projectId === project.id && w.kind === 'main'
    )
    if (main) setActive(main.id)
    setShow(false)
    setName('')
    setWorking(null)
  }

  const handleCreate = async (): Promise<void> => {
    const repoName = name.trim()
    if (!repoName) return
    setWorking('Creating GitHub repo…')
    try {
      const project = await window.orcha.projects.createRepo(repoName, isPrivate)
      await finish(project.repoPath)
    } catch (err) {
      setWorking(null)
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleClone = async (nameWithOwner: string): Promise<void> => {
    setWorking(`Cloning ${nameWithOwner}…`)
    try {
      const project = await window.orcha.projects.cloneGithub(nameWithOwner)
      await finish(project.repoPath)
    } catch (err) {
      setWorking(null)
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleLocal = async (): Promise<void> => {
    try {
      const project = await window.orcha.projects.add()
      if (project) await finish(project.repoPath)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRemote = async (): Promise<void> => {
    const trimmedHost = host.trim()
    const trimmedUser = user.trim()
    const trimmedPath = remotePath.trim()
    if (!trimmedHost || !trimmedUser || !trimmedPath) return
    const parsedPort = port.trim() ? Number(port.trim()) : null
    setWorking(`Connecting to ${trimmedHost}…`)
    try {
      const project = await window.orcha.projects.addRemote(
        trimmedHost,
        trimmedUser,
        parsedPort,
        trimmedPath
      )
      await finish(project.repoPath)
    } catch (err) {
      setWorking(null)
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const filtered = (repos ?? []).filter((r) =>
    r.nameWithOwner.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => !working && setShow(false)}
    >
      <div
        className="w-[26rem] rounded-lg border border-edge-bright bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-medium text-zinc-100">New project</div>

        <div className="mb-4 flex rounded-md border border-edge">
          {(
            [
              ['new', 'New repo'],
              ['github', 'GitHub'],
              ['local', 'Local'],
              ['remote', 'Remote']
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 px-2 py-1.5 ${
                mode === m ? 'bg-surface-2 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {working ? (
          <div className="flex items-center gap-2 py-6 font-mono text-[12px] text-zinc-400">
            <span className="busy-ring" />
            {working}
          </div>
        ) : mode === 'new' ? (
          <>
            <label className="mb-1 block text-zinc-500">Repository name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="my-new-app"
              className="mb-3 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
            />
            <label className="mb-4 flex items-center gap-2 text-zinc-400">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              Private repository
            </label>
            <div className="mb-4 font-mono text-[11px] leading-relaxed text-zinc-600">
              Creates github.com repo → clones to Desktop\Projects\{name.trim() || '<name>'} →
              starts the Claude session.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShow(false)}
                className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim()}
                className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </>
        ) : mode === 'github' ? (
          <>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter your repos…"
              className="mb-2 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
            />
            <div className="max-h-64 overflow-y-auto rounded border border-edge">
              {repos === null ? (
                <div className="flex items-center gap-2 p-3 font-mono text-[12px] text-zinc-500">
                  <span className="busy-ring" /> loading your repos…
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-3 text-zinc-600">No matching repos</div>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.nameWithOwner}
                    onClick={() => handleClone(r.nameWithOwner)}
                    className="block w-full px-3 py-1.5 text-left font-mono text-[12px] text-zinc-300 hover:bg-surface-2"
                  >
                    {r.nameWithOwner}
                  </button>
                ))
              )}
            </div>
          </>
        ) : mode === 'local' ? (
          <div className="py-2">
            <div className="mb-4 leading-relaxed text-zinc-500">
              Open a git repository that already exists on this computer.
            </div>
            <button
              onClick={handleLocal}
              className="w-full rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-2 font-medium text-accent hover:bg-accent-dim/30"
            >
              Choose folder…
            </button>
          </div>
        ) : (
          <>
            <label className="mb-1 block text-zinc-500">Host</label>
            <input
              autoFocus
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="myserver.example.com"
              className="mb-3 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
            />
            <div className="mb-3 flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-zinc-500">Username</label>
                <input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="ubuntu"
                  className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
                />
              </div>
              <div className="w-20">
                <label className="mb-1 block text-zinc-500">Port</label>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
                />
              </div>
            </div>
            <label className="mb-1 block text-zinc-500">Remote path</label>
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRemote()}
              placeholder="/home/ubuntu/my-app"
              className="mb-3 w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-zinc-200 placeholder:text-zinc-600"
            />
            <div className="mb-4 font-mono text-[11px] leading-relaxed text-zinc-600">
              Connects over SSH and runs Claude in that folder on the server (it must already exist,
              e.g. an existing git checkout). Uses your normal SSH keys/config — same as running{' '}
              <code>ssh</code> yourself.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShow(false)}
                className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                onClick={handleRemote}
                disabled={!host.trim() || !user.trim() || !remotePath.trim()}
                className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30 disabled:opacity-50"
              >
                Connect
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default NewProjectModal
