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
    left: Math.min(x, window.innerWidth - 212),
    top: Math.min(y, window.innerHeight - items.length * 30 - 20),
    transformOrigin: 'top left'
  }

  return (
    <div ref={ref} style={style} className="popover fixed z-50 w-[200px] p-1">
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorAbove && <div className="mx-1 my-1 border-t border-edge" />}
          <button
            onClick={() => {
              onClose()
              item.onClick()
            }}
            data-danger={item.danger ?? false}
            className="menu-item"
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}

export default ContextMenu
