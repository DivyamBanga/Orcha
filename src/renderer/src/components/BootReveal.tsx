import { useEffect, useState } from 'react'

// Never flash: the curtain always sits closed at least this long, so a fast
// start still gets the full reveal instead of a stutter.
const MIN_HOLD_MS = 400
// ...and never trap: a setup check that hangs or rejects can't leave you
// staring at a closed curtain.
const MAX_HOLD_MS = 2000
// The seam is already lit by the time this starts, so it is just the part.
const PLAY_MS = 440

// The opening reveal. The seam lights up immediately and holds while the app
// mounts, loads its projects and spawns any restored terminals; then the two
// halves part from it — so the curtain is the loading screen rather than
// something that plays and then hands you a half-built window.
function BootReveal({ ready }: { ready: boolean }): React.JSX.Element | null {
  const [minHoldDone, setMinHoldDone] = useState(false)
  const [phase, setPhase] = useState<'hold' | 'playing' | 'done'>('hold')

  useEffect(() => {
    const min = setTimeout(() => setMinHoldDone(true), MIN_HOLD_MS)
    const max = setTimeout(() => setPhase((p) => (p === 'hold' ? 'playing' : p)), MAX_HOLD_MS)
    return () => {
      clearTimeout(min)
      clearTimeout(max)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'hold' || !ready || !minHoldDone) return
    // Two frames before starting. The app has just mounted behind the curtain,
    // so the frame we're on is already carrying a large commit; waiting for a
    // clean boundary keeps the first step of the animation from landing late
    // and reading as a hitch.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPhase('playing'))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [phase, ready, minHoldDone])

  // Unmount once it's open, which releases the two promoted layers and the
  // will-change hints rather than leaving them alive for the session.
  useEffect(() => {
    if (phase !== 'playing') return
    const done = setTimeout(() => setPhase('done'), PLAY_MS)
    return () => clearTimeout(done)
  }, [phase])

  if (phase === 'done') return null

  return (
    <div className={`boot boot-armed${phase === 'playing' ? ' boot-playing' : ''}`}>
      <div className="boot-half boot-half-left" />
      <div className="boot-half boot-half-right" />
      <div className="boot-bloom" />
      <div className="boot-seam" />
    </div>
  )
}

export default BootReveal
