// Claude Code's one-time screens on a fresh machine, which a guest's session
// answers itself (PtyManager feeds it the session's output). The text-style
// picker and the security notes only take Enter; the folder-trust question
// and the bypass-permissions warning both pre-select "No, exit", which would
// throw a newcomer straight out of the tab (Orcha runs every session in
// full-auto mode, and onboarding says so). Matched against whitespace-free
// output and loosely: ConPTY glues and even drops letters in chrome text
// (seen live: "Enter to elect", "You'rresponsible").

const SCREENS: { screen: RegExp[]; keys: (tail: string) => string[] }[] = [
  { screen: [/Choosethetextstyle/i, /Darkmode/i], keys: () => ['\r'] },
  { screen: [/Securitynotes/i, /Entertocontinue/i], keys: () => ['\r'] },
  {
    screen: [/trustthisfolder/i, /Entertoc|Esctocancel/i],
    keys: (tail) => (/❯Yes/.test(tail) ? ['\r'] : ['\x1b[B', '\r'])
  },
  {
    screen: [/BypassPermissions/i, /Iaccept/i],
    keys: (tail) => (/❯Yes/.test(tail) ? ['\r'] : ['\x1b[B', '\r'])
  }
]

export interface FirstRunState {
  tail: string // what's been drawn since the last answer, whitespace-free
  done: Set<number>
}

// Feed one chunk of (ANSI-stripped) output. Returns the keys to send if this
// chunk completed a screen that hasn't been answered yet. Each screen is
// answered once, and the caller clears `tail` once the keys are sent, so the
// next screen is matched only on its own text — a stray extra Enter on the
// next dialog would pick "No, exit". There's no quiet period after an answer:
// a static screen sends nothing more, so it must be caught on whichever chunk
// completes it.
export function firstRunKeys(state: FirstRunState, chunk: string): string[] | null {
  state.tail = (state.tail + chunk.replace(/\s+/g, '')).slice(-1500)
  const index = SCREENS.findIndex(
    (step, i) => !state.done.has(i) && step.screen.every((re) => re.test(state.tail))
  )
  if (index === -1) return null
  state.done.add(index)
  return SCREENS[index].keys(state.tail)
}
