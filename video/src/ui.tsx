// Faithful recreations of Orcha's UI pieces, animated with Remotion frames.
// Everything is drawn — no screenshots, no assets.
import React from 'react'
import { interpolate, random, useCurrentFrame } from 'remotion'
import { MONO, SANS, T } from './theme'

// --- the mark ----------------------------------------------------------------

// Two panes with a seam off-centre (Icon.tsx `Mark`, verbatim geometry).
export const Mark: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = 'white'
}) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={color} aria-hidden>
    <rect x="1.5" y="2" width="3.25" height="12" rx="1" />
    <rect x="6.25" y="2" width="8.25" height="12" rx="1" />
  </svg>
)

// --- session state glyphs ----------------------------------------------------

// Working: the .state-ring — hairline circle whose top arc is green, rotating
// one turn per 2s (frame-driven here instead of CSS).
export const StateRing: React.FC<{ size?: number; speed?: number }> = ({
  size = 13,
  speed = 1
}) => {
  const frame = useCurrentFrame()
  const angle = (frame / 60) * 360 * speed
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        border: `2px solid ${T.edgeBright}`,
        borderTopColor: T.work,
        transform: `rotate(${angle}deg)`
      }}
    />
  )
}

// Waiting: amber circle with a centre dot (SessionState 'waiting').
export const WaitGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
    <circle cx="6" cy="6" r="4" fill="none" stroke={T.wait} strokeWidth={1.4} />
    <circle cx="6" cy="6" r="1.6" fill={T.wait} />
  </svg>
)

// Idle/off: hollow zinc circle.
export const OffGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
    <circle cx="6" cy="6" r="4" fill="none" stroke={T.fainter} strokeWidth={1.4} />
  </svg>
)

export const Glyph: React.FC<{ state: 'working' | 'waiting' | 'off'; size?: number }> = ({
  state,
  size
}) =>
  state === 'working' ? (
    <StateRing size={size} />
  ) : state === 'waiting' ? (
    <WaitGlyph size={size} />
  ) : (
    <OffGlyph size={size} />
  )

// Dirty-tree diamond (git fact, neutral by design).
export const Diamond: React.FC<{ size?: number }> = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill={T.dim} aria-hidden>
    <path d="M6 2.6L9.4 6 6 9.4 2.6 6z" />
  </svg>
)

export const BranchIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 13,
  color = T.dim
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke={color}
    strokeWidth={1.5}
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="5" cy="4" r="1.5" />
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="11.2" cy="4" r="1.5" />
    <path d="M5 5.6v4.8M5 8h3.1a2.5 2.5 0 0 0 2.5-2.5" />
  </svg>
)

// --- typography helpers ------------------------------------------------------

// The app's section-label voice: 11px-ish mono caps, wide tracking.
export const Label: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style
}) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 22,
      letterSpacing: 6,
      textTransform: 'uppercase',
      color: T.dim,
      ...style
    }}
  >
    {children}
  </div>
)

// Typewriter: reveal `text` starting at `from`, `cps` chars per frame.
export const typed = (text: string, frame: number, from: number, cps = 1.4): string => {
  const n = Math.max(0, Math.floor((frame - from) * cps))
  return text.slice(0, n)
}

// Boot-cascade entrance: fade + 5px rise (the app's `orcha-rise`), scaled up
// for video. Returns a style. `at` = frame the element starts entering.
export const rise = (frame: number, at: number, dist = 14): React.CSSProperties => {
  const t = interpolate(frame - at, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  })
  return { opacity: t, transform: `translateY(${(1 - t) * dist}px)` }
}

// --- app chrome --------------------------------------------------------------

export const AppWindow: React.FC<{
  children: React.ReactNode
  width?: number
  height?: number
  style?: React.CSSProperties
}> = ({ children, width = 1520, height = 750, style }) => (
  <div
    style={{
      width,
      height,
      background: T.surface0,
      border: `1px solid ${T.edgeBright}`,
      borderRadius: 14,
      overflow: 'hidden',
      display: 'flex',
      boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      ...style
    }}
  >
    {children}
  </div>
)

export interface SessionRow {
  name: string
  state: 'working' | 'waiting' | 'off'
  branch?: boolean
  dirty?: boolean
  hint?: string
  highlight?: boolean
}

export interface ProjectCard {
  name: string
  sessions: SessionRow[]
}

