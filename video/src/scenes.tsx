// The eight scenes. Every scene runs inside its own <Sequence>, so
// useCurrentFrame() is scene-local throughout.
import React from 'react'
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { MONO, SANS, T } from './theme'
import {
  AppWindow,
  BranchIcon,
  BusyFooter,
  FakeQR,
  Glyph,
  Label,
  Mark,
  Sidebar,
  StateRing,
  Terminal,
  Toast,
  WaitGlyph,
  rise,
  typed,
  type ProjectCard,
  type TermLine
} from './ui'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

// Bottom-left headline: the app's mono-caps label voice + a big sans line.
const Headline: React.FC<{ label: string; head: string; at?: number }> = ({
  label,
  head,
  at = 8
}) => {
  const frame = useCurrentFrame()
  return (
    <div style={{ position: 'absolute', left: 100, bottom: 74, fontFamily: SANS }}>
      <div style={rise(frame, at)}>
        <Label>{label}</Label>
      </div>
      <div
        style={{
          color: T.bright,
          fontSize: 60,
          fontWeight: 650,
          letterSpacing: -0.5,
          marginTop: 10,
          ...rise(frame, at + 4, 20)
        }}
      >
        {head}
      </div>
    </div>
  )
}

// Slow push-in that keeps every scene alive between cuts.
const Push: React.FC<{ children: React.ReactNode; from?: number; to?: number }> = ({
  children,
  from = 1,
  to = 1.035
}) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const scale = interpolate(frame, [0, durationInFrames], [from, to])
  return <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>
}

// App window entrance: small spring settle.
const useSettle = (at = 0): React.CSSProperties => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame: frame - at, fps, config: { damping: 16, mass: 0.7 } })
  return { transform: `scale(${0.965 + 0.035 * s})`, opacity: interpolate(s, [0, 0.4], [0, 1], clamp) }
}

const Floor: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(1200px 700px at 50% 38%, ${T.surface1} 0%, ${T.surface0} 70%)`,
      alignItems: 'center',
      justifyContent: 'center'
    }}
  >
    {children}
  </AbsoluteFill>
)

// ---- S1 · hook --------------------------------------------------------------

export const S1Hook: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  // seam grows, blooms, halves part — the app's own opening, writ large
  const seamGrow = interpolate(frame, [4, 16], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) })
  const part = interpolate(frame, [18, 40], [0, 960], { ...clamp, easing: Easing.inOut(Easing.cubic) })
  const bloom = interpolate(frame, [14, 20, 34], [0, 1, 0], clamp)
  const markPop = spring({ frame: frame - 26, fps, config: { damping: 13, mass: 0.6 } })
  const sub = typed('a command deck for Claude Code', frame, 52, 1.1)
  return (
    <AbsoluteFill style={{ background: T.surface0, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        <div
          style={{
            width: 128,
            height: 128,
            borderRadius: 30,
            background: T.tile,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${markPop})`,
            boxShadow: '0 30px 90px rgba(0,0,0,0.6)'
          }}
        >
          <Mark size={76} />
        </div>
        <div
          style={{
            color: T.bright,
            fontFamily: SANS,
            fontSize: 130,
            fontWeight: 650,
            letterSpacing: -2,
            opacity: interpolate(frame, [32, 42], [0, 1], clamp),
            transform: `translateX(${interpolate(frame, [32, 46], [-30, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px)`
          }}
        >
          Orcha
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 330,
          fontFamily: MONO,
          fontSize: 26,
          letterSpacing: 8,
          textTransform: 'uppercase',
          color: T.dim
        }}
      >
        {sub}
      </div>
      {/* covering halves that part from the centre */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          right: '50%',
          background: T.surface0,
          transform: `translateX(${-part}px)`
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          left: '50%',
          background: T.surface0,
          transform: `translateX(${part}px)`
        }}
      />
      {/* the lit seam */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: 2,
          marginLeft: -1,
          transform: `scaleY(${seamGrow}) translateX(${part >= 958 ? 4000 : 0}px)`,
          background: `linear-gradient(to bottom, transparent, rgba(250,250,250,${0.5 + bloom * 0.5}), transparent)`,
          boxShadow: `0 0 ${18 + bloom * 40}px rgba(250,250,250,${0.25 + bloom * 0.45})`
        }}
      />
    </AbsoluteFill>
  )
}

