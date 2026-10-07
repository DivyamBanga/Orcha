export interface Project {
  id: string
  name: string
  repoPath: string // unique key; for remote projects a display/dedup ssh:// string, not a real path
  createdAt: number
  remotePath: string | null // actual POSIX path to cd into on the server; null = local project
  sshHost: string | null
  sshUser: string | null
  sshPort: number | null // null = default 22
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Which coding agent a session tab runs. Codex tabs exist only in guest mode.
export type Agent = 'claude' | 'codex'

export interface Workspace {
  id: string
  projectId: string
  name: string
  branch: string
  worktreePath: string // for kind 'main' this IS the repo folder
  sessionId: string | null
  status: 'active' | 'archived'
  createdAt: number
  lastActivityAt: number | null
  model: string | null // null = default; Claude: 'opus' | 'sonnet' | 'haiku'; Codex: 'gpt-6-sol' | 'gpt-6-astra'
  effort: EffortLevel | null // null = default
  kind: 'main' | 'worktree'
  agent: Agent
}

export type SessionStatus = 'idle' | 'busy' | 'error'

// Renderer-side chat items, reduced from raw SDK messages.
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_text'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      input: unknown
      result?: string
      isError?: boolean
    }
  | { kind: 'error'; text: string }

export interface GitStatus {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
}

// Per-workspace override of how the spawned `claude` process authenticates.
// 'subscription' (default) uses whatever OAuth login is active machine-wide;
// 'apiKey' spawns with ANTHROPIC_API_KEY set to `apiKey`, overriding it.
export interface WorkspaceAuth {
  mode: 'subscription' | 'apiKey'
  apiKey?: string
}

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  estimatedCostUsd: number | null // null if model is unrecognized/default
}

// One real subscription limit, exactly as Anthropic reports it to Claude
// Code's own `/usage` view (GET /api/oauth/usage) — not a local estimate.
// Which limits exist depends on the plan: Pro currently returns only the
// session window, Max adds weekly and per-model weekly ones.
export interface PlanLimit {
  key: string
  label: string
  utilization: number // percent 0-100, as returned; may exceed 100
  resetsAt: number | null // ms epoch
}

export type PlanStatus = 'ok' | 'stale' | 'no-auth' | 'unavailable'

export interface PlanUsage {
  status: PlanStatus
  plan: string | null // 'pro' | 'max' | ... from the local credentials file
  limits: PlanLimit[] // empty unless status is 'ok' or 'stale'
  message: string | null // why the numbers are stale/missing
}

export interface ProjectUsage {
  cwd: string
  name: string
  costUsd: number
  share: number // 0-1 of the window's local cost
}

export interface ModelUsage {
  tier: string // 'opus' | 'sonnet' | 'haiku'
  costUsd: number
  share: number // 0-1
}

export interface DailyUsagePoint {
  date: string // YYYY-MM-DD, local time
  costUsd: number
}

export interface BurnRate {
  pctPerHour: number // real quota percent per hour
  hitsLimitAt: number | null // ms epoch; null when not burning
  reachesReset: boolean // true if the window resets before the limit is hit
}

// Everything derived from local ~/.claude/projects transcripts: approximate,
// this machine only. Used to answer "what is burning the quota", never to
// state the quota itself — that comes from PlanUsage.
export interface UsageInsights {
  projects: ProjectUsage[]
  models: ModelUsage[]
  cacheHitRate: number | null // 0-1 of input tokens served from cache, 7d
  burn: BurnRate | null
  windowCostUsd: number // API-equivalent $ inside the current session window
  weekCostUsd: number // API-equivalent $ over the last 7 days
  monthlyProjectionUsd: number // weekCostUsd extrapolated to 30 days
  daily: DailyUsagePoint[] // last 14 days
}

export interface UsageSummary {
  plan: PlanUsage
  insights: UsageInsights
  fetchedAt: number
}

export interface CodexStatus {
  cliInstalled: boolean
  authenticated: boolean
  pluginInstalled: boolean
}

