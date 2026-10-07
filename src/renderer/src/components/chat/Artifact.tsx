import { useEffect, useRef, useState } from 'react'
import Markdown from '../Markdown'
import { artifactFileName, artifactLanguage, canPreview, KIND } from '../../artifactVersions'
import { ChevronLeft, ChevronRight, Close, Copy, Check, Download, Expand, PopOut } from '../Icon'
import type { Artifact } from '../../../../shared/artifacts'

// A short fingerprint of some text, so a new version gets a fresh frame.
function fingerprint(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return `${text.length}:${h}`
}

const dark = (): boolean => document.documentElement.dataset.theme !== 'light'

// The artifact running in its sandbox (see artifactRuntime.ts in main): the
// page says it's ready, gets the artifact, and reports anything that breaks.
function ArtifactFrame({
  artifact,
  onError
}: {
  artifact: Artifact
  onError: (message: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const frame = ref.current
      if (!frame || e.source !== frame.contentWindow) return
      if (e.data?.type === 'ready') {
        frame.contentWindow?.postMessage(
          { type: 'render', kind: artifact.type, content: artifact.content, dark: dark() },
          '*'
        )
      } else if (e.data?.type === 'error') {
        onError(String(e.data.message))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [artifact.type, artifact.content, onError])
  return (
    <iframe
      ref={ref}
      key={fingerprint(artifact.type + artifact.content)}
      src="orcha-artifact://run/"
      sandbox="allow-scripts"
      title={artifact.title}
      className="artifact-frame"
    />
  )
}

// An artifact drawn (preview) or as its source (code).
export function ArtifactView({
  artifact,
  mode,
  onError
}: {
  artifact: Artifact
  mode: 'preview' | 'code'
  onError: (message: string) => void
}): React.JSX.Element {
  if (mode === 'code' || !canPreview(artifact)) {
    return (
      <div className="h-full overflow-auto p-4">
        <Markdown text={'```' + artifactLanguage(artifact) + '\n' + artifact.content + '\n```'} />
      </div>
    )
  }
  if (artifact.type === 'text/markdown') {
    return (
      <div className="h-full overflow-auto px-8 py-6">
        <Markdown text={artifact.content} className="chat-text text-zinc-200" />
      </div>
    )
  }
  return <ArtifactFrame artifact={artifact} onError={onError} />
}

function IconButton({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="btn btn-ghost btn-icon h-7 w-7 text-zinc-500"
      title={title}
    >
      {children}
    </button>
  )
}

// Beside the chat: the artifact, its versions, and what can be done with it.
export function ArtifactPanel({
  versions,
  index,
  onVersion,
  onClose,
  onFix
}: {
  versions: Artifact[]
  index: number
  onVersion: (index: number) => void
  onClose: () => void
  onFix: (message: string) => void
}): React.JSX.Element {
  const artifact = versions[index]
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  // While it's still being written, show the code coming in; flip to the
  // preview once it's whole.
  const shown = artifact.complete ? mode : 'code'
  // A different artifact or version clears the last one's error (compared by
  // content: the same version arrives as a new object when its reply ends).
  const current = `${index}:${fingerprint(artifact.content)}`
  const [seen, setSeen] = useState(current)
  if (seen !== current) {
    setSeen(current)
    setError(null)
  }

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const download = (): void => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain' }))
    a.download = artifactFileName(artifact)
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const view = (
    <ArtifactView key={`${index}-${shown}`} artifact={artifact} mode={shown} onError={setError} />
  )

  return (
    <aside className="artifact-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-zinc-100">{artifact.title}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {artifact.complete ? KIND[artifact.type] : 'Writing…'}
            {artifact.language ? ` · ${artifact.language}` : ''}
          </div>
        </div>
        {versions.length > 1 && (
          <span className="tnum flex items-center text-[11.5px] text-zinc-500">
            <button
              onClick={() => onVersion(index - 1)}
              disabled={index === 0}
              className="btn btn-ghost btn-icon h-6 w-6"
              title="Earlier version"
            >
              <ChevronLeft size={13} />
            </button>
            v{index + 1}/{versions.length}
            <button
              onClick={() => onVersion(index + 1)}
              disabled={index === versions.length - 1}
              className="btn btn-ghost btn-icon h-6 w-6"
              title="Later version"
            >
              <ChevronRight size={13} />
            </button>
          </span>
        )}
        {canPreview(artifact) && (
          <div className="segmented w-36">
            {(['preview', 'code'] as const).map((m) => (
              <button
                key={m}
                data-active={shown === m}
                disabled={!artifact.complete && m === 'preview'}
                onClick={() => setMode(m)}
              >
                {m === 'preview' ? 'Preview' : 'Code'}
              </button>
            ))}
          </div>
        )}
        <IconButton
          title="Copy"
          onClick={() => {
            navigator.clipboard.writeText(artifact.content).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
        <IconButton title="Download" onClick={download}>
          <Download size={14} />
        </IconButton>
        <IconButton title="Full screen" onClick={() => setFull(true)}>
          <Expand size={14} />
        </IconButton>
        <IconButton
          title="Open in its own window"
          onClick={() =>
            window.orcha.artifact
              .popOut({
                title: artifact.title,
                type: artifact.type,
                language: artifact.language,
                content: artifact.content
              })
              .catch(() => {})
          }
        >
          <PopOut size={14} />
        </IconButton>
        <IconButton title="Close" onClick={onClose}>
          <Close size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">{full ? null : view}</div>
      {error && (
        <div className="flex shrink-0 items-center gap-3 border-t border-red-400/20 bg-red-400/[0.06] px-4 py-2.5 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-red-400" title={error}>
            {error}
          </span>
          <button onClick={() => onFix(error)} className="btn btn-secondary btn-sm shrink-0">
            Ask to fix it
          </button>
        </div>
      )}
      {full && (
        <div className="artifact-full">
          {view}
          <button
            onClick={() => setFull(false)}
            className="artifact-full-close"
            title="Leave full screen (Esc)"
          >
            <Close size={14} />
          </button>
        </div>
      )}
    </aside>
  )
}

// What stands in for an artifact in the reply: click to open it beside.
export function ArtifactCard({
  artifact,
  version,
  active,
  onOpen
}: {
  artifact: Artifact
  version: number
  active: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button onClick={onOpen} data-active={active} className="artifact-card">
      <span className="artifact-card-icon">
        {artifact.complete ? (
          <span className="font-mono text-[10px] font-semibold uppercase">
            {artifactFileName(artifact).split('.').pop()}
          </span>
        ) : (
          <span className="busy-ring" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-zinc-100">
          {artifact.title}
        </span>
        <span className="block truncate text-[11.5px] text-zinc-500">
          {artifact.complete ? KIND[artifact.type] : 'Writing…'}
          {version > 1 ? ` · version ${version}` : ''}
        </span>
      </span>
    </button>
  )
}
