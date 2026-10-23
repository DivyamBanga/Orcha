import type { Effort, Price, Reasoning } from './models'

// The shapes shared by Orcha's providers, its model catalog, and its usage
// ledger (main process and window alike). No secret ever appears in these.

// How a model is reached, and who pays for it.
//  plan    Claude on the owner's Max plan, through Claude Code (no per-token cost)
//  api     Claude through one of the owner's Anthropic API keys
//  azure   a deployment on the owner's Azure AI Foundry resource
//  ollama  a model on this computer
export type Route = 'plan' | 'api' | 'azure' | 'ollama'

export type Health =
  | 'ok'
  | 'unchecked'
  | 'checking'
  | 'invalid' // the key or endpoint was refused
  | 'unreachable' // network or service down
  | 'no-credit' // out of credit or over its spend cap
  | 'rate-limited'

export interface ApiKey {
  id: string
  label: string // 'Personal', 'Research'
  hint: string // '…3f9a': enough to tell keys apart, never the key
  isDefault: boolean
  monthlyBudgetUsd: number | null
  health: Health
  detail: string | null // why it isn't ok, in plain words
  checkedAt: number | null
  createdAt: number
}

export type DeploymentKind = 'chat' | 'image' | 'embedding' | 'transcription' | 'other'

export interface AzureDeployment {
  name: string // what goes in the request's `model` field
  model: string | null // the model it serves (a MODEL_SPECS id for chat models), when known
  kind: DeploymentKind
  enabled: boolean // offered in the picker
  source: 'probe' | 'manual'
}

export interface AzureConnection {
  endpoint: string // https://<resource>.openai.azure.com
  hint: string
  deployments: AzureDeployment[]
  monthlyBudgetUsd: number | null
  health: Health
  detail: string | null
  checkedAt: number | null
}

export interface LocalModel {
  name: string // 'qwen3.5:9b'
  sizeBytes: number
  family: string | null
  parameters: string | null // '9.7B'
  quantization: string | null // 'Q4_K_M'
  capabilities: string[] // Ollama's: completion, vision, tools, thinking, embedding
  // Thinking control: true for on/off models, the level names for models
  // that take levels (gpt-oss: low/medium/high), false when it can't think.
  think: boolean | string[]
  contextMax: number | null // the model's own limit
  context: number // what Orcha loads it with (sized from memory)
  loaded: boolean
}

export interface ModelPull {
  name: string
  status: string // Ollama's status line ('pulling manifest', 'downloading', ...)
  completed: number // bytes
  total: number // bytes, 0 while unknown
  error: string | null
}

export interface OllamaState {
  baseUrl: string // http://127.0.0.1:11434
  status: 'running' | 'starting' | 'stopped' | 'missing'
  version: string | null
  models: LocalModel[]
  pulls: ModelPull[]
}

export interface PlanState {
  signedIn: boolean // Claude Code is signed in to a Claude subscription
  plan: string | null // 'max', 'pro'
}

export interface Connections {
  plan: PlanState
  keys: ApiKey[]
  azure: AzureConnection | null
  ollama: OllamaState
}

// A model as the picker offers it: one per route, so Opus 5.5 appears once
// under "Claude · Max plan" and once under "Claude · API" (which key pays is
// a separate per-chat choice, defaulting to the default key).
export interface ChatModel {
  id: string // `${route}:${apiModel}`, e.g. 'plan:claude-opus-5-5', 'ollama:qwen3.5:9b'
  route: Route
  apiModel: string // provider model id, Azure deployment name, or Ollama model name
  label: string
  description: string
  spec: string | null // MODEL_SPECS id, when Orcha knows the model
  current: boolean // shown up top (else under "More models")
  context: number
  maxOutput: number
  vision: boolean
  pdf: boolean // reads PDFs natively (else their text is extracted)
  tools: boolean // can call Orcha's client tools (memory, search, MCP)
  reasoning: Reasoning
  sampling: 'never' | 'when-no-reasoning' | 'always'
  verbosity: boolean
  webSearch: boolean // searches natively (else through the shared search tool)
  retains30d: boolean // kept 30 days by the provider: not offered in incognito
  price: Price | null // null on the Max plan and for local models
  ready: boolean // its connection is set up and healthy
}

// What a turn asks of the model, beyond the conversation itself.
export interface TurnSettings {
  effort: Effort | null // null: the model's own default
  thinking: boolean // the Thinking switch, where the model has one
  webSearch: boolean // false: search switched off for this chat
  verbosity: 'low' | 'medium' | 'high' | null // GPT models
  temperature: number | null // only where the model accepts sampling
  topP: number | null
  keyId: string | null // which Anthropic key pays (api route); null: the default
}

// ---- usage ----

export type UsageSurface =
  | 'chat'
  | 'title'
  | 'memory'
  | 'summary'
  | 'compaction'
  | 'research'
  | 'schedule'
  | 'mission-control'
  | 'next-steps'
  | 'embedding'
  | 'image'
  | 'transcription'
  | 'claude-code'
  | 'codex'

// billed: real money on a key or Azure. plan: on the Max plan (priced only as
// an API-equivalent "plan value"). free: local. unknown: no price for it.
export type CostKind = 'billed' | 'plan' | 'free' | 'unknown'

// One model call, as the ledger keeps it. Token buckets are exclusive:
// input excludes cache reads and writes; reasoning is the part of output
// spent thinking. Never holds prompt or reply text.
export interface UsageEvent {
  id?: number
  at: number // ms epoch
  route: Route
  keyId: string | null
  model: string // as sent: provider id, deployment, or local model name
  spec: string | null // MODEL_SPECS id it was priced as
  surface: UsageSurface
  projectId: string | null
  chatId: string | null // null for incognito
  sessionId: string | null // coding session (workspace) id
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheWrite: number // OpenAI's single cache-write bucket
  output: number
  reasoning: number
  webSearches: number
  images: number
  audioSeconds: number
  longContext: boolean // priced at the model's long-context rate
  costUsd: number | null
  costKind: CostKind
  priceId: number | null // the price-book row that priced it
  durationMs: number | null
  ttftMs: number | null
  incognito: boolean
}

// A price as it stood from `effectiveFrom`; events keep the row they were
// priced with, so a later change never rewrites past costs.
export interface PriceRow {
  id: number
  model: string // MODEL_SPECS id (or image/embedding model id)
  effectiveFrom: number
  price: Price
  source: 'built-in' | 'azure-retail' | 'manual'
  note: string | null
}