// ---- S2 · the fleet ---------------------------------------------------------

const FLEET_PROJECTS: ProjectCard[] = [
  {
    name: 'orcha',
    sessions: [{ name: 'main', state: 'working', dirty: true, hint: '^1' }]
  },
  { name: 'blog', sessions: [{ name: 'main', state: 'off', hint: '^2' }] },
  { name: 'sidequest', sessions: [{ name: 'main', state: 'off', hint: '^3' }] }
]

export const S2Fleet: React.FC = () => {
  const frame = useCurrentFrame()
  const settle = useSettle(0)
  const lines: TermLine[] = [
    { text: 'PS C:\\Projects\\orcha> claude', at: 8, cps: 2.2 },
    { text: '✻ Claude Code — orcha · main', at: 24, color: T.dim, instant: true },
    { text: '', at: 25, instant: true },
    { text: '> tighten the share tunnel reconnect', at: 30, cps: 2 },
    { text: '● Read  ShareService.ts', at: 56, color: T.mid, instant: true },
    { text: '● Edit  ShareService.ts', at: 70, color: T.mid, instant: true },
    { text: '● Bash  npm test', at: 84, color: T.mid, instant: true },
    { text: '  ✓ 14 passed', at: 104, color: T.work, instant: true }
  ]
  return (
    <Floor>
      <Push>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 210 }}>
          <div style={settle}>
            <AppWindow>
              <Sidebar projects={FLEET_PROJECTS} runningCount={1} enterAt={4} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 18px',
                    borderBottom: `1px solid ${T.edge}`,
                    fontFamily: SANS,
                    fontSize: 16,
                    color: T.mid
                  }}
                >
                  <span style={{ color: T.bright, fontWeight: 600 }}>main</span>
                  <BranchIcon />
                  <span style={{ fontFamily: MONO, fontSize: 14 }}>main</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: T.dim }}>Commit + Push</span>
                  <span style={{ color: T.dim }}>Share</span>
                  <span style={{ color: T.dim }}>Phone</span>
                </div>
                <Terminal lines={lines} frame={frame} />
                <div style={{ padding: 18 }}>
                  <BusyFooter show={frame > 40 && frame < 100} />
                </div>
              </div>
            </AppWindow>
          </div>
        </AbsoluteFill>
      </Push>
      <Headline label="your projects" head="Every repo. One window." />
    </Floor>
  )
}

// ---- S3 · parallel sessions -------------------------------------------------

const PARALLEL_PROJECTS: ProjectCard[] = [
  {
    name: 'orcha',
    sessions: [
      { name: 'main', state: 'working', hint: '^1' },
      { name: 'share-tunnel', state: 'working', branch: true, hint: '^2' },
      { name: 'ui-pass', state: 'working', branch: true, hint: '^3' }
    ]
  },
  { name: 'blog', sessions: [{ name: 'main', state: 'off', hint: '^4' }] }
]

const PANE_TASKS: { title: string; lines: TermLine[] }[] = [
  {
    title: 'main',
    lines: [
      { text: '> fix the WAL test', at: 14, cps: 2.4 },
      { text: '● Bash  npm test', at: 34, color: T.mid, instant: true },
      { text: '  ✓ green', at: 58, color: T.work, instant: true }
    ]
  },
  {
    title: 'share-tunnel · orcha/share-tunnel',
    lines: [
      { text: '> add reconnect backoff', at: 24, cps: 2.4 },
      { text: '● Edit  ShareService.ts', at: 48, color: T.mid, instant: true },
      { text: '● Write reconnect.test.ts', at: 66, color: T.mid, instant: true }
    ]
  },
  {
    title: 'ui-pass · orcha/ui-pass',
    lines: [
      { text: '> polish the usage ring', at: 34, cps: 2.4 },
      { text: '● Edit  UsageGlance.tsx', at: 60, color: T.mid, instant: true },
      { text: '● Bash  npm run lint', at: 78, color: T.mid, instant: true }
    ]
  }
]

