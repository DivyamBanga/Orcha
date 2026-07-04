import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  danger?: boolean
  separatorAbove?: boolean
  onClick: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the menu on-screen.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 30 - 16)
  }

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-50 w-48 overflow-hidden rounded-md border border-edge-bright bg-surface-1 py-1"
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorAbove && <div className="my-1 border-t border-edge" />}
          <button
            onClick={() => {
              onClose()
              item.onClick()
            }}
            className={`block w-full px-3 py-1.5 text-left transition-colors duration-100 ${
              item.danger
                ? 'text-red-400 hover:bg-red-950/40'
                : 'text-zinc-300 hover:bg-surface-2'
            }`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}

export default ContextMenu
