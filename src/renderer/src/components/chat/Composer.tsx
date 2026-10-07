import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import {
  addFiles,
  chatModels,
  pickModel,
  removeFile,
  setDraft,
  useChatStore,
  type PendingFile
} from '../../chatStore'
import { fileMeta } from '../../attach'
import { ArrowUp, Check, ChevronDown, Close, FileDoc, Globe, Paperclip, Spark, Stop } from '../Icon'
import type { CatalogModel } from '../../../../shared/types'

type ChatModel = CatalogModel & { blocked: boolean }

const providerName = (provider: string): string => (provider === 'anthropic' ? 'Claude' : 'GPT')

function ModelPicker({
  route,
  model,
  chatProvider
}: {
  route: string
  model: ChatModel | null
  chatProvider: string | null
}): React.JSX.Element {
  const catalog = useStore((s) => s.catalog)
  const identity = useStore((s) => s.identity)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const models = chatModels(catalog, identity)
  const groups = ['anthropic', 'azure']
    .map((provider) => ({ provider, models: models.filter((m) => m.provider === provider) }))
    .filter((g) => g.models.length > 0)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-active={open}
        className="btn btn-ghost btn-sm gap-1 text-zinc-400"
        title="Choose a model"
      >
        {model?.label ?? 'Choose a model'}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          style={{ transformOrigin: 'bottom left' }}
          className="popover absolute bottom-full left-0 z-20 mb-2 w-72 p-1"
        >
          {groups.map((group) => (
            <div key={group.provider} className="py-0.5">
              <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
                <span className="eyebrow">{providerName(group.provider)}</span>
                {chatProvider && chatProvider !== group.provider && (
                  <span className="text-[11px] text-zinc-600">starts a new chat</span>
                )}
              </div>
              {group.models.map((m) => (
                <button
                  key={m.id}
                  disabled={m.blocked}
                  onClick={() => {
                    setOpen(false)
                    pickModel(route, m, chatProvider)
                  }}
                  className="menu-item h-auto items-start py-1.5 disabled:cursor-default disabled:opacity-45"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-zinc-200">{m.label}</span>
                    <span className="block text-[11.5px] leading-snug text-zinc-500">
                      {m.blocked ? 'On your own plan, in the next update' : m.description}
                    </span>
                  </span>
                  {m.id === model?.id && (
                    <span className="mt-0.5 shrink-0 text-zinc-300">
                      <Check size={13} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Toggle({
  on,
  onClick,
  title,
  children
}: {
  on: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button onClick={onClick} data-on={on} className="composer-toggle" title={title}>
      {children}
    </button>
  )
}

const NO_FILES: PendingFile[] = []

// A file waiting in the composer: an image thumbnail or a named chip, dimmed
// with a spinner until it's saved.
function Attachment({
  pending,
  onRemove
}: {
  pending: PendingFile
  onRemove: () => void
}): React.JSX.Element {
  const ready = pending.file !== null
  return (
    <div className="attachment group/att relative">
      {pending.image && pending.preview ? (
        <img
          src={pending.preview}
          alt={pending.name}
          className={`h-14 w-14 rounded-lg border border-edge object-cover transition-opacity duration-200 ${ready ? '' : 'opacity-50'}`}
        />
      ) : (
        <div className="flex h-14 w-52 items-center gap-2.5 rounded-lg border border-edge bg-surface-2 px-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-zinc-400">
            <FileDoc size={16} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] text-zinc-200">{pending.name}</span>
            <span className="block truncate text-[11px] text-zinc-500">
              {pending.file ? fileMeta(pending.file) : 'Reading…'}
            </span>
          </span>
        </div>
      )}
      {!ready && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="busy-ring" />
        </span>
      )}
      <button onClick={onRemove} className="attachment-remove" title={`Remove ${pending.name}`}>
        <Close size={10} />
      </button>
    </div>
  )
}

// Where a message is written. Enter sends, Shift+Enter starts a new line.
function Composer({
  route,
  model,
  chatProvider,
  running,
  onSend,
  onStop
}: {
  route: string
  model: ChatModel | null
  chatProvider: string | null
  running: boolean
  onSend: (text: string, model: string) => Promise<void>
  onStop: () => void
}): React.JSX.Element {
  const draft = useChatStore((s) => s.drafts[route]) ?? ''
  const files = useChatStore((s) => s.attachments[route]) ?? NO_FILES
  const thinking = useChatStore((s) => s.thinking)
  const webSearch = useChatStore((s) => s.webSearch)
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  // Grows with the text up to a cap, then scrolls.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [draft])

  useEffect(() => {
    ref.current?.focus()
  }, [route])

  // Files alone are enough to send; ones still being saved hold it back.
  const saving = files.some((f) => !f.file)
  const canSend =
    (draft.trim() !== '' || files.length > 0) &&
    !saving &&
    model !== null &&
    !model.blocked &&
    !running &&
    !sending
  const send = (): void => {
    if (!canSend || !model) return
    const text = draft.trim()
    setSending(true)
    setDraft(route, '')
    onSend(text, model.id)
      .catch(() => setDraft(route, text))
      .finally(() => setSending(false))
  }

  const thinkingTitle =
    model?.thinking === 'always'
      ? 'Think longer before answering (this model always thinks some)'
      : 'Think before answering'

  return (
    <div
      className="composer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          ref.current?.focus()
        }
      }}
    >
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {files.map((f) => (
            <Attachment key={f.id} pending={f} onRemove={() => removeFile(route, f.id)} />
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onChange={(e) => setDraft(route, e.target.value)}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files]
          if (pasted.length === 0) return
          e.preventDefault()
          addFiles(route, pasted)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={
          model ? `Ask ${providerName(model.provider)} anything` : 'Pick a model to start'
        }
        className="composer-input"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(route, [...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <button
          onClick={() => picker.current?.click()}
          className="btn btn-ghost btn-icon h-7 w-7 text-zinc-500"
          title="Attach images, PDFs, text or Office files"
        >
          <Paperclip size={15} />
        </button>
        <ModelPicker route={route} model={model} chatProvider={chatProvider} />
        <Toggle
          on={thinking}
          onClick={() => useChatStore.setState({ thinking: !thinking })}
          title={thinkingTitle}
        >
          <Spark size={13} />
          Think
        </Toggle>
        {model?.webSearch && (
          <Toggle
            on={webSearch}
            onClick={() => useChatStore.setState({ webSearch: !webSearch })}
            title="Let it search the web"
          >
            <Globe size={13} />
            Search
          </Toggle>
        )}
        <div className="flex-1" />
        {running ? (
          <button onClick={onStop} className="composer-send composer-stop" title="Stop">
            <Stop size={14} />
          </button>
        ) : (
          <button onClick={send} disabled={!canSend} className="composer-send" title="Send">
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

export default Composer