export const S3Parallel: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const settle = useSettle(0)
  return (
    <Floor>
      <Push>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 210 }}>
          <div style={settle}>
            <AppWindow>
              <Sidebar projects={PARALLEL_PROJECTS} runningCount={3} />
              <div style={{ flex: 1, display: 'flex', gap: 1, background: T.edge }}>
                {PANE_TASKS.map((pane, i) => {
                  const pop = spring({ frame: frame - (4 + i * 9), fps, config: { damping: 15, mass: 0.6 } })
                  return (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        background: T.surface0,
                        opacity: interpolate(pop, [0, 0.35], [0, 1], clamp),
                        transform: `translateY(${(1 - pop) * 60}px)`
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          padding: '10px 14px',
                          borderBottom: `1px solid ${T.edge}`,
                          fontFamily: MONO,
                          fontSize: 13,
                          color: T.dim
                        }}
                      >
                        <StateRing size={11} />
                        {pane.title}
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                        <Terminal lines={pane.lines} frame={frame} fontSize={15} pad={14} />
                        <div style={{ padding: 14 }}>
                          <BusyFooter show={frame > 40 + i * 9} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </AppWindow>
          </div>
        </AbsoluteFill>
      </Push>
      <Headline label="git worktrees" head="Parallel sessions. Zero collisions." />
    </Floor>
  )
}

// ---- S4 · Mission Control ---------------------------------------------------

export const S4Mission: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const settle = useSettle(0)
  const userText = typed('get every project moving', frame, 10, 1.8)
  const tools = [
    { name: 'list_sessions', arg: '', at: 34 },
    { name: 'send_prompt_to_session', arg: 'orcha · share-tunnel', at: 52 },
    { name: 'send_prompt_to_session', arg: 'blog · main', at: 68 }
  ]
  const reply = typed('3 sessions working. I’ll ping you if anyone blocks.', frame, 96, 1.5)
  const blogWorking = frame > 84
  const projects: ProjectCard[] = [
    {
      name: 'orcha',
      sessions: [
        { name: 'main', state: 'working' },
        { name: 'share-tunnel', state: 'working', branch: true }
      ]
    },
    { name: 'blog', sessions: [{ name: 'main', state: blogWorking ? 'working' : 'off' }] }
  ]
  return (
    <Floor>
      <Push>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 210 }}>
          <div style={settle}>
            <AppWindow>
              <div
                style={{
                  width: 372,
                  flexShrink: 0,
                  borderRight: `1px solid ${T.edge}`,
                  background: T.surface1,
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  fontFamily: SANS
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: T.surface3,
                    border: `1px solid ${T.edgeBright}`
                  }}
                >
                  <StateRing size={12} />
                  <span style={{ color: T.bright, fontSize: 17, fontWeight: 600 }}>
                    Mission Control
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: T.faint, fontFamily: MONO, fontSize: 12 }}>^0</span>
                </div>
                <Sidebar
                  projects={projects}
                  runningCount={blogWorking ? 3 : 2}
                  width={344}
                  usagePct={41}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 26, gap: 16, fontFamily: SANS }}>
                <div style={{ alignSelf: 'flex-end', maxWidth: 560 }}>
                  <div
                    style={{
                      background: T.surface3,
                      border: `1px solid ${T.edge}`,
                      borderRadius: 14,
                      borderBottomRightRadius: 4,
                      padding: '12px 18px',
                      color: T.text,
                      fontSize: 19
                    }}
                  >
                    {userText}
                  </div>
                </div>
                {tools.map(
                  (tool, i) =>
                    frame >= tool.at && (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          background: T.surface1,
                          border: `1px solid ${T.edge}`,
                          borderRadius: 10,
                          padding: '10px 16px',
                          width: 560,
                          fontFamily: MONO,
                          fontSize: 15,
                          color: T.mid,
                          ...rise(frame, tool.at, 10)
                        }}
                      >
                        {frame < tool.at + 12 ? (
                          <StateRing size={11} speed={2.2} />
                        ) : (
                          <span style={{ color: T.work }}>✓</span>
                        )}
                        {tool.name}
                        {tool.arg && <span style={{ color: T.faint }}>{tool.arg}</span>}
                      </div>
                    )
                )}
                {frame > 94 && (
                  <div style={{ color: T.text, fontSize: 19, lineHeight: 1.6, maxWidth: 640 }}>
                    {reply}
                  </div>
                )}
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    border: `1px solid ${T.edge}`,
                    borderRadius: 12,
                    padding: '13px 18px',
                    color: T.faint,
                    fontSize: 16
                  }}
                >
                  message mission control…
                </div>
              </div>
            </AppWindow>
          </div>
        </AbsoluteFill>
      </Push>
      <Headline label="mission control" head="One chat commands the fleet." />
    </Floor>
  )
}

