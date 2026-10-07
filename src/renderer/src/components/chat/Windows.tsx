import { useEffect, useState } from 'react'
import Markdown from '../Markdown'
import { ArtifactView } from './Artifact'
import { canPreview } from '../../artifactVersions'
import { pathTo } from '../../../../shared/chatTree'
import { artifactsAsCode, type Artifact } from '../../../../shared/artifacts'
import type { ChatDetail } from '../../../../shared/types'

// The windows besides the main one (see chat/windows.ts in main).

// An artifact popped out into a window of its own.
export function ArtifactWindow({ id }: { id: string }): React.JSX.Element {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.orcha.artifact
      .snapshot(id)
      .then((a) =>
        setArtifact(
          a && {
            identifier: id,
            type: a.type as Artifact['type'],
            title: a.title,
            language: a.language,
            content: a.content,
            complete: true
          }
        )
      )
      .catch(() => {})
  }, [id])
  if (!artifact) return <div className="h-full bg-surface-0" />
  return (
    <div className="flex h-full flex-col bg-surface-0 text-zinc-300">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-edge px-4">
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-100">{artifact.title}</span>
        {canPreview(artifact) && (
          <div className="segmented w-36">
            {(['preview', 'code'] as const).map((m) => (
              <button key={m} data-active={mode === m} onClick={() => setMode(m)}>
                {m === 'preview' ? 'Preview' : 'Code'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <ArtifactView key={mode} artifact={artifact} mode={mode} onError={setError} />
      </div>
      {error && (
        <div className="shrink-0 border-t border-red-400/20 bg-red-400/[0.06] px-4 py-2 text-[12.5px] text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}

// A chat laid out for print: what Export as PDF captures. It tells main when
// it has finished drawing (fonts and maths included).
export function PrintView({ chatId }: { chatId: string }): React.JSX.Element | null {
  const [detail, setDetail] = useState<ChatDetail | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.classList.add('print-view')
    Promise.all([window.orcha.chat.get(chatId), window.orcha.catalog()])
      .then(([d, catalog]) => {
        setLabels(Object.fromEntries(catalog.models.map((m) => [m.id, m.label])))
        setDetail(d)
      })
      .catch(() => {})
  }, [chatId])
  useEffect(() => {
    if (!detail) return
    document.fonts.ready.then(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => window.orcha.print.ready()))
    )
  }, [detail])
  if (!detail) return null
  const path = pathTo(detail.messages, detail.chat.leafId)
  return (
    <div className="print-page">
      <h1>{detail.chat.title ?? 'Chat'}</h1>
      <div className="print-date">
        {new Date(detail.chat.createdAt).toLocaleString('en-US', {
          dateStyle: 'long',
          timeStyle: 'short'
        })}
      </div>
      {path.map((m) => (
        <section key={m.id} className="print-turn">
          <div className="print-who">
            {m.role === 'user' ? 'You' : (labels[m.model ?? ''] ?? m.model ?? 'Assistant')}
          </div>
          {m.files.length > 0 && (
            <div className="print-files">Attached: {m.files.map((f) => f.name).join(', ')}</div>
          )}
          {m.role === 'user' ? (
            <div className="whitespace-pre-wrap">{m.text}</div>
          ) : (
            <Markdown text={artifactsAsCode(m.text)} />
          )}
        </section>
      ))}
    </div>
  )
}
