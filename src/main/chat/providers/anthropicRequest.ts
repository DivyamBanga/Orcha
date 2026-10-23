import type {
  BetaContentBlockParam,
  BetaMessageStreamParams,
  BetaThinkingConfigParam,
  BetaTool,
  BetaToolUnion
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatModel } from '../../../shared/ai'
import {
  effortLevels,
  nearestEffort,
  specFor,
  type Effort,
  type ModelSpec,
  type Reasoning
} from '../../../shared/models'
import { fileText, type FileLoader, type HistoryMessage, type ProviderTurn } from '../provider'

// What Claude is asked on the owner's own API keys: the conversation as visible
// text, then the rules for thinking, effort, search and refusal fallbacks. The
// API answers 400 to anything a model doesn't take (API version 2026-10-21
// even rejects temperature, top_p and top_k on every model), so each request
// is shaped to the model it is going to. Pure functions; the network is in
// anthropicApi.ts.

// Replies are always streamed, so this can be generous. Thinking counts toward
// it, which is why it is not smaller.
const MAX_TOKENS = 64_000

// The 4.5 generation can only think on a fixed budget.
const THINKING_BUDGET = 8_000

const SEARCHES_PER_TURN = 5

// A request a model's safety check declines can be re-run on another model
// inside the same call. Only the current Fable, Opus and Sonnet take this
// (Haiku 5.5 has no server-side fallback).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'])

// Thinking counts toward max_tokens, and a model that can't turn it off still
// does a little at effort low: room enough that a title isn't eaten by it.
const CHORE_TOKENS = 1_024

// The facts Orcha holds about a model: by its spec id, else its API id.
function specOf(model: ChatModel): ModelSpec | null {
  return specFor(model.spec ?? model.apiModel)
}

// Your message as content blocks: its files first (images, PDFs as documents,
// text inline), then what you wrote. A message without files stays a string.
export function userContent(m: HistoryMessage, load: FileLoader): string | BetaContentBlockParam[] {
  if (m.files.length === 0) return m.text
  const blocks: BetaContentBlockParam[] = m.files.map((f) => {
    const data = load(f)
    if ('text' in data) return { type: 'text', text: fileText(f.name, data.text) }
    return f.kind === 'image'
      ? {
          type: 'image',
          source: { type: 'base64', media_type: f.mime as 'image/png', data: data.base64 }
        }
      : {
          type: 'document',
          title: f.name,
          source: { type: 'base64', media_type: 'application/pdf', data: data.base64 }
        }
  })
  if (m.text.trim()) blocks.push({ type: 'text', text: m.text })
  return blocks
}

function thinkingFor(
  r: Reasoning,
  thinking: boolean,
  summaries: boolean
): BetaThinkingConfigParam | undefined {
  if (r.budgetOnly)
    return thinking ? { type: 'enabled', budget_tokens: THINKING_BUDGET } : undefined
  // These always think, whatever the switch says. Reasoning is hidden unless
  // asked for, so ask for the summary only when someone will read it.
  if (r.off === null) return summaries ? { type: 'adaptive', display: 'summarized' } : undefined
  if (thinking) return { type: 'adaptive', display: 'summarized' }
  if (r.off === 'disabled') return { type: 'disabled' }
  // Nothing else may sit beside it (no display, no budget).
  if (r.off === 'between_tools') return { type: 'between_tools' }
  // 'omit': these models don't think unless asked to.
  return undefined
}

// Anthropic's levels are a part of the app-wide scale ('none' and 'minimal'
// belong to OpenAI).
const API_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type ApiEffort = (typeof API_EFFORTS)[number]
const isApiEffort = (e: Effort): e is ApiEffort => (API_EFFORTS as readonly string[]).includes(e)

// The effort to send: a level this model accepts (the nearest to the one
// wanted), and low enough for the way thinking is switched off. Without a
// wish, nothing is sent and the model uses its own default (always within
// the limit for switched-off thinking).
function effortFor(
  r: Reasoning,
  wanted: Effort | null,
  thinkingOff: boolean
): ApiEffort | undefined {
  if (wanted === null) return undefined
  const level = nearestEffort(effortLevels(r, thinkingOff).filter(isApiEffort), wanted)
  return level !== null && isApiEffort(level) ? level : undefined
}

