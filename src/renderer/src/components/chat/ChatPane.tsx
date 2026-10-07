import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import {
  addFiles,
  chatIdOf,
  chatModels,
  defaultModel,
  deleteChat,
  loadChat,
  NEW_CHAT,
  retryReply,
  sendMessage,
  showBranch,
  useChatStore
} from '../../chatStore'
import { pathTo, siblings } from '../../../../shared/chatTree'
import Composer from './Composer'
import { AssistantMessage, UserMessage, type Branches } from './Message'
import { ArrowDown, More, Star } from '../Icon'
import ContextMenu from '../ContextMenu'

function greeting(hour: number): string {
  if (hour < 5) return 'Up late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

// Files dragged anywhere over a chat attach to its next message.
function DropZone({
  route,
  className,
  children
}: {
  route: string
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  // Enter and leave fire for every child crossed; count to know when it's out.
  const depth = useRef(0)
  const files = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(e) => {
        if (!files(e)) return
        depth.current++
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!files(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDragOver={(e) => {
        if (files(e)) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!files(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        addFiles(route, [...e.dataTransfer.files])
      }}
    >
      {children}
      {over && <div className="drop-veil">Drop to attach</div>}
    </div>
  )
}

// The empty screen a new chat starts from: a greeting and the composer.
function NewChat(): React.JSX.Element {
  const catalog = useStore((s) => s.catalog)
  const identity = useStore((s) => s.identity)
  const picked = useChatStore((s) => s.picked[NEW_CHAT])
  const [hour] = useState(() => new Date().getHours())
  const modelId = picked ?? defaultModel(catalog, identity)
  const model = chatModels(catalog, identity).find((m) => m.id === modelId) ?? null

  return (
    <DropZone
      route={NEW_CHAT}
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[12vh]"
    >
      <div className="boot-item w-full max-w-[720px]">
        <h1 className="mb-6 text-center text-[26px] font-medium tracking-tight text-zinc-100">
          {greeting(hour)}
        </h1>
        <Composer
          route={NEW_CHAT}
          model={model}
          chatProvider={null}
          running={false}
          onSend={(text, id) => sendMessage(null, null, text, id)}
          onStop={() => {}}
        />
      </div>
    </DropZone>
  )
}

function ChatHeader({ chatId }: { chatId: string }): React.JSX.Element {
  const chat = useChatStore((s) => s.chats.find((c) => c.id === chatId))
  const asked = useChatStore((s) => s.renaming === chatId)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const title = chat?.title ?? 'New chat'
  const renaming = editing || asked
  const setRenaming = (on: boolean): void => {
    setEditing(on)
    if (!on && asked) useChatStore.setState({ renaming: null })
  }

  const rename = (value: string): void => {
    setRenaming(false)
    if (value.trim() && value.trim() !== title) {
      window.orcha.chat.rename(chatId, value).catch(() => {})
    }
  }

  return (
    <header className="titlebar titlebar-trail flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4">
      <div className="boot-item boot-d1 flex min-w-0 flex-1 items-center gap-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={title}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(e.currentTarget.value)
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="input h-7 max-w-[420px] font-medium"
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className="truncate rounded-md px-1.5 py-0.5 font-medium text-zinc-50 transition-colors duration-150 hover:bg-overlay/[0.05]"
            title="Rename"
          >
            {title}
          </button>
        )}
        <button
          onClick={() => window.orcha.chat.star(chatId, !chat?.starred).catch(() => {})}
          className={`btn btn-ghost btn-icon h-6 w-6 ${chat?.starred ? 'text-zinc-200' : 'text-zinc-600'}`}
          title={chat?.starred ? 'Unstar' : 'Star'}
        >
          <Star size={13} filled={chat?.starred} />
        </button>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.right - 180, y: r.bottom + 4 })
          }}
          className="btn btn-ghost btn-icon text-zinc-500"
          title="More"
        >
          <More size={14} />
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Rename', onClick: () => setRenaming(true) },
            {
              label: 'Export as Markdown',
              onClick: () => window.orcha.chat.exportOne(chatId, title).catch(() => {})
            },
            {
              label: 'Delete chat',
              danger: true,
              separatorAbove: true,
              onClick: () => {
                if (confirm(`Delete "${title}"? This can't be undone.`)) {
                  deleteChat(chatId).catch(() => {})
                }
              }
            }
          ]}
        />
      )}
    </header>
  )
}

