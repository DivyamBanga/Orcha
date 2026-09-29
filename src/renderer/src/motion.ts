import { useEffect, useRef, useState } from 'react'

// Small motion helpers shared by overlays and the money views. Kept out of the
// component files (react-refresh only allows component exports there).

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Keeps something mounted for `exitMs` after `open` turns false, so it can
// play its exit animation instead of vanishing. `closing` is true during that
// window. Uses the adjust-during-render pattern for the open edge and a timer
// callback for the close edge (no synchronous setState in an effect body).
export function usePresence(open: boolean, exitMs = 150): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setMounted(true)
  }
  useEffect(() => {
    if (open || !mounted) return
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : exitMs)
    return () => clearTimeout(timer)
  }, [open, mounted, exitMs])
  return { mounted, closing: mounted && !open }
}

// Eases a displayed number toward `target` (cubic ease-out), so a dollar
// figure ticks to its new value instead of snapping. Starts from wherever the
// previous tween had got to, so rapid updates never jump backwards.
export function useAnimatedNumber(target: number, durationMs = 700): number {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const from = current.current
    if (from === target) return
    if (reducedMotion()) {
      const frame = requestAnimationFrame(() => {
        current.current = target
        setShown(target)
      })
      return () => cancelAnimationFrame(frame)
    }
    let frame = 0
    let start: number | null = null
    const tick = (now: number): void => {
      if (start === null) start = now
      const t = Math.min((now - start) / durationMs, 1)
      const value = from + (target - from) * (1 - Math.pow(1 - t, 3))
      current.current = value
      setShown(value)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs])
  return shown
}
