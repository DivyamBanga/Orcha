// Mirrors of the desktop MobileService payloads (src/main/services/MobileService.ts).
export type ActivityState = 'working' | 'waiting' | 'off'

export interface AskOption {
  label: string
  description: string | null
}

export interface PendingAsk {
  question: string
  options: AskOption[]
}

export interface NextStep {
  label: string
  prompt: string
}

export interface FleetSession {
  id: string
  name: string
  kind: string
  state: ActivityState
  ask: PendingAsk | null
  askAt: number | null
  lastLine: string | null
  lastActivityAgoS: number | null
  terminalOpen: boolean
}

export interface FleetProject {
  id: string
  name: string
  ssh: boolean
  sessions: FleetSession[]
  nextSteps: NextStep[]
  nextStepsAt: number | null
}

export interface FleetPayload {
  projects: FleetProject[]
  usage: { pct: number; resetsAt: number | null } | null
  at: number
}

export interface ChatBlock {
  kind: 'user' | 'assistant' | 'tools'
  text: string | null
  tools: { name: string; arg: string | null }[] | null
  at: number | null
}

// Saved pairing: candidate base URLs from the desktop QR plus the one that
// last answered.
export interface Pairing {
  urls: string[]
  token: string
  activeUrl: string
}
