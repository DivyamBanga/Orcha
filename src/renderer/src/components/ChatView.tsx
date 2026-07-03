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
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800/50"
      >
        {running ? (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-600 border-t-zinc-300" />
        ) : item.isError ? (
          <span className="shrink-0 text-red-500">✕</span>
        ) : (
          <span className="shrink-0 text-emerald-600">✓</span>
        )}
        <span className="shrink-0 font-medium text-zinc-400">{item.name}</span>
        <span className="truncate font-mono text-[12px] text-zinc-500">{mainArg(item.input)}</span>
      </button>
      {expanded && (
        <div className="mx-2 mb-1 max-h-64 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[12px] text-zinc-400">
          <div className="mb-1 text-zinc-500">input</div>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && (
            <>
              <div className="mb-1 mt-2 text-zinc-500">result</div>
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
    <div className="prose-chat select-text py-1 leading-relaxed text-zinc-200">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown>
    </div>
  )
}

function ChatView({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const items = useStore((s) => s.messages[workspaceId]) ?? []
  const streamingText = useStore((s) => s.streaming[workspaceId]) ?? ''
  const status = useStore((s) => s.sessionStatus[workspaceId]) ?? 'idle'
  const sendPrompt = useStore((s) => s.sendPrompt)
  const interrupt = useStore((s) => s.interrupt)

  const loadHistory = useStore((s) => s.loadHistory)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadHistory(workspaceId)
  }, [workspaceId, loadHistory])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [items, streamingText])

  const busy = status === 'busy'

  const handleSend = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    sendPrompt(workspaceId, text)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.length === 0 && !streamingText && (
          <div className="flex h-full items-center justify-center text-zinc-600">
            Send a prompt to start this session
          </div>
        )}
        {items.map((item, i) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={i} className="my-3 flex justify-end">
                  <div className="max-w-[80%] select-text whitespace-pre-wrap rounded-lg bg-zinc-800 px-3 py-2 text-zinc-100">
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
                  className="my-2 select-text rounded border border-red-900 bg-red-950/40 px-3 py-2 text-red-400"
                >
                  {item.text}
                </div>
              )
          }
        })}
        {streamingText && <AssistantMarkdown text={streamingText} />}
        {busy && !streamingText && (
          <div className="my-2 flex items-center gap-2 text-zinc-500">
            <span className="h-3 w-3 animate-spin rounded-full border border-zinc-600 border-t-zinc-300" />
            Working…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-zinc-800 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={busy ? 'Claude is working…' : 'Prompt this session (Enter to send)'}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
          {busy ? (
            <button
              onClick={() => interrupt(workspaceId)}
              className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-300 hover:bg-zinc-800"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="rounded-md bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
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
