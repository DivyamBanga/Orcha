import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, useIsGuest } from '../store'
import { chatRoute, startChat, useChatStore } from '../chatStore'
import { usePresence } from '../motion'
import { Bubble, Folder, Mark, Plus, Search, Settings, SessionState } from './Icon'

interface Item {
  id: string
  group: string
  label: string
  detail?: React.ReactNode
  icon: React.ReactNode
  run: () => void
}

interface Hit {
  chatId: string
  messageId: number
  snippet: string
}

// \x02…\x03 marks where a search matched; shown as highlighted text.
function Snippet({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {/* eslint-disable-next-line no-control-regex */}
      {text.split(/\x02([^\x03]*)\x03/).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-overlay/10 px-px text-zinc-100">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

const matches = (text: string, words: string[]): boolean => {
  const lower = text.toLowerCase()
  return words.every((w) => lower.includes(w))
}

// ⌘K: jump anywhere (chats, sessions, projects), search inside every chat,
// or run an action. Arrow keys move, Enter opens, Esc closes.
function CommandPalette(): React.JSX.Element | null {
  const open = useStore((s) => s.showPalette)
  const { mounted, closing } = usePresence(open, 120)
  const close = (): void => useStore.getState().setShowPalette(false)
  if (!mounted) return null
  return (
    <div
      className="overlay-backdrop items-start pt-[14vh]"
      data-closing={closing}
      onMouseDown={close}
    >
      <PaletteBody onClose={close} />
    </div>
  )
}

function PaletteBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const workspaces = useStore((s) => s.workspaces)
  const activity = useStore((s) => s.activity)
  const isGuest = useIsGuest()
  const chats = useChatStore((s) => s.chats)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  // Message text, through the chats' full-text index; a beat after typing
  // stops so every keystroke doesn't query.
  const q = query.trim()
  useEffect(() => {
    if (q.length < 2) return
    let stale = false
    const timer = setTimeout(() => {
      window.orcha.chat
        .search(q)
        .then((h) => !stale && setHits(h.slice(0, 8)))
        .catch(() => {})
    }, 120)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [q])

  const items = useMemo<Item[]>(() => {
    const s = useStore.getState()
    const go = (id: string) => () => s.setActive(id)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const title = (chatId: string): string =>
      chats.find((c) => c.id === chatId)?.title ?? 'New chat'

    const actions: Item[] = [
      {
        id: 'a:chat',
        group: 'Actions',
        label: 'New chat',
        icon: <Plus size={14} />,
        run: () => startChat(null)
      },
      {
        id: 'a:mc',
        group: 'Actions',
        label: 'Mission Control',
        icon: <Mark size={13} />,
        run: go('orchestrator')
      },
      {
        id: 'a:project',
        group: 'Actions',
        label: 'New project',
        icon: <Plus size={14} />,
        run: () => s.setShowNewProject(true)
      },
      {
        id: 'a:settings',
        group: 'Actions',
        label: 'Settings',
        icon: <Settings size={14} />,
        run: () => s.setShowSettings(true)
      },
      isGuest
        ? {
            id: 'a:credits',
            group: 'Actions',
            label: 'Credits',
            icon: <Settings size={14} />,
            run: () => s.setShowCredits(true)
          }
        : {
            id: 'a:usage',
            group: 'Actions',
            label: 'Usage',
            icon: <Settings size={14} />,
            run: () => s.setShowUsageDashboard(true)
          }
    ]
    const chatItems: Item[] = chats.map((c) => ({
      id: `c:${c.id}`,
      group: 'Chats',
      label: c.title ?? 'New chat',
      icon: <Bubble size={14} />,
      run: go(chatRoute(c.id))
    }))
    const sessionItems: Item[] = workspaces.map((w) => {
      const project = projects.find((p) => p.id === w.projectId)
      return {
        id: `s:${w.id}`,
        group: 'Sessions',
        label: w.kind === 'main' ? (project?.name ?? w.name) : w.name,
        detail: w.kind === 'main' ? 'main' : project?.name,
        icon: <SessionState state={activity[w.id] ?? 'off'} open={false} />,
        run: go(w.id)
      }
    })

    const projectItems: Item[] = projects.map((p) => ({
      id: `p:${p.id}`,
      group: 'Projects',
      label: p.name,
      detail: p.chatOnly ? 'chats only' : 'project',
      icon: <Folder size={14} />,
      run: go(`project:${p.id}`)
    }))

    if (words.length === 0) return [...actions, ...chatItems.slice(0, 6)]
    const found = (xs: Item[]): Item[] =>
      xs.filter((x) => matches(`${x.label} ${typeof x.detail === 'string' ? x.detail : ''}`, words))
    const messageItems: Item[] = hits.map((h) => ({
      id: `m:${h.messageId}`,
      group: 'In chats',
      label: title(h.chatId),
      detail: <Snippet text={h.snippet} />,
      icon: <Search size={14} />,
      run: () => {
        useChatStore.setState({ focusMessage: { chatId: h.chatId, messageId: h.messageId } })
        s.setActive(chatRoute(h.chatId))
      }
    }))
    return [
      ...found(chatItems).slice(0, 6),
      ...found(projectItems).slice(0, 4),
      ...found(sessionItems).slice(0, 6),
      ...found(actions),
      ...(q.length >= 2 ? messageItems : [])
    ]
  }, [q, hits, chats, workspaces, projects, activity, isGuest])

  const current = Math.min(selected, Math.max(items.length - 1, 0))
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const run = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="overlay-panel w-[600px] max-w-[calc(100vw-48px)] overflow-hidden"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-edge px-4">
        <Search size={15} className="shrink-0 text-zinc-500" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setSelected((current + step + items.length) % Math.max(items.length, 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(items[current])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder="Search chats and sessions, or type a command"
          className="palette-input h-full flex-1 bg-transparent text-[14px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
      </div>
      <div ref={list} className="max-h-[min(440px,58vh)] overflow-y-auto p-1.5">
        {items.length === 0 && (
          <div className="px-3 py-8 text-center text-zinc-500">Nothing matches “{q}”</div>
        )}
        {items.map((item, i) => (
          <div key={item.id}>
            {item.group !== items[i - 1]?.group && (
              <div className="eyebrow px-2.5 pb-1 pt-2.5">{item.group}</div>
            )}
            <button
              data-index={i}
              data-selected={i === current}
              onMouseMove={() => i !== current && setSelected(i)}
              onClick={() => run(item)}
              className="palette-item"
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-zinc-500">
                {item.icon}
              </span>
              <span className="shrink-0 truncate text-zinc-200">{item.label}</span>
              {item.detail && (
                <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">
                  {item.detail}
                </span>
              )}
            </button>
          </div>
        ))}
      </div>
      <div className="flex h-8 items-center gap-4 border-t border-edge px-4 text-[11px] text-zinc-600">
        <span>↑↓ to move</span>
        <span>↵ to open</span>
        <span>esc to close</span>
      </div>
    </div>
  )
}

export default CommandPalette