// A pending ask parsed verbatim from the transcript: the question plus any
// AskUserQuestion options, so a remote surface can render real answer buttons
// instead of raw JSON (which is where other mobile clients fall down).
export interface AskOption {
  label: string
  description: string | null
}

export interface PendingAsk {
  question: string
  options: AskOption[]
}

// One rendered block of a session transcript for the phone's chat view.
// Consecutive tool calls collapse into a single 'tools' block so the feed
// reads as a digest, not a log.
export interface ChatBlock {
  kind: 'user' | 'assistant' | 'tools'
  text: string | null
  tools: { name: string; arg: string | null }[] | null
  at: number | null // ms epoch of the transcript entry, when present
}

// One AI-suggested next action for a project, shown as a tappable chip on
// the phone. `prompt` is the full instruction the chip dispatches (always
// shown editable before sending — chips preview a dispatch, never blind-send).
export interface NextStep {
  label: string
  prompt: string
}

// Pairing/status info for the phone companion (Settings → Phone).
export interface MobileInfo {
  port: number
  token: string
  urls: string[] // http://<addr>:<port>, Tailscale address first when present
  pushReady: boolean // a phone has registered a push token
}

// One remembered clipboard item, as shown in the paste-history overlay. The
// full text and the saved PNG stay in the main process — only what the list
// needs to draw crosses IPC, so a 200 KB clip doesn't ship on every change.
export interface ClipEntry {
  id: string
  kind: 'text' | 'image'
  preview: string
  lines: number
  chars: number
  thumb: string | null // data URL, images only
}

// What a paste resolved to for a given session. Images and dropped/copied
// files become a path the session can reference with @ (copied to the server
// first for remote sessions), never a stream of bytes through the terminal.
export type PasteTarget =
  { kind: 'text'; text: string } | { kind: 'path'; path: string } | { kind: 'empty' }

// ---- guest mode: running on someone else's credits through their relay ----

// A budget on the relay. Each is one-time and topped up by the host.
export type CreditPool = 'claude' | 'sol' | 'astra'

export interface PoolBalance {
  pool: CreditPool
  label: string
  cap: number // USD granted so far, top-ups included
  spent: number // USD spent, lifetime
}

// What the relay knows about this guest right now. `error` is set (and the
// numbers are the last known ones) when the relay couldn't be reached.
export interface GuestBalance {
  name: string
  hostName: string
  status: 'active' | 'revoked'
  pools: PoolBalance[]
  // Spend per session tab (workspace id), recent tabs only.
  sessions: { session: string; pool: CreditPool; cost: number; updatedAt: number }[]
  fetchedAt: number
  error: string | null
}

export interface GuestUsage {
  hourly: { hour: number; pool: CreditPool; model: string; cost: number; requests: number }[]
  projects: { project: string; pool: CreditPool; cost: number }[]
  models: {
    pool: CreditPool
    model: string
    cost: number
    requests: number
    input: number
    cached: number
    output: number
  }[]
}

export interface GuestStatus {
  paired: boolean
  name: string | null
  hostName: string | null
}

// The coding tools a guest machine needs.
export type ToolName = 'claude' | 'codex' | 'git'

export interface ToolState {
  installed: boolean
  version: string | null
  // Installed and new enough for Orcha (Codex needs a recent version).
  ready: boolean
}

export type ToolsStatus = Record<ToolName, ToolState>

// ---- updates ----

// 'manual': the new version's disk image was opened for the person to drag in
// (Orcha couldn't replace itself where it's installed).
export interface UpdateState {
  phase: 'idle' | 'available' | 'downloading' | 'restarting' | 'manual'
  version: string | null
  error: string | null
}

// ---- the host side: managing guests on your own relay ----

export interface AdminGuest {
  id: string
  name: string
  hostName: string
  status: 'active' | 'revoked'
  pools: PoolBalance[]
  createdAt: number
  lastActiveAt: number | null
  paired: boolean
}
