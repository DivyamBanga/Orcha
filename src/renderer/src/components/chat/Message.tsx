import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from '../Markdown'
import { usd } from '../../money'
import { useStore } from '../../store'
import { fileMeta, imageUrl } from '../../attach'
import { ArtifactCard } from './Artifact'
import { artifactsAsCode, splitArtifacts } from '../../../../shared/artifacts'
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDoc,
  Pencil,
  Refresh,
  Spark
} from '../Icon'
import type { LiveReply } from '../../chatStore'
import type { ChatFile, ChatMessage, ChatSource, ChatTool } from '../../../../shared/types'

// Where a message sits among its alternatives (edits or retries): 0-based
// index of how many. Callbacks take the message id so they can stay the same
// function across renders, and a streaming reply only re-renders itself.
export interface Branches {
  index: number
  count: number
}

type Go = (messageId: number, delta: -1 | 1) => void

function BranchNav({
  id,
  branches,
  go
}: {
  id: number
  branches: Branches
  go: Go
}): React.JSX.Element | null {
  if (branches.count < 2) return null
  return (
    <span className="tnum flex items-center text-[11.5px] text-zinc-500">
      <button
        onClick={() => go(id, -1)}
        disabled={branches.index === 0}
        className="btn btn-ghost btn-icon h-6 w-6"
        title="Previous version"
      >
        <ChevronLeft size={13} />
      </button>
      {branches.index + 1}/{branches.count}
      <button
        onClick={() => go(id, 1)}
        disabled={branches.index === branches.count - 1}
        className="btn btn-ghost btn-icon h-6 w-6"
        title="Next version"
      >
        <ChevronRight size={13} />
      </button>
    </span>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
      className="btn btn-ghost btn-icon h-6 w-6 text-zinc-500"
      title="Copy"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

// ---- yours ----------------------------------------------------------------------

// An image at full size over everything; a click or Esc closes it.
function Lightbox({ src, onClose }: { src: string; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay-backdrop cursor-zoom-out p-8" onMouseDown={onClose}>
      <img
        src={src}
        alt=""
        className="overlay-panel max-h-full max-w-full rounded-xl border-0 object-contain"
      />
    </div>
  )
}

// What came with a message: image thumbnails (click for full size) and a
// chip for each other file.
function SentFiles({ files }: { files: ChatFile[] }): React.JSX.Element {
  const [viewing, setViewing] = useState<string | null>(null)
  return (
    <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-2">
      {files.map((f) =>
        f.kind === 'image' ? (
          <button
            key={f.hash + f.name}
            onClick={() => setViewing(imageUrl(f))}
            className="cursor-zoom-in overflow-hidden rounded-xl border border-edge"
            title={f.name}
          >
            <img src={imageUrl(f)} alt={f.name} className="h-28 max-w-[240px] object-cover" />
          </button>
        ) : (
          <div
            key={f.hash + f.name}
            className="flex h-14 w-52 items-center gap-2.5 rounded-xl border border-edge bg-surface-1 px-2.5 text-left"
            title={f.name}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-zinc-400">
              <FileDoc size={16} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-zinc-200">{f.name}</span>
              <span className="block truncate text-[11px] text-zinc-500">{fileMeta(f)}</span>
            </span>
          </div>
        )
      )}
      {viewing && <Lightbox src={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

export const UserMessage = memo(function UserMessage({
  message,
  branches,
  onBranch,
  onEdit
}: {
  message: ChatMessage
  branches: Branches
  onBranch: Go
  onEdit: ((messageId: number, text: string) => void) | null
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(message.text)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text, editing])

  if (editing) {
    const save = (): void => {
      if (!text.trim()) return
      setEditing(false)
      onEdit?.(message.id, text.trim())
    }
    return (
      <div className="msg-in my-5 flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-edge-bright bg-surface-1 p-2">
          <textarea
            ref={ref}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            className="composer-input min-h-0 px-2 py-1"
          />
          <div className="flex justify-end gap-1.5 pt-1">
            <button
              onClick={() => {
                setText(message.text)
                setEditing(false)
              }}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button onClick={save} disabled={!text.trim()} className="btn btn-primary btn-sm">
              Send
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-message={message.id} className="msg-in group my-5 flex flex-col items-end">
      {message.files.length > 0 && <SentFiles files={message.files} />}
      {message.text && (
        <div className="max-w-[85%] select-text whitespace-pre-wrap break-words chat-text rounded-2xl bg-surface-2 px-4 py-2.5 leading-relaxed text-zinc-100">
          {message.text}
        </div>
      )}
      <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-[button:focus-visible]:opacity-100">
        <BranchNav id={message.id} branches={branches} go={onBranch} />
        <CopyButton text={message.text} />
        {onEdit && (
          <button
            onClick={() => {
              setText(message.text)
              setEditing(true)
            }}
            className="btn btn-ghost btn-icon h-6 w-6 text-zinc-500"
            title="Edit"
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
    </div>
  )
})

// ---- the reply ------------------------------------------------------------------

// A memory the reply saved ("Remembered: …", with Undo) or removed.
function MemoryRow({ tool }: { tool: ChatTool }): React.JSX.Element {
  const [undone, setUndone] = useState(false)
  const saved = tool.memoryId !== undefined
  return (
    <div className="mb-2 flex items-center gap-2 text-[12.5px] text-zinc-500">
      <Bookmark size={12} />
      <span className={`min-w-0 truncate ${undone ? 'line-through' : ''}`}>
        {saved ? `Remembered: ${tool.label}` : tool.label}
      </span>
      {saved &&
        (undone ? (
          <span className="shrink-0 text-zinc-600">Undone</span>
        ) : (
          <button
            onClick={() => {
              window.orcha.memory.remove(tool.memoryId!).catch(() => {})
              setUndone(true)
            }}
            className="shrink-0 text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline"
          >
            Undo
          </button>
        ))}
    </div>
  )
}

// A citation chip as written into the text (see citeMarks in main).
const CITE_MARK = / ?\[\d+\]\(<[^>]*> "cite"\)/g

// The pages a web search drew on, numbered as the chips in the text.
function Sources({ sources }: { sources: ChatSource[] }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const shown = all ? sources : sources.slice(0, 4)
  const site = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {shown.map((s, i) => (
        <button
          key={s.url}
          onClick={() => window.open(s.url)}
          className="source-chip"
          title={s.url}
        >
          <span className="tnum text-zinc-500">{i + 1}</span>
          <span className="truncate text-zinc-300">{s.title}</span>
          <span className="shrink-0 text-zinc-500">{site(s.url)}</span>
        </button>
      ))}
      {sources.length > shown.length && (
        <button onClick={() => setAll(true)} className="source-chip text-zinc-400">
          {sources.length - shown.length} more
        </button>
      )}
    </div>
  )
}

function Thinking({
  text,
  ms,
  live
}: {
  text: string
  ms: number | null
  live: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const seconds = ms !== null ? Math.max(1, Math.round(ms / 1000)) : null
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12.5px] text-zinc-500 transition-colors duration-150 hover:text-zinc-300"
      >
        {live ? <span className="busy-ring" /> : <Spark size={12} />}
        {live ? 'Thinking…' : seconds !== null ? `Thought for ${seconds}s` : 'Thoughts'}
        <ChevronRight
          size={11}
          className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="fade-late mt-2 select-text whitespace-pre-wrap border-l border-edge-bright pl-3 text-[12.5px] leading-relaxed text-zinc-500">
          {text}
        </div>
      )}
    </div>
  )
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  live,
  branches,
  modelLabel,
  last,
  onBranch,
  onRetry,
  artifactNumbers,
  activeArtifact,
  onOpenArtifact
}: {
  message: ChatMessage
  live: LiveReply | undefined
  branches: Branches
  modelLabel: string | null
  last: boolean
  onBranch: Go
  onRetry: ((messageId: number) => void) | null
  // Each artifact in this reply's version number, in order.
  artifactNumbers?: number[]
  activeArtifact: string | null // "identifier#version" open beside the chat
  onOpenArtifact: (identifier: string, version: number) => void
}): React.JSX.Element {
  const streaming = message.status === 'streaming'
  const text = streaming ? (live?.text ?? '') : message.text
  const segments = useMemo(() => splitArtifacts(text), [text])
  const thinkingText = streaming ? (live?.thinking ?? '') : (message.parts?.thinking?.text ?? '')
  const tools = streaming ? (live?.tools ?? []) : (message.parts?.tools ?? [])
  const error = message.parts?.error
  // The host's Claude replies run on their Claude plan, not credits.
  const host = useStore((s) => s.identity !== null && s.identity.kind !== 'guest')
  const onPlan = host && Boolean(message.model?.startsWith('claude'))

  return (
    <div data-message={message.id} className="msg-in group my-5">
      {thinkingText && (
        <Thinking
          text={thinkingText}
          ms={message.parts?.thinking?.ms ?? null}
          live={streaming && !text}
        />
      )}
      {tools.map((tool, i) =>
        tool.kind === 'memory' ? (
          <MemoryRow key={i} tool={tool} />
        ) : (
          <div key={i} className="mb-2 flex items-center gap-2 text-[12.5px] text-zinc-500">
            {streaming && i === tools.length - 1 && !text ? (
              <span className="busy-ring" />
            ) : (
              <Check size={12} />
            )}
            {streaming && i === tools.length - 1 && !text
              ? tool.label
              : tool.label.replace(/^Searching/, 'Searched')}
          </div>
        )
      )}
      {text
        ? (() => {
            let n = 0
            return segments.map((s, i) => {
              if (s.kind === 'text') {
                return s.text.trim() ? (
                  <Markdown key={i} text={s.text} className="chat-text text-zinc-200" />
                ) : null
              }
              const version = artifactNumbers?.[n++] ?? 1
              return (
                <ArtifactCard
                  key={i}
                  artifact={s.artifact}
                  version={version}
                  active={activeArtifact === `${s.artifact.identifier}#${version}`}
                  onOpen={() => onOpenArtifact(s.artifact.identifier, version)}
                />
              )
            })
          })()
        : streaming &&
          !thinkingText && (
            <div className="flex h-7 items-center">
              <span className="busy-ring" />
            </div>
          )}
      {!streaming && message.parts?.sources?.length ? (
        <Sources sources={message.parts.sources} />
      ) : null}
      {message.status === 'error' && (
        <div className="mt-2 select-text rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-[12.5px] text-red-400">
          {error ?? 'Something went wrong before the reply finished.'}
        </div>
      )}
      {!streaming && (
        <div
          className={`mt-1.5 flex h-6 items-center gap-0.5 transition-opacity duration-150 group-hover:opacity-100 has-[button:focus-visible]:opacity-100 ${
            last ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {text && <CopyButton text={artifactsAsCode(text).replace(CITE_MARK, '')} />}
          {onRetry && (
            <button
              onClick={() => onRetry(message.id)}
              className="btn btn-ghost btn-icon h-6 w-6 text-zinc-500"
              title="Retry"
            >
              <Refresh size={13} />
            </button>
          )}
          <BranchNav id={message.id} branches={branches} go={onBranch} />
          {message.status === 'aborted' && (
            <span className="ml-1 text-[11.5px] text-zinc-500">Stopped</span>
          )}
          <span className="ml-auto flex items-center gap-2 text-[11.5px] text-zinc-600 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {modelLabel}
            {message.costUsd !== null && message.costUsd > 0 && (
              <span className="tnum" title="Roughly what this reply cost">
                ≈ {usd(message.costUsd)}
              </span>
            )}
            {onPlan && <span title="Runs on your Claude plan, not API credits">on your plan</span>}
          </span>
        </div>
      )}
    </div>
  )
})
