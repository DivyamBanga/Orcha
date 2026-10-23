import { MODEL_SPECS, specFor, type ModelSpec, type Reasoning } from '../../shared/models'
import type { ChatModel, Connections, Route } from '../../shared/ai'
import { localChatModel } from '../chat/providers/ollama'

// Every model the picker offers, from every connection: Claude on the Max
// plan, Claude on API keys, the enabled chat deployments on Azure, and the
// local models Ollama has. Built from the connection state plus what the
// providers reported (Anthropic's model list); MODEL_SPECS fills in the
// rules the APIs don't report.

// A model Anthropic's Models API lists.
export interface ListedModel {
  id: string
  displayName: string
  maxInput: number | null
  maxOutput: number | null
}

const NO_REASONING: Reasoning = { levels: [], defaultLevel: null, off: null }

function fromSpec(route: Route, apiModel: string, spec: ModelSpec, ready: boolean): ChatModel {
  return {
    id: `${route}:${apiModel}`,
    route,
    apiModel,
    label: spec.label,
    description: spec.description,
    spec: spec.id,
    current: spec.current,
    context: spec.context,
    maxOutput: spec.maxOutput,
    vision: spec.vision,
    pdf: spec.pdf,
    tools: true,
    reasoning: spec.reasoning,
    sampling: spec.sampling,
    verbosity: spec.verbosity,
    webSearch: spec.webSearch !== null,
    retains30d: spec.retains30d ?? false,
    // The Max plan has no per-token price; usage is shown against its limits.
    price: route === 'plan' ? null : spec.price,
    ready
  }
}

const claudeSpecs = MODEL_SPECS.filter((m) => m.family === 'claude' && !m.deprecated)

// Claude Code on the Max plan takes the same model ids as the API.
function planModels(c: Connections): ChatModel[] {
  return claudeSpecs.map((spec) => fromSpec('plan', spec.id, spec, c.plan.signedIn))
}

// The models the keys can reach: Anthropic's own list when it's been fetched
// (so a model released after this build still shows up), else the known ones.
function apiModels(c: Connections, listed: ListedModel[] | null): ChatModel[] {
  if (c.keys.length === 0) return []
  const ready = c.keys.some((k) => k.health === 'ok' || k.health === 'unchecked')
  if (!listed) return claudeSpecs.map((spec) => fromSpec('api', spec.id, spec, ready))
  return listed.map((m) => {
    const spec = specFor(m.id)
    if (spec) return fromSpec('api', m.id, spec, ready)
    // Newer than this build: assume the current generation's rules.
    const like = specFor('claude-sonnet-5-5')!
    return {
      ...fromSpec('api', m.id, like, ready),
      label: m.displayName,
      description: 'New Claude model',
      spec: null,
      current: false,
      context: m.maxInput ?? like.context,
      maxOutput: m.maxOutput ?? like.maxOutput,
      price: null
    }
  })
}

function azureModels(c: Connections): ChatModel[] {
  const azure = c.azure
  if (!azure) return []
  const ready = azure.health === 'ok' || azure.health === 'unchecked'
  return azure.deployments
    .filter((d) => d.kind === 'chat' && d.enabled)
    .map((d) => {
      const spec = specFor(d.model ?? d.name)
      if (spec) {
        const model = fromSpec('azure', d.name, spec, ready)
        // A deployment named differently from its model says which it is.
        return d.name === spec.id ? model : { ...model, label: `${spec.label} (${d.name})` }
      }
      return {
        id: `azure:${d.name}`,
        route: 'azure' as const,
        apiModel: d.name,
        label: d.name,
        description: 'Azure deployment',
        spec: null,
        current: false,
        context: 128_000,
        maxOutput: 16_384,
        vision: false,
        pdf: false,
        tools: true,
        reasoning: NO_REASONING,
        sampling: 'always' as const,
        verbosity: false,
        webSearch: false,
        retains30d: false,
        price: null,
        ready
      }
    })
}

// The Ollama provider describes its own models (thinking switch or levels,
// output cap), so the picker and the requests agree.
function localModels(c: Connections): ChatModel[] {
  const ready = c.ollama.status === 'running'
  return c.ollama.models
    .filter((m) => m.capabilities.includes('completion'))
    .map((m) => localChatModel(m, ready))
}

export function buildCatalog(c: Connections, listed: ListedModel[] | null): ChatModel[] {
  return [...planModels(c), ...apiModels(c, listed), ...azureModels(c), ...localModels(c)]
}
