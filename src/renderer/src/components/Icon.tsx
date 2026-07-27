// Inline SVG icon set on a 16px grid: 1.5px stroke, currentColor, round caps.
// Replaces the Unicode glyphs the UI used to draw (⋯ ⚙ ⑂ ↻ ✓ ○ ✕ ▾ ↑ ↓ +),
// which never sat on a consistent baseline or weight across the app. A dozen
// hand-drawn paths weighs less than pulling in an icon package.

interface IconProps {
  size?: number
  className?: string
}

function Stroke({
  size = 16,
  className,
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function Filled({
  size = 16,
  className,
  viewBox = '0 0 16 16',
  children
}: IconProps & { viewBox?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// The mark: two panes with a seam off-centre, echoing both the opening
// animation and the app's own sidebar-beside-main-pane layout.
export function Mark(props: IconProps): React.JSX.Element {
  return (
    <Filled {...props}>
      <rect x="1.5" y="2" width="3.25" height="12" rx="1" />
      <rect x="6.25" y="2" width="8.25" height="12" rx="1" />
    </Filled>
  )
}

export function More(props: IconProps): React.JSX.Element {
  return (
    <Filled {...props}>
      <circle cx="3.5" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.5" cy="8" r="1.1" />
    </Filled>
  )
}

// Uncommitted changes. A diamond rather than the old amber `M`: dirty is a
// git fact, not a session state, and amber now means "needs you".
export function Diamond(props: IconProps): React.JSX.Element {
  return (
    <Filled viewBox="0 0 12 12" {...props}>
      <path d="M6 2.6L9.4 6 6 9.4 2.6 6z" />
    </Filled>
  )
}

export function Settings(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M2.5 5.5h11M2.5 10.5h11" />
      <circle cx="10" cy="5.5" r="1.9" />
      <circle cx="6" cy="10.5" r="1.9" />
    </Stroke>
  )
}

export function Branch(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11.2" cy="4" r="1.5" />
      <path d="M5 5.6v4.8M5 8h3.1a2.5 2.5 0 0 0 2.5-2.5" />
    </Stroke>
  )
}

export function Refresh(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M13.2 8A5.2 5.2 0 1 1 8 2.8" />
      <path d="M6.6 1.4L8 2.8 6.6 4.2" />
    </Stroke>
  )
}

export function Check(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M3.5 8.4l3 3 6-6.6" />
    </Stroke>
  )
}

export function Circle(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="8" cy="8" r="4.8" />
    </Stroke>
  )
}

export function Close(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Stroke>
  )
}

export function ChevronDown(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M4.5 6.5L8 10l3.5-3.5" />
    </Stroke>
  )
}

export function ArrowUp(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M8 12.5V3.5M4.5 7L8 3.5 11.5 7" />
    </Stroke>
  )
}

export function ArrowDown(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M8 3.5v9M11.5 9L8 12.5 4.5 9" />
    </Stroke>
  )
}

export function Plus(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Stroke>
  )
}

// Session state, as shape first and colour second, so a row still reads
// correctly at the edge of vision. "working" is a rotating CSS ring (see
// .state-ring) rather than an SVG so the rotation stays off the main thread.
export function SessionState({
  state,
  open
}: {
  state: 'working' | 'waiting' | 'off'
  open: boolean
}): React.JSX.Element {
  if (state === 'working') {
    return (
      <span className="flex h-3 w-3 items-center justify-center" title="Claude is working">
        <span className="state-ring" />
      </span>
    )
  }
  if (state === 'waiting') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="text-wait">
        <title>Waiting for you</title>
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth={1.25} />
        <circle cx="6" cy="6" r="1.5" fill="currentColor" />
      </svg>
    )
  }
  if (open) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="text-zinc-600">
        <title>Session starting</title>
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth={1.25} />
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="text-zinc-700">
      <title>Not started</title>
      <circle cx="6" cy="6" r="1.25" fill="currentColor" />
    </svg>
  )
}