function Conversation({ chatId }: { chatId: string }): React.JSX.Element {
  const route = `chat:${chatId}`
  const detail = useChatStore((s) => s.details[chatId])
  const live = useChatStore((s) => s.live)
  const running = useChatStore((s) => s.running[chatId] !== undefined)
  const picked = useChatStore((s) => s.picked[route])
  const focus = useChatStore((s) => s.focusMessage)
  const catalog = useStore((s) => s.catalog)
  const identity = useStore((s) => s.identity)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // Fetched once; after that every change goes through the store (sends,
  // streamed replies, branch switches), and fetching again could undo a
  // branch switch that hasn't reached main yet.
  useEffect(() => {
    if (!useChatStore.getState().details[chatId]) loadChat(chatId).catch(() => {})
  }, [chatId])

  const path = useMemo(() => (detail ? pathTo(detail.messages, detail.chat.leafId) : []), [detail])
  // Built once per change to the chat (not per streamed frame), so messages
  // that aren't streaming keep the same props and skip re-rendering.
  const branches = useMemo(() => {
    const map = new Map<number, Branches>()
    if (!detail) return map
    for (const m of path) {
      const sibs = siblings(detail.messages, m.id)
      map.set(m.id, { index: sibs.findIndex((s) => s.id === m.id), count: sibs.length })
    }
    return map
  }, [detail, path])

  const models = chatModels(catalog, identity)
  const model =
    models.find((m) => m.id === (picked ?? detail?.chat.model)) ??
    models.find((m) => m.id === detail?.chat.model) ??
    null
  const label = useCallback(
    (id: string | null) => models.find((m) => m.id === id)?.label ?? id,
    [models]
  )

  const onBranch = useCallback(
    (messageId: number, delta: -1 | 1) => {
      const d = useChatStore.getState().details[chatId]
      if (!d) return
      const sibs = siblings(d.messages, messageId)
      const next = sibs[sibs.findIndex((s) => s.id === messageId) + delta]
      if (next) showBranch(chatId, next.id)
    },
    [chatId]
  )
  const modelId = model?.id ?? null
  const onEdit = useCallback(
    (messageId: number, text: string) => {
      const d = useChatStore.getState().details[chatId]
      const message = d?.messages.find((m) => m.id === messageId)
      if (!message || !modelId) return
      pinned.current = true
      sendMessage(chatId, message.parentId, text, modelId, message.files).catch(() => {})
    },
    [chatId, modelId]
  )
  const onRetry = useCallback(
    (messageId: number) => {
      const d = useChatStore.getState().details[chatId]
      const message = d?.messages.find((m) => m.id === messageId)
      if (message?.parentId == null || !modelId) return
      pinned.current = true
      retryReply(chatId, message.parentId, modelId).catch(() => {})
    },
    [chatId, modelId]
  )

  // Follows the reply as it streams while you're at the bottom; scrolling up
  // to read lets go until you come back down.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinned.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  // A search hit: show the branch it's on, then bring it into view.
  useEffect(() => {
    if (!focus || focus.chatId !== chatId || !detail) return
    if (!path.some((m) => m.id === focus.messageId)) {
      if (detail.messages.some((m) => m.id === focus.messageId)) {
        showBranch(chatId, focus.messageId)
      }
      return
    }
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message="${focus.messageId}"]`)
    if (el) {
      pinned.current = false
      el.scrollIntoView({ block: 'center' })
      el.classList.add('msg-flash')
      setTimeout(() => el.classList.remove('msg-flash'), 1600)
    }
    useChatStore.setState({ focusMessage: null })
  }, [focus, chatId, detail, path])

  const last = path[path.length - 1]
  const send = (text: string, id: string): Promise<void> => {
    pinned.current = true
    return sendMessage(chatId, last?.id ?? null, text, id)
  }

  return (
    <DropZone route={route} className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[720px] px-6 pb-6 pt-4">
            {path.map((m) =>
              m.role === 'user' ? (
                <UserMessage
                  key={m.id}
                  message={m}
                  branches={branches.get(m.id)!}
                  onBranch={onBranch}
                  onEdit={running ? null : onEdit}
                />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  live={m.status === 'streaming' ? live[m.id] : undefined}
                  branches={branches.get(m.id)!}
                  modelLabel={label(m.model)}
                  last={m === last}
                  onBranch={onBranch}
                  onRetry={running ? null : onRetry}
                />
              )
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            onClick={() => {
              pinned.current = true
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
            }}
            className="popover absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full text-zinc-400 hover:text-zinc-100"
            title="Jump to the latest"
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>
      <div className="mx-auto w-full max-w-[720px] px-6 pb-5">
        <Composer
          route={route}
          model={model}
          chatProvider={detail?.chat.provider ?? null}
          running={running}
          onSend={send}
          onStop={() => window.orcha.chat.stop(chatId).catch(() => {})}
        />
      </div>
    </DropZone>
  )
}

// A chat, or the new-chat screen.
function ChatPane({ route }: { route: string }): React.JSX.Element {
  const chatId = chatIdOf(route)
  if (!chatId) {
    return (
      <>
        <header className="titlebar titlebar-trail h-12 shrink-0" />
        <NewChat />
      </>
    )
  }
  return (
    <>
      <ChatHeader chatId={chatId} />
      <Conversation key={chatId} chatId={chatId} />
    </>
  )
}

export default ChatPane
