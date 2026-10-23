import type { ModelInfo } from '@anthropic-ai/sdk/resources/models'
import type { Health } from '../../shared/ai'
import type { Effort } from '../../shared/models'
import { anthropicClient } from '../chat/providers/anthropicApi'
import { toProviderError } from '../chat/providers/anthropicErrors'

// Asking Anthropic about an API key: does it work, and which models does it
// reach. Both go through the Models API, which costs nothing.

// Short, so adding a key gives an answer instead of a wait.
const TIMEOUT_MS = 20_000

const client = (apiKey: string, fetchFn?: typeof fetch): ReturnType<typeof anthropicClient> =>
  anthropicClient(apiKey, { fetch: fetchFn, maxRetries: 0, timeout: TIMEOUT_MS })

export async function testKey(
  apiKey: string,
  fetchFn?: typeof fetch
): Promise<{ health: Health; detail: string | null }> {
  try {
    await client(apiKey, fetchFn).models.list({ limit: 1 })
    return { health: 'ok', detail: null }
  } catch (err) {
    const { code, message } = toProviderError(err)
    switch (code) {
      case 'auth':
      case 'bad-request':
      case 'not-found':
        return { health: 'invalid', detail: message }
      case 'no-credit':
        return { health: 'no-credit', detail: message }
      case 'rate-limit':
        return { health: 'rate-limited', detail: message }
      default:
        return { health: 'unreachable', detail: message }
    }
  }
}

// A model as Anthropic describes it to this key, for the catalog to merge with
// what Orcha already knows (MODEL_SPECS). Limits are null when not reported.
export interface AnthropicModel {
  id: string
  displayName: string
  maxInput: number | null // max_input_tokens
  maxOutput: number | null // max_tokens
  // Which `thinking` settings it accepts (capabilities.thinking.types).
  thinking: {
    supported: boolean
    adaptive: boolean
    enabled: boolean
    disabled: boolean
    betweenTools: boolean
  } | null
  // The effort levels it accepts, low to high (capabilities.effort).
  efforts: Effort[]
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function modelInfo(m: ModelInfo): AnthropicModel {
  const caps = m.capabilities
  const types = caps?.thinking.types
  const effort = caps?.effort
  return {
    id: m.id,
    displayName: m.display_name,
    maxInput: m.max_input_tokens,
    maxOutput: m.max_tokens,
    thinking:
      caps && types
        ? {
            supported: caps.thinking.supported,
            adaptive: types.adaptive.supported,
            enabled: types.enabled.supported,
            disabled: types.disabled.supported,
            betweenTools: types.between_tools.supported
          }
        : null,
    efforts: EFFORT_LEVELS.filter((level) => effort?.[level]?.supported)
  }
}

// Every model this key can use, newest first. Models the key's organisation
// can't use aren't listed at all.
export async function listModels(
  apiKey: string,
  fetchFn?: typeof fetch
): Promise<AnthropicModel[]> {
  const models: AnthropicModel[] = []
  try {
    for await (const m of client(apiKey, fetchFn).models.list({ limit: 1000 })) {
      models.push(modelInfo(m))
    }
  } catch (err) {
    throw toProviderError(err)
  }
  return models
}
