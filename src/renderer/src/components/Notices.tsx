import { useEffect } from 'react'
import { useStore, type Notice } from '../store'
import { Close } from './Icon'

const TONE: Record<Notice['tone'], string> = {
  neutral: 'bg-zinc-400',
  warn: 'bg-wait',
  danger: 'bg-red-400'
}

function NoticeCard({ notice }: { notice: Notice }): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissNotice)
  const openCredits = useStore((s) => s.setShowCredits)

  // Heads-ups fade on their own; "it's used up" stays until dismissed.
  useEffect(() => {
    if (notice.tone === 'danger') return
    const timer = setTimeout(() => dismiss(notice.id), 12_000)
    return () => clearTimeout(timer)
  }, [notice, dismiss])

  return (
    <div className="toast popover pointer-events-auto flex w-[340px] items-start gap-3 px-3.5 py-3">
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE[notice.tone]}`} />
      <button
        onClick={() => {
          openCredits(true)
          dismiss(notice.id)
        }}
        className="min-w-0 flex-1 text-left text-[12.5px] leading-relaxed text-zinc-300 hover:text-zinc-100"
      >
        {notice.text}
      </button>
      <button
        onClick={() => dismiss(notice.id)}
        className="btn btn-ghost btn-icon -mr-1.5 -mt-1 h-6 w-6 text-zinc-500"
        title="Dismiss"
      >
        <Close size={12} />
      </button>
    </div>
  )
}

// Bottom-right stack of in-app notices (budget warnings).
function Notices(): React.JSX.Element {
  const notices = useStore((s) => s.notices)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {notices.map((n) => (
        <NoticeCard key={n.id} notice={n} />
      ))}
    </div>
  )
}

export default Notices
