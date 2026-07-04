import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { useStore } from '../store'
import type { ChatItem } from '../../../shared/types'

// The one argument worth showing next to the tool name.
function mainArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const obj = input as Record<string, unknown>
  const key = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'].find(
    (k) => typeof obj[k] === 'string'
  )
  const value = key ? String(obj[key]) : ''
  return value.length > 80 ? value.slice(0, 77) + '…' : value
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const running = item.result === undefined

  return (
    <div className="my-px border-l border-edge pl-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-left transition-colors duration-100 hover:bg-surface-1"
      >
        {running ? (
          <span className="busy-ring shrink-0" />
        ) : item.isError ? (
          <span className="shrink-0 font-mono text-[11px] text-red-500">✕</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-accent-dim">✓</span>
        )}
        <span className="shrink-0 font-mono text-[12px] font-medium text-zinc-400">
          {item.name}
        </span>
        <span className="truncate font-mono text-[11px] text-zinc-600">{mainArg(item.input)}</span>
      </button>
      {expanded && (
        <div className="mx-2 mb-1 max-h-64 overflow-auto rounded border border-edge bg-surface-1 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
          <div className="mb-1 uppercase tracking-wider text-zinc-600">input</div>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && (
            <>
              <div className="mb-1 mt-2 uppercase tracking-wider text-zinc-600">result</div>
              <pre className="whitespace-pre-wrap break-all">{item.result.slice(0, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function AssistantMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="prose-chat select-text py-1.5 text-zinc-200">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown>
    </div>
  )
}

function ChatView({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const items = useStore((s) => s.messages[workspaceId]) ?? []
  const streamingText = useStore((s) => s.streaming[workspaceId]) ?? ''
  const status = useStore((s) => s.sessionStatus[workspaceId]) ?? 'idle'
  const sendPrompt = useStore((s) => s.mcSend)
  const interrupt = useStore((s) => s.mcInterrupt)
  const loadHistory = useStore((s) => s.mcLoadHistory)

  const slashCommands = useStore((s) => s.slashCommands[workspaceId]) ?? []
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Slash-command preview: only while typing the command word itself.
  const typingSlash = draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n')
  const slashMatches = typingSlash
    ? slashCommands.filter((c) => c.startsWith(draft.slice(1))).slice(0, 8)
    : []
  const showSlashPopup = typingSlash && (slashMatches.length > 0 || slashCommands.length === 0)

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [items, streamingText])

  const busy = status === 'busy'

  const handleSend = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    sendPrompt(text)
  }

  return (
    <div className="console-bg flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {items.length === 0 && !streamingText && (
          <div className="flex h-full items-center justify-center font-mono text-zinc-700">
            awaiting instructions
          </div>
        )}
        {items.map((item, i) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={i} className="my-3 flex justify-end">
                  <div className="max-w-[80%] select-text whitespace-pre-wrap rounded-md border border-edge-bright bg-surface-2 px-3 py-2 text-zinc-100">
                    {item.text}
                  </div>
                </div>
              )
            case 'assistant_text':
              return <AssistantMarkdown key={i} text={item.text} />
            case 'tool':
              return <ToolRow key={i} item={item} />
            case 'error':
              return (
                <div
                  key={i}
                  className="my-2 select-text rounded border border-red-900/60 bg-red-950/30 px-3 py-2 font-mono text-[12px] text-red-400"
                >
                  {item.text}
                </div>
              )
          }
        })}
        {streamingText && <AssistantMarkdown text={streamingText} />}
        {busy && !streamingText && (
          <div className="my-3 flex items-center gap-2 font-mono text-[12px] text-zinc-500">
            <span className="busy-ring" />
            working
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="relative border-t border-edge p-3">
        {showSlashPopup && (
          <div className="absolute bottom-full left-3 mb-1 w-72 overflow-hidden rounded-md border border-edge-bright bg-surface-1">
            {slashMatches.map((cmd) => (
              <button
                key={cmd}
                onClick={() => setDraft(`/${cmd} `)}
                className="block w-full px-3 py-1.5 text-left font-mono text-[12px] text-zinc-300 hover:bg-surface-2"
              >
                /{cmd}
              </button>
            ))}
            {slashCommands.length === 0 && (
              <div className="px-3 py-1.5 font-mono text-[11px] text-zinc-600">
                commands appear after the session's first message
              </div>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && slashMatches.length > 0) {
                e.preventDefault()
                setDraft(`/${slashMatches[0]} `)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={busy ? 'session is working…' : 'prompt this session'}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            className="flex-1 resize-none rounded-md border border-edge bg-surface-1 px-3 py-2 text-zinc-200 transition-colors duration-100 placeholder:text-zinc-600 focus:border-accent-dim focus:outline-none"
          />
          {busy ? (
            <button
              onClick={() => interrupt()}
              className="rounded-md border border-edge-bright px-3 py-2 text-zinc-300 transition-colors duration-100 hover:border-red-800 hover:text-red-400"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-2 font-medium text-accent transition-colors duration-100 hover:bg-accent-dim/30 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ChatView
