import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { chatRoute, startChat, useChatStore } from '../../chatStore'
import { prepare } from '../../attach'
import { Bubble, Close, FileDoc, Plus, SessionState } from '../Icon'
import type { ChatFile, ChatSummary, ProjectInstructions } from '../../../../shared/types'

const errorText = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

// About how many tokens some text is (a token is ~4 characters).
function approxTokens(chars: number): string {
  const tokens = Math.ceil(chars / 4)
  return tokens < 1000 ? `~${tokens} tokens` : `~${Math.round(tokens / 1000)}k tokens`
}

function when(ms: number): string {
  const day = 86_400_000
  const start = new Date().setHours(0, 0, 0, 0)
  if (ms >= start) return 'Today'
  if (ms >= start - day) return 'Yesterday'
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function Section({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <div className="text-[13.5px] font-semibold text-zinc-100">{title}</div>
          {hint && <div className="mt-0.5 text-[12px] text-zinc-500">{hint}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

// The project's instructions, saved a beat after typing stops (and on leaving
// the page): to the repo's CLAUDE.md, or Orcha's own for a project without one.
function Instructions({ projectId }: { projectId: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState<ProjectInstructions | null>(null)
  const [text, setText] = useState('')
  const latest = useRef({ text: '', saved: '' })

  useEffect(() => {
    window.orcha.projects
      .instructions(projectId)
      .then((i) => {
        setLoaded(i)
        setText(i.text)
        latest.current = { text: i.text, saved: i.text }
      })
      .catch(() => {})
    return () => {
      const { text: now, saved } = latest.current
      if (now !== saved) window.orcha.projects.setInstructions(projectId, now).catch(() => {})
    }
  }, [projectId])

  useEffect(() => {
    latest.current.text = text
    if (!loaded || text === latest.current.saved) return
    const timer = setTimeout(() => {
      window.orcha.projects
        .setInstructions(projectId, text)
        .then(() => (latest.current.saved = text))
        .catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
  }, [text, loaded, projectId])

  return (
    <Section
      title="Instructions"
      hint={
        loaded?.path
          ? `Saved as CLAUDE.md in the project's folder, so its Claude Code sessions follow them too.`
          : 'New chats in this project start with these.'
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="For example: we're planning a two-week trip to Japan in April; keep suggestions under $150 a day."
        className="input h-auto resize-y py-2.5 leading-relaxed"
      />
    </Section>
  )
}

// Files every new chat in the project reads.
function Knowledge({ projectId }: { projectId: string }): React.JSX.Element {
  const [files, setFiles] = useState<(ChatFile & { id: number })[]>([])
  const [adding, setAdding] = useState(0)
  const [over, setOver] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const load = (): void => {
    window.orcha.projects
      .files(projectId)
      .then(setFiles)
      .catch(() => {})
  }
  useEffect(load, [projectId])

  const add = (list: File[]): void => {
    for (const f of list) {
      setAdding((n) => n + 1)
      prepare(f)
        .then(({ name, mime, data }) => window.orcha.chat.attach(name, mime, data))
        .then((file) => window.orcha.projects.addFile(projectId, file))
        .then(load)
        .catch((err) =>
          useStore.getState().pushNotice({ id: 'knowledge', tone: 'warn', text: errorText(err) })
        )
        .finally(() => setAdding((n) => n - 1))
    }
  }
  const tokens = files.reduce((n, f) => n + (f.chars ?? 0), 0) / 4

  return (
    <Section
      title="Knowledge"
      hint="Text, code and Office files every new chat in this project reads."
      action={
        <button onClick={() => picker.current?.click()} className="btn btn-secondary btn-sm">
          <Plus size={12} />
          Add files
        </button>
      }
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setOver(false)
          add([...e.dataTransfer.files])
        }}
        className={`knowledge ${over ? 'knowledge-over' : ''}`}
      >
        {files.length === 0 && adding === 0 ? (
          <div className="py-6 text-center text-[12.5px] text-zinc-500">
            Drop files here, or use Add files.
          </div>
        ) : (
          <div className="flex flex-col">
            {files.map((f) => (
              <div key={f.id} className="group flex items-center gap-2.5 px-3 py-2">
                <FileDoc size={14} className="shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{f.name}</span>
                <span className="tnum shrink-0 text-[11.5px] text-zinc-500">
                  {approxTokens(f.chars ?? 0)}
                </span>
                <button
                  onClick={() =>
                    window.orcha.projects
                      .removeFile(f.id)
                      .then(load)
                      .catch(() => {})
                  }
                  className="btn btn-ghost btn-icon h-6 w-6 shrink-0 text-zinc-500 opacity-0 group-hover:opacity-100"
                  title={`Remove ${f.name}`}
                >
                  <Close size={12} />
                </button>
              </div>
            ))}
            {adding > 0 && (
              <div className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-zinc-500">
                <span className="busy-ring" />
                Reading…
              </div>
            )}
          </div>
        )}
      </div>
      {files.length > 0 && (
        <div className="tnum mt-1.5 text-[11.5px] text-zinc-600">
          About {Math.round(tokens).toLocaleString('en-US')} tokens in every new chat.
        </div>
      )}
    </Section>
  )
}

function ChatList({ chats }: { chats: ChatSummary[] }): React.JSX.Element {
  const setActive = useStore((s) => s.setActive)
  if (chats.length === 0) {
    return <div className="py-3 text-[12.5px] text-zinc-500">No chats yet.</div>
  }
  return (
    <div className="flex flex-col">
      {chats.map((c) => (
        <button key={c.id} onClick={() => setActive(chatRoute(c.id))} className="project-row">
          <Bubble size={13} className="shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate text-left">{c.title ?? 'New chat'}</span>
          <span className="shrink-0 text-[11.5px] text-zinc-500">{when(c.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

// A project's own page: what its chats start with, and everything in it.
function ProjectHome({ projectId }: { projectId: string }): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const workspaces = useStore((s) => s.workspaces)
  const activity = useStore((s) => s.activity)
  const setActive = useStore((s) => s.setActive)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const allChats = useChatStore((s) => s.chats)
  if (!project) return null
  const chats = allChats.filter((c) => c.projectId === projectId)
  const sessions = workspaces.filter((w) => w.projectId === projectId)

  return (
    <>
      <header className="titlebar titlebar-trail flex h-12 shrink-0 items-center gap-3 border-b border-edge px-4">
        <div className="boot-item boot-d1 flex min-w-0 flex-1 items-center gap-3">
          <span className="truncate font-medium text-zinc-50">{project.name}</span>
          <span className="truncate font-mono text-[11.5px] text-zinc-500">
            {project.chatOnly
              ? 'chats only'
              : project.sshHost
                ? `${project.sshUser}@${project.sshHost}:${project.remotePath}`
                : project.repoPath}
          </span>
          <div className="flex-1" />
          {!project.chatOnly && !project.sshHost && (
            <button onClick={() => setShowNewSession(project.id)} className="btn btn-ghost btn-sm">
              New session
            </button>
          )}
          <button onClick={() => startChat(project.id)} className="btn btn-primary btn-sm">
            <Plus size={12} />
            New chat
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="boot-item mx-auto w-full max-w-[760px] px-6 py-7">
          <Instructions key={`i-${projectId}`} projectId={projectId} />
          <Knowledge key={`k-${projectId}`} projectId={projectId} />
          <Section title="Chats">
            <ChatList chats={chats} />
          </Section>
          {sessions.length > 0 && (
            <Section title="Sessions">
              <div className="flex flex-col">
                {sessions.map((w) => (
                  <button key={w.id} onClick={() => setActive(w.id)} className="project-row">
                    <span className="flex w-[13px] shrink-0 justify-center">
                      <SessionState state={activity[w.id] ?? 'off'} open={false} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {w.kind === 'main' ? 'main' : w.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                      {w.agent === 'codex' ? 'Codex' : 'Claude Code'}
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </>
  )
}

export default ProjectHome