// ---- S5 · needs you ---------------------------------------------------------

export const S5NeedsYou: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const settle = useSettle(0)
  const flip = frame > 16
  const pop = spring({ frame: frame - 16, fps, config: { damping: 10, mass: 0.5 } })
  const toastIn = spring({ frame: frame - 30, fps, config: { damping: 15, mass: 0.7 } })
  const projects: ProjectCard[] = [
    {
      name: 'orcha',
      sessions: [
        { name: 'main', state: 'working' },
        {
          name: 'share-tunnel',
          state: flip ? 'waiting' : 'working',
          branch: true,
          highlight: flip
        }
      ]
    },
    { name: 'blog', sessions: [{ name: 'main', state: 'working' }] }
  ]
  return (
    <Floor>
      <Push>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 210 }}>
          <div style={settle}>
            <AppWindow>
              <Sidebar projects={projects} runningCount={2} usagePct={47} />
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative'
                }}
              >
                {/* the amber ask, blown up centre-frame */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 20,
                    transform: `scale(${0.8 + pop * 0.2})`,
                    opacity: flip ? 1 : 0
                  }}
                >
                  <WaitGlyph size={42} />
                  <div style={{ fontFamily: SANS, fontSize: 34, color: T.text }}>
                    Waiting on <span style={{ color: T.bright, fontWeight: 600 }}>you</span>
                  </div>
                </div>
                <div style={{ position: 'absolute', right: 34, bottom: 30 }}>
                  <Toast
                    title="orcha · share-tunnel needs your answer"
                    body="Token in the URL, or signed cookie?"
                    entrance={toastIn}
                  />
                </div>
              </div>
            </AppWindow>
          </div>
        </AbsoluteFill>
      </Push>
      <Headline label="no babysitting" head="Pinged only when it matters." />
    </Floor>
  )
}

// ---- S6 · live share --------------------------------------------------------

export const S6Share: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const chipPop = spring({ frame: frame - 8, fps, config: { damping: 14, mass: 0.6 } })
  const browserIn = spring({ frame: frame - 26, fps, config: { damping: 17, mass: 0.8 } })
  const viewerLines: TermLine[] = [
    { text: '● Edit  ShareService.ts', at: 48, color: T.mid, instant: true },
    { text: '● Bash  npm test', at: 62, color: T.mid, instant: true },
    { text: '  ✓ reconnect holds through 3 drops', at: 80, color: T.work, instant: true }
  ]
  const dotPulse = 0.55 + 0.45 * Math.sin(frame / 5)
  return (
    <Floor>
      <div style={{ display: 'flex', alignItems: 'center', gap: 70, paddingBottom: 170 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 26,
            alignItems: 'center',
            transform: `scale(${chipPop})`,
            opacity: interpolate(chipPop, [0, 0.4], [0, 1], clamp)
          }}
        >
          <FakeQR size={190} />
          <div
            style={{
              fontFamily: MONO,
              fontSize: 16,
              color: T.mid,
              background: T.surface2,
              border: `1px solid ${T.edgeBright}`,
              borderRadius: 10,
              padding: '12px 20px'
            }}
          >
            https://…trycloudflare.com/s/3f9c1a
          </div>
        </div>
        <div
          style={{
            width: 1050,
            transform: `translateX(${(1 - browserIn) * 500}px)`,
            opacity: interpolate(browserIn, [0, 0.35], [0, 1], clamp)
          }}
        >
          {/* browser chrome */}
          <div
            style={{
              background: T.surface2,
              border: `1px solid ${T.edgeBright}`,
              borderRadius: 14,
              overflow: 'hidden',
              boxShadow: '0 40px 120px rgba(0,0,0,0.55)'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 16px',
                borderBottom: `1px solid ${T.edge}`
              }}
            >
              <div style={{ display: 'flex', gap: 7 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ width: 12, height: 12, borderRadius: 6, background: T.fainter }} />
                ))}
              </div>
              <div
                style={{
                  flex: 1,
                  background: T.surface0,
                  border: `1px solid ${T.edge}`,
                  borderRadius: 8,
                  padding: '7px 14px',
                  fontFamily: MONO,
                  fontSize: 14,
                  color: T.dim
                }}
              >
                …trycloudflare.com/s/3f9c1a
              </div>
            </div>
            {/* the viewer page, as ShareService serves it */}
            <div style={{ background: '#0b0b0d' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '13px 20px',
                  borderBottom: '1px solid #27272a',
                  fontFamily: MONO,
                  fontSize: 15
                }}
              >
                <div style={{ width: 10, height: 10, borderRadius: 5, background: T.work, opacity: dotPulse }} />
                <span style={{ color: '#fafafa', fontWeight: 600 }}>share-tunnel</span>
                <span style={{ color: '#71717a', fontSize: 13 }}>live · read-only</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: '#52525b', fontSize: 13 }}>shared from orcha</span>
              </div>
              <div style={{ height: 320, display: 'flex' }}>
                <Terminal lines={viewerLines} frame={frame} fontSize={16} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <Headline label="live share" head="A link anyone can watch." />
    </Floor>
  )
}