function reasoningParams(
  r: Reasoning,
  effort: Effort | null,
  thinking: boolean,
  summaries: boolean
): Pick<BetaMessageStreamParams, 'thinking' | 'output_config'> {
  const config = thinkingFor(r, thinking, summaries)
  const off = !r.budgetOnly && r.off !== null && !thinking
  const level = effortFor(r, effort, off)
  return {
    ...(config ? { thinking: config } : {}),
    ...(level ? { output_config: { effort: level } } : {})
  }
}

// The model's own web search tool. The newer versions search from inside code
// execution, whose container Anthropic keeps for up to 30 days; an incognito
// chat asks for plain searching instead.
function searchTool(model: ChatModel, incognito: boolean): BetaToolUnion {
  const version = specOf(model)?.webSearch
  // 'responses' is Azure's tool; a model Orcha doesn't know gets the basic
  // version, which every model takes.
  const type = version?.startsWith('web_search_') ? version : 'web_search_20250305'
  const direct = incognito && type !== 'web_search_20250305'
  return {
    type,
    name: 'web_search',
    max_uses: SEARCHES_PER_TURN,
    ...(direct ? { allowed_callers: ['direct'] } : {})
  } as BetaToolUnion
}

// Search first, then Orcha's own tools by name: the same list in the same
// order every turn keeps the cached prefix intact.
function toolsFor(turn: ProviderTurn): BetaToolUnion[] {
  const tools: BetaToolUnion[] = []
  if (turn.settings.webSearch && turn.model.webSearch) {
    tools.push(searchTool(turn.model, turn.incognito === true))
  }
  const own = [...turn.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const t of own) {
    tools.push({
      name: t.name,
      description: t.description,
      input_schema: t.schema as BetaTool.InputSchema
    })
  }
  return tools
}

const hasContent = (m: HistoryMessage): boolean => m.text.trim() !== '' || m.files.length > 0

export function requestFor(turn: ProviderTurn, load: FileLoader): BetaMessageStreamParams {
  const { model, settings } = turn
  const params: BetaMessageStreamParams = {
    model: model.apiModel,
    max_tokens: Math.min(model.maxOutput, MAX_TOKENS),
    // Earlier replies go back as their visible text only (see provider.ts).
    messages: turn.history
      .filter(hasContent)
      .map((m) => ({ role: m.role, content: m.role === 'user' ? userContent(m, load) : m.text })),
    // The conversation's tail is cached (automatic, top-level) on top of the
    // frozen system prompt, which is cached on its own.
    cache_control: { type: 'ephemeral' },
    ...reasoningParams(model.reasoning, settings.effort, settings.thinking, true)
  }
  if (turn.system.trim()) {
    params.system = [{ type: 'text', text: turn.system, cache_control: { type: 'ephemeral' } }]
  }
  const tools = toolsFor(turn)
  if (tools.length > 0) params.tools = tools
  if (FALLBACK_MODELS.has(specOf(model)?.id ?? '')) {
    params.betas = [FALLBACK_BETA]
    params.fallbacks = 'default'
  }
  return params
}

// A short one-off answer (a title, a summary): thinking off wherever the model
// lets it be, effort low, nothing cached or searched.
export function completionRequest(
  model: ChatModel,
  system: string,
  prompt: string,
  maxOutput?: number
): BetaMessageStreamParams {
  const wanted = maxOutput ?? CHORE_TOKENS
  const room = model.reasoning.off === null ? Math.max(wanted, CHORE_TOKENS) : wanted
  return {
    model: model.apiModel,
    max_tokens: Math.min(model.maxOutput, room),
    messages: [{ role: 'user', content: prompt }],
    ...(system.trim() ? { system } : {}),
    ...reasoningParams(model.reasoning, 'low', false, false)
  }
}