// The 240px sidebar, scaled ~1.55x for 1080p legibility.
export const Sidebar: React.FC<{
  projects: ProjectCard[]
  runningCount: number
  usagePct?: number
  enterAt?: number // stagger cards in from this frame; omit for static
  width?: number
}> = ({ projects, runningCount, usagePct = 34, enterAt, width = 372 }) => {
  const frame = useCurrentFrame()
  let cardIndex = 0
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        borderRight: `1px solid ${T.edge}`,
        background: T.surface1,
        display: 'flex',
        flexDirection: 'column',
        padding: 14,
        gap: 12,
        fontFamily: SANS
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 8px',
          ...(enterAt !== undefined ? rise(frame, enterAt) : {})
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: T.tile,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Mark size={18} />
        </div>
        <div style={{ color: T.bright, fontSize: 21, fontWeight: 600 }}>Orcha</div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 999,
            border: `2.5px solid ${usagePct >= 70 ? T.wait : T.fainter}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.dim,
            fontFamily: MONO,
            fontSize: 11
          }}
        >
          {usagePct}%
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px',
          color: T.dim,
          fontSize: 15,
          ...(enterAt !== undefined ? rise(frame, enterAt + 3) : {})
        }}
      >
        {runningCount > 0 && <StateRing size={12} />}
        {runningCount} session{runningCount === 1 ? '' : 's'} running
      </div>

      {projects.map((project) => {
        const at = enterAt !== undefined ? enterAt + 6 + cardIndex++ * 5 : undefined
        return (
          <div
            key={project.name}
            style={{
              border: `1px solid ${T.edge}`,
              borderRadius: 10,
              background: T.surface2,
              padding: '10px 12px',
              ...(at !== undefined ? rise(frame, at) : {})
            }}
          >
            <div style={{ color: T.bright, fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
              {project.name}
            </div>
            {project.sessions.map((s) => (
              <div
                key={s.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 6px',
                  borderRadius: 6,
                  background: s.highlight ? T.surface3 : 'transparent'
                }}
              >
                <Glyph state={s.state} />
                <span style={{ color: T.text, fontSize: 16 }}>{s.name}</span>
                {s.branch && <BranchIcon />}
                {s.dirty && <Diamond />}
                <span style={{ flex: 1 }} />
                {s.hint && (
                  <span style={{ color: T.faint, fontFamily: MONO, fontSize: 12 }}>{s.hint}</span>
                )}
              </div>
            ))}
          </div>
        )
      })}
      <div style={{ flex: 1 }} />
      <div
        style={{
          border: `1px solid ${T.edge}`,
          borderRadius: 8,
          color: T.dim,
          textAlign: 'center',
          padding: '9px 0',
          fontSize: 15,
          ...(enterAt !== undefined ? rise(frame, enterAt + 24) : {})
        }}
      >
        + New project
      </div>
    </div>
  )
}

// --- terminal ----------------------------------------------------------------

export interface TermLine {
  text: string
  at: number // frame this line starts typing (composition-local frame passed in)
  color?: string
  instant?: boolean
  cps?: number
}

// A Claude-TUI-flavoured terminal pane. Lines type in on schedule.
export const Terminal: React.FC<{
  lines: TermLine[]
  frame: number
  title?: string
  fontSize?: number
  pad?: number
}> = ({ lines, frame, title, fontSize = 17, pad = 18 }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      background: T.surface0,
      padding: pad,
      fontFamily: MONO,
      fontSize,
      lineHeight: 1.75,
      color: T.text,
      display: 'flex',
      flexDirection: 'column'
    }}
  >
    {title && (
      <div style={{ color: T.faint, fontSize: fontSize - 4, marginBottom: 6 }}>{title}</div>
    )}
    {lines.map((line, i) => {
      if (frame < line.at) return null
      const text = line.instant ? line.text : typed(line.text, frame, line.at, line.cps ?? 1.6)
      if (!text) return null
      return (
        <div key={i} style={{ color: line.color ?? T.text, whiteSpace: 'pre' }}>
          {text}
          {!line.instant && text.length < line.text.length && (
            <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▋</span>
          )}
        </div>
      )
    })}
  </div>
)

// The TUI's busy footer: spinner dot + "esc to interrupt".
export const BusyFooter: React.FC<{ show: boolean }> = ({ show }) => {
  const frame = useCurrentFrame()
  if (!show) return null
  const dots = ['✻', '✼', '✻', '·'][Math.floor(frame / 8) % 4]
  return (
    <div style={{ marginTop: 'auto', color: T.dim, fontFamily: MONO, fontSize: 15 }}>
      <span style={{ color: T.work }}>{dots}</span> Working… <span style={{ color: T.faint }}>(esc to interrupt)</span>
    </div>
  )
}

// --- overlays ----------------------------------------------------------------

// The desktop toast: "project · session needs your answer" + verbatim question.
export const Toast: React.FC<{ title: string; body: string; entrance: number }> = ({
  title,
  body,
  entrance
}) => (
  <div
    style={{
      width: 520,
      background: T.surface2,
      border: `1px solid ${T.edgeBright}`,
      borderLeft: `3px solid ${T.wait}`,
      borderRadius: 12,
      padding: '18px 22px',
      fontFamily: SANS,
      boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      opacity: entrance,
      transform: `translateY(${(1 - entrance) * 40}px)`
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: T.tile,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Mark size={15} />
      </div>
      <div style={{ color: T.bright, fontSize: 19, fontWeight: 600 }}>{title}</div>
    </div>
    <div style={{ color: T.mid, fontSize: 17, marginTop: 8, lineHeight: 1.45 }}>“{body}”</div>
  </div>
)

// Deterministic fake QR (remotion's seeded random keeps renders stable).
export const FakeQR: React.FC<{ size?: number; cells?: number }> = ({ size = 150, cells = 21 }) => {
  const cell = size / cells
  const squares: React.ReactNode[] = []
  const finder = (fx: number, fy: number): void => {
    squares.push(
      <rect key={`f${fx}-${fy}`} x={fx * cell} y={fy * cell} width={cell * 7} height={cell * 7} fill="black" />,
      <rect key={`fi${fx}-${fy}`} x={(fx + 1) * cell} y={(fy + 1) * cell} width={cell * 5} height={cell * 5} fill="white" />,
      <rect key={`fc${fx}-${fy}`} x={(fx + 2) * cell} y={(fy + 2) * cell} width={cell * 3} height={cell * 3} fill="black" />
    )
  }
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const inFinder =
        (x < 8 && y < 8) || (x >= cells - 8 && y < 8) || (x < 8 && y >= cells - 8)
      if (!inFinder && random(`qr-${x}-${y}`) > 0.52) {
        squares.push(<rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell} height={cell} fill="black" />)
      }
    }
  }
  finder(0, 0)
  finder(cells - 7, 0)
  finder(0, cells - 7)
  return (
    <div style={{ background: 'white', padding: 12, borderRadius: 10 }}>
      <svg width={size} height={size}>{squares}</svg>
    </div>
  )
}
