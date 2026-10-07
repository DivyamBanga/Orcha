import { useEffect, useState } from 'react'
import { useStore, useIsGuest } from '../store'
import Modal from './Modal'
import type { Agent } from '../../../shared/types'

type Mode = 'new' | 'github' | 'local' | 'remote'

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function NewProjectModal(): React.JSX.Element {
  const show = useStore((s) => s.showNewProject)
  const setShow = useStore((s) => s.setShowNewProject)
  const load = useStore((s) => s.load)
  const setActive = useStore((s) => s.setActive)
  const setup = useStore((s) => s.setup)
  const isGuest = useIsGuest()
  // A guest may not have GitHub connected; the GitHub flows only show when it is.
  const github = setup?.gh ?? false

  const modes: [Mode, string][] = [
    ...(github || !isGuest
      ? ([
          ['new', 'New repo'],
          ['github', 'GitHub']
        ] as [Mode, string][])
      : []),
    ['local', isGuest ? 'Open a folder' : 'Local'],
    ...(isGuest ? [] : ([['remote', 'Remote']] as [Mode, string][]))
  ]

  const [mode, setMode] = useState<Mode>(isGuest ? 'local' : 'new')
  const [agent, setAgent] = useState<Agent>('claude')
  const [name, setName] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [repos, setRepos] = useState<{ nameWithOwner: string; name: string }[] | null>(null)
  const [filter, setFilter] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [remotePath, setRemotePath] = useState('')
  // A folder the guest picked that isn't a git repo yet, awaiting their OK.
  const [plainFolder, setPlainFolder] = useState<string | null>(null)

  // Load the GitHub repo list once when that tab is opened.
  useEffect(() => {
    if (show && mode === 'github' && repos === null) {
      window.orcha.projects
        .listGithub()
        .then(setRepos)
        .catch((err) => setError(cleanError(err)))
    }
  }, [show, mode, repos])

  const close = (): void => {
    setShow(false)
    setError(null)
    setPlainFolder(null)
  }

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
    close()
    setName('')
    setWorking(null)
  }

  const run = async (
    label: string,
    fn: () => Promise<{ repoPath: string } | null>
  ): Promise<void> => {
    setWorking(label)
    setError(null)
    try {
      const project = await fn()
      if (project) await finish(project.repoPath)
      else setWorking(null)
    } catch (err) {
      setWorking(null)
      const message = cleanError(err)
      const plain = message.match(/^Not a git repository: (.+)$/)
      if (plain) setPlainFolder(plain[1])
      else setError(message)
    }
  }

  const handleCreate = (): Promise<void> | void => {
    const repoName = name.trim()
    if (!repoName) return
    return run('Creating GitHub repo…', () =>
      window.orcha.projects.createRepo(repoName, isPrivate, agent)
    )
  }

  const handleClone = (nameWithOwner: string): Promise<void> =>
    run(`Cloning ${nameWithOwner}…`, () => window.orcha.projects.cloneGithub(nameWithOwner, agent))

  const handleLocal = (): Promise<void> =>
    run('Opening…', () => window.orcha.projects.add(undefined, agent))

  const handleInitGit = (): Promise<void> | void => {
    if (!plainFolder) return
    const folder = plainFolder
    setPlainFolder(null)
    return run('Setting up git…', () => window.orcha.projects.initGit(folder, agent))
  }

  const handleRemote = (): Promise<void> | void => {
    const trimmedHost = host.trim()
    const trimmedUser = user.trim()
    const trimmedPath = remotePath.trim()
    if (!trimmedHost || !trimmedUser || !trimmedPath) return
    const parsedPort = port.trim() ? Number(port.trim()) : null
    return run(`Connecting to ${trimmedHost}…`, () =>
      window.orcha.projects.addRemote(trimmedHost, trimmedUser, parsedPort, trimmedPath)
    )
  }

  const filtered = (repos ?? []).filter((r) =>
    r.nameWithOwner.toLowerCase().includes(filter.toLowerCase())
  )
  const agentName = agent === 'codex' ? 'Codex' : 'Claude'

  return (
    <Modal open={show} onClose={close} dismissable={!working} width={440}>
      <div className="mb-4 text-[15px] font-semibold tracking-tight text-zinc-50">New project</div>

      {isGuest && (
        <>
          <div className="field-label">Runs with</div>
          <div className="segmented mb-4">
            {(
              [
                ['claude', 'Claude Code'],
                ['codex', 'Codex']
              ] as [Agent, string][]
            ).map(([a, label]) => (
              <button key={a} data-active={agent === a} onClick={() => setAgent(a)}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {modes.length > 1 && (
        <div className="segmented mb-5">
          {modes.map(([m, label]) => (
            <button
              key={m}
              data-active={mode === m}
              onClick={() => {
                setMode(m)
                setError(null)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {working ? (
        <div className="flex items-center gap-2.5 py-6 text-[12.5px] text-zinc-400">
          <span className="busy-ring" />
          {working}
        </div>
      ) : plainFolder ? (
        <div>
          <p className="mb-4 leading-relaxed text-zinc-400">
            <span className="font-mono text-[12px] text-zinc-300">{plainFolder}</span> isn&apos;t a
            git repository yet. Orcha uses git to track what {agentName} changes. Set it up here?
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPlainFolder(null)} className="btn btn-ghost">
              Cancel
            </button>
            <button onClick={handleInitGit} className="btn btn-primary">
              Set up git and open
            </button>
          </div>
        </div>
      ) : mode === 'new' ? (
        <>
          <label className="field-label" htmlFor="repo-name">
            Repository name
          </label>
          <input
            id="repo-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="my-new-app"
            className="input mb-3"
          />
          <label className="mb-4 flex items-center gap-2 text-zinc-400">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="accent-zinc-200"
            />
            Private repository
          </label>
          <div className="mb-5 text-[12px] leading-relaxed text-zinc-500">
            Creates the repo on GitHub, clones it to{' '}
            {window.orcha.platform === 'darwin' ? '~/Projects/' : 'Desktop\\Projects\\'}
            {name.trim() || '<name>'}, and starts {agentName} in it.
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={close} className="btn btn-ghost">
              Cancel
            </button>
            <button onClick={handleCreate} disabled={!name.trim()} className="btn btn-primary">
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
            placeholder="Filter your repos…"
            className="input mb-2"
          />
          <div className="card max-h-64 overflow-y-auto p-1">
            {repos === null ? (
              <div className="flex items-center gap-2 p-3 text-[12px] text-zinc-500">
                <span className="busy-ring" /> Loading your repos…
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-zinc-600">No matching repos</div>
            ) : (
              filtered.map((r) => (
                <button
                  key={r.nameWithOwner}
                  onClick={() => handleClone(r.nameWithOwner)}
                  className="menu-item font-mono text-[12px]"
                >
                  {r.nameWithOwner}
                </button>
              ))
            )}
          </div>
        </>
      ) : mode === 'local' ? (
        <div>
          <p className="mb-5 leading-relaxed text-zinc-500">
            Pick any folder on this computer. {agentName} starts working in it right away.
          </p>
          <button onClick={handleLocal} className="btn btn-primary h-9 w-full">
            Choose folder…
          </button>
        </div>
      ) : (
        <>
          <label className="field-label" htmlFor="ssh-host">
            Host
          </label>
          <input
            id="ssh-host"
            autoFocus
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="myserver.example.com"
            className="input mb-3"
          />
          <div className="mb-3 flex gap-2">
            <div className="flex-1">
              <label className="field-label">Username</label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="ubuntu"
                className="input"
              />
            </div>
            <div className="w-20">
              <label className="field-label">Port</label>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                className="input"
              />
            </div>
          </div>
          <label className="field-label">Remote path</label>
          <input
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRemote()}
            placeholder="/home/ubuntu/my-app"
            className="input mb-3"
          />
          <div className="mb-5 text-[12px] leading-relaxed text-zinc-500">
            Connects over SSH and runs Claude in that folder on the server (it must already exist,
            e.g. an existing git checkout). Uses your normal SSH keys/config — same as running{' '}
            <code className="font-mono">ssh</code> yourself.
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={close} className="btn btn-ghost">
              Cancel
            </button>
            <button
              onClick={handleRemote}
              disabled={!host.trim() || !user.trim() || !remotePath.trim()}
              className="btn btn-primary"
            >
              Connect
            </button>
          </div>
        </>
      )}

      {error && <div className="mt-3 text-[12px] leading-relaxed text-red-400">{error}</div>}
    </Modal>
  )
}

export default NewProjectModal
