import { useEffect } from 'react'
import { usePresence } from '../motion'

// The one dialog shell every modal uses: a dimmed backdrop and a raised panel
// that ease in, ease back out on close, and close on Esc or a backdrop click.
function Modal({
  open,
  onClose,
  width = 420,
  dismissable = true,
  children
}: {
  open: boolean
  onClose: () => void
  width?: number
  // False while something is in flight that closing would orphan.
  dismissable?: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  const { mounted, closing } = usePresence(open)

  useEffect(() => {
    if (!open || !dismissable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])

  if (!mounted) return null
  return (
    <div
      className="overlay-backdrop"
      data-closing={closing}
      onMouseDown={() => dismissable && onClose()}
    >
      <div
        className="overlay-panel max-h-[86vh] overflow-y-auto p-5"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export default Modal