// ---- S7 · phone -------------------------------------------------------------

export const S7Phone: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const phoneUp = spring({ frame: frame - 2, fps, config: { damping: 16, mass: 0.9 } })
  const bannerIn = spring({ frame: frame - 18, fps, config: { damping: 14, mass: 0.6 } })
  const tapAt = 62
  const tap = spring({ frame: frame - tapAt, fps, config: { damping: 11, mass: 0.5 } })
  const answered = frame > tapAt + 12
  // the notification leaves once it's been dealt with
  const bannerOut = spring({ frame: frame - (tapAt + 8), fps, config: { damping: 16, mass: 0.7 } })
  return (
    <Floor>
      <div style={{ display: 'flex', alignItems: 'center', gap: 120, paddingBottom: 40 }}>
        <div style={{ width: 620 }}>
          <Headline label="any device" head="Answer from your pocket." />
        </div>
        <div
          style={{
            width: 424,
            height: 880,
            borderRadius: 48,
            border: `2px solid ${T.edgeBright}`,
            background: '#0b0b0d',
            overflow: 'hidden',
            position: 'relative',
            transform: `translateY(${(1 - phoneUp) * 500}px)`,
            boxShadow: '0 50px 140px rgba(0,0,0,0.65)',
            fontFamily: SANS
          }}
        >
          {/* push banner */}
          <div
            style={{
              position: 'absolute',
              top: 16,
              left: 14,
              right: 14,
              zIndex: 2,
              background: T.surface3,
              border: `1px solid ${T.edgeBright}`,
              borderRadius: 16,
              padding: '13px 16px',
              transform: `translateY(${(1 - bannerIn) * -120 - bannerOut * 180}px)`,
              opacity: interpolate(bannerIn, [0, 0.3], [0, 1], clamp) * (1 - bannerOut)
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: T.tile,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Mark size={13} />
              </div>
              <span style={{ color: T.bright, fontSize: 15, fontWeight: 600 }}>
                orcha · share-tunnel
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: T.faint, fontSize: 12 }}>now</span>
            </div>
            <div style={{ color: T.mid, fontSize: 14, marginTop: 5 }}>
              needs your answer — “Token in the URL, or signed cookie?”
            </div>
          </div>

          {/* app: header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '90px 20px 12px',
              borderBottom: `1px solid ${T.edge}`
            }}
          >
            <span style={{ color: T.bright, fontSize: 21, fontWeight: 600 }}>Orcha</span>
            <span style={{ flex: 1 }} />
            <div
              style={{
                minWidth: 52,
                height: 30,
                borderRadius: 15,
                border: `2px solid ${T.fainter}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: T.dim,
                fontFamily: MONO,
                fontSize: 13
              }}
            >
              47%
            </div>
          </div>

          {/* needs you card */}
          <div style={{ padding: 16 }}>
            <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 2, color: T.faint, marginBottom: 8 }}>
              NEEDS YOU
            </div>
            <div
              style={{
                background: T.surface1,
                border: `1px solid ${T.edge}`,
                borderLeft: `3px solid ${answered ? T.work : T.wait}`,
                borderRadius: 12,
                padding: 14
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {answered ? (
                  <span style={{ color: T.work, fontSize: 15 }}>✓</span>
                ) : (
                  <WaitGlyph size={14} />
                )}
                <span style={{ color: T.text, fontSize: 15, fontWeight: 600 }}>
                  orcha · share-tunnel
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: T.faint, fontFamily: MONO, fontSize: 12 }}>2m</span>
              </div>
              {answered ? (
                <div style={{ color: T.dim, fontSize: 15, marginTop: 8 }}>
                  Answered: Signed cookie
                </div>
              ) : (
                <>
                  <div style={{ color: T.mid, fontSize: 15, marginTop: 8, lineHeight: 1.4 }}>
                    “Token in the URL, or signed cookie?”
                  </div>
                  {['Signed cookie', 'Token in URL'].map((option, i) => (
                    <div
                      key={option}
                      style={{
                        border: `1px solid ${T.edgeBright}`,
                        borderRadius: 10,
                        padding: '10px 14px',
                        marginTop: 8,
                        color: T.bright,
                        fontSize: 15,
                        fontWeight: 600,
                        background: i === 0 && frame > tapAt ? T.surface3 : 'transparent',
                        transform: i === 0 ? `scale(${1 - 0.06 * Math.sin(Math.min(1, Math.max(0, tap)) * Math.PI)})` : undefined
                      }}
                    >
                      {option}
                      {i === 0 && (
                        <span style={{ color: T.faint, fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                          harder to leak
                        </span>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* project rows */}
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { p: 'orcha', s: answered ? ('working' as const) : ('waiting' as const), line: answered ? 'Wiring signed cookies' : 'waiting on your answer' },
                { p: 'blog', s: 'working' as const, line: 'Drafting the release post' }
              ].map((row) => (
                <div
                  key={row.p}
                  style={{
                    background: T.surface1,
                    border: `1px solid ${T.edge}`,
                    borderRadius: 12,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10
                  }}
                >
                  <Glyph state={row.s} size={13} />
                  <span style={{ color: T.text, fontSize: 15, fontWeight: 600 }}>{row.p}</span>
                  <span style={{ color: T.faint, fontSize: 13, marginLeft: 'auto' }}>{row.line}</span>
                </div>
              ))}
              <div style={{ fontFamily: MONO, fontSize: 12, color: T.faint, paddingLeft: 4 }}>
                ▸ next: Add tunnel retry · Ship the fix
              </div>
            </div>
          </div>
        </div>
      </div>
    </Floor>
  )
}

// ---- S8 · outro -------------------------------------------------------------

export const S8Outro: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const left = spring({ frame: frame - 8, fps, config: { damping: 12, mass: 0.6 } })
  const right = spring({ frame: frame - 15, fps, config: { damping: 12, mass: 0.6 } })
  const word = spring({ frame: frame - 30, fps, config: { damping: 16, mass: 0.7 } })
  const tag = typed('Run every Claude at once.', frame, 52, 1.2)
  const glow = interpolate(frame, [90, 130], [0, 1], clamp)
  return (
    <AbsoluteFill style={{ background: T.surface0, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
        {/* the mark's two panes arriving separately */}
        <svg width={170} height={170} viewBox="0 0 16 16" style={{ overflow: 'visible' }}>
          <rect
            x="1.5" y="2" width="3.25" height="12" rx="1" fill="white"
            style={{ transform: `translateY(${(1 - left) * -18}px)`, opacity: left }}
          />
          <rect
            x="6.25" y="2" width="8.25" height="12" rx="1" fill="white"
            style={{ transform: `translateY(${(1 - right) * 18}px)`, opacity: right }}
          />
        </svg>
        <div
          style={{
            color: T.bright,
            fontFamily: SANS,
            fontSize: 150,
            fontWeight: 650,
            letterSpacing: -2,
            clipPath: `inset(0 ${(1 - word) * 100}% 0 0)`,
            opacity: interpolate(word, [0, 0.2], [0, 1], clamp)
          }}
        >
          Orcha
        </div>
      </div>
      <div
        style={{
          marginTop: 46,
          fontFamily: SANS,
          fontSize: 40,
          color: T.mid,
          height: 56
        }}
      >
        {tag}
        {tag.length > 0 && tag.length < 25 && <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▋</span>}
      </div>
      {/* the seam, resting */}
      <div
        style={{
          position: 'absolute',
          bottom: 150,
          width: 380,
          height: 2,
          background: `linear-gradient(to right, transparent, rgba(250,250,250,${0.18 + glow * 0.14}), transparent)`
        }}
      />
    </AbsoluteFill>
  )
}
