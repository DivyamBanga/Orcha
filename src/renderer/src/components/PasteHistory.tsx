import { useEffect, useRef, useState } from 'react'
import type { ClipEntry } from '../../../shared/types'

// Ctrl+Shift+V overlay: the last dozen things copied anywhere on this
// machine, newest first. Picking one pastes it into the session it was
// opened from — images go in as a file reference, same as a normal paste.
function PasteHistory({
  onPick,
  onClose
}: {
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<ClipEntry[] | null>(null)
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    window.orcha.clipboard
      .history()
      .then((h) => alive && setEntries(h))
      .catch(() => alive && setEntries([]))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    listRef.current?.focus()
  }, [entries])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const count = entries?.length ?? 0
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' && count > 0) {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, count - 1))
    } else if (e.key === 'ArrowUp' && count > 0) {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && entries?.[selected]) {
      e.preventDefault()
      onPick(entries[selected].id)
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="overlay-panel max-h-[70%] w-[540px] overflow-y-auto p-1.5 outline-none"
      >
        <div className="flex items-baseline justify-between px-2 py-1.5">
          <span className="font-medium text-zinc-100">Paste history</span>
          <span className="font-mono text-[11px] text-zinc-600">↑↓ · enter · esc</span>
        </div>
        {entries === null ? (
          <div className="px-2 py-6 text-center font-mono text-[12px] text-zinc-600">reading…</div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-6 text-center font-mono text-[12px] text-zinc-600">
            nothing copied yet
          </div>
        ) : (
          entries.map((entry, i) => (
            <button
              key={entry.id}
              onClick={() => onPick(entry.id)}
              onMouseEnter={() => setSelected(i)}
              className={`flex w-full items-start gap-2.5 rounded-md border-l-2 px-2 py-1.5 text-left transition-colors duration-100 ${
                i === selected
                  ? 'border-zinc-300 bg-surface-2'
                  : 'border-transparent hover:bg-surface-2/60'
              }`}
            >
              {entry.thumb ? (
                <img
                  src={entry.thumb}
                  alt=""
                  className="h-10 max-w-20 shrink-0 rounded border border-edge object-cover"
                />
              ) : (
                <span className="mt-px shrink-0 font-mono text-[11px] text-zinc-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate whitespace-pre font-mono text-[12px] text-zinc-300">
                  {entry.kind === 'image' ? entry.preview : entry.preview.split('\n')[0]}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">
                  {entry.kind === 'image'
                    ? 'image — pastes as a file reference'
                    : `${entry.chars.toLocaleString()} chars${entry.lines > 1 ? ` · ${entry.lines} lines` : ''}`}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export default PasteHistory
