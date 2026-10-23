import type { AzureDeployment, DeploymentKind, Health } from '../../shared/ai'
import { MODEL_SPECS, specFor } from '../../shared/models'
import { ProviderError } from '../chat/provider'

// The Azure AI Foundry connection: checking an endpoint and key, and finding out
// which models the resource has deployed. Nothing here touches Electron, so it
// runs (and is tested) in plain Node; the network is a parameter.

type ProbeKind = Exclude<DeploymentKind, 'other'>

// What a new Azure resource calls its deployments: the portal's default name is
// the model's own name. These are the names tried when finding out what exists.
export const KNOWN_DEPLOYMENTS: Record<ProbeKind, string[]> = {
  chat: MODEL_SPECS.filter((m) => m.family === 'gpt').map((m) => m.id),
  image: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'],
  embedding: ['text-embedding-3-large', 'text-embedding-3-small'],
  transcription: ['gpt-transcribe']
}

const KIND_OF = new Map<string, ProbeKind>(
  (Object.keys(KNOWN_DEPLOYMENTS) as ProbeKind[]).flatMap((kind) =>
    KNOWN_DEPLOYMENTS[kind].map((name): [string, ProbeKind] => [name.toLowerCase(), kind])
  )
)

// A name Orcha doesn't know is taken to be a chat model.
const kindOf = (name: string): ProbeKind => KIND_OF.get(name.toLowerCase()) ?? 'chat'

// ---- the address ----

// A resource answers on several hostnames (the Azure OpenAI one, the Foundry one,
// the older Foundry Tools one), in the public cloud and the government and China
// clouds. The key is only ever sent to one of them.
const AZURE_HOST = /\.(?:openai|services\.ai|cognitiveservices)\.azure\.(?:com|us|cn)$/i

// The address as the app keeps it: https://<resource>.openai.azure.com, whatever
// was pasted. Everything after the host is dropped (the portal hands out
// .../openai/v1, .../openai/v1/responses, deployment URLs, project URLs), and the
// host is kept as given. Null when it isn't an Azure address.
export function normalizeEndpoint(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  // A key never goes over plain http, or to a host that isn't Azure's.
  if (url.protocol !== 'https:' || !AZURE_HOST.test(url.hostname)) return null
  return url.origin
}

// ---- the network ----

const TIMEOUT_MS = 10_000

// One request, which gives up after ten seconds. Only the status is wanted: null
// when there was none (no network, or too slow).
async function statusOf(
  send: typeof fetch,
  url: string,
  init: RequestInit
): Promise<number | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const res = await send(url, { ...init, signal: abort.signal })
    await res.body?.cancel().catch(() => {}) // let the connection go
    return res.status
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Whether the endpoint and key work, from the cheapest call there is: the list of
// models. (Microsoft doesn't say whether that list is the deployments or Azure's
// whole catalog; it doesn't matter here, only whether Azure accepts the key.)
export async function testConnection(
  endpoint: string,
  key: string,
  fetchFn: typeof fetch = fetch
): Promise<{ health: Health; detail: string | null }> {
  const status = await statusOf(fetchFn, `${endpoint.replace(/\/+$/, '')}/openai/v1/models`, {
    headers: { 'api-key': key }
  })
  if (status === null) {
    return {
      health: 'unreachable',
      detail: "Couldn't reach Azure. Check the address and your internet connection."
    }
  }
  if (status >= 200 && status < 300) return { health: 'ok', detail: null }
  if (status === 401) {
    return {
      health: 'invalid',
      detail:
        "Azure didn't accept that key. Copy it again from the Azure portal (Keys and Endpoint)."
    }
  }
  if (status === 403) {
    return {
      health: 'invalid',
      detail:
        'Azure refused the key. It may belong to a different resource, or the resource may only allow certain networks.'
    }
  }
  if (status === 404) {
    return {
      health: 'invalid',
      detail:
        "That address doesn't answer like an Azure OpenAI endpoint. It should look like https://your-resource.openai.azure.com."
    }
  }
  if (status === 429) {
    return {
      health: 'rate-limited',
      detail:
        'Azure is limiting requests right now, so the key could not be checked. Try again in a moment.'
    }
  }
  return {
    health: status >= 500 ? 'unreachable' : 'invalid',
    detail:
      status >= 500
        ? `Azure had a problem (error ${status}). Try again shortly.`
        : `Azure answered with an unexpected error (${status}).`
  }
}

// ---- finding the deployments ----

// Azure has no list a key can read (only the management API, which wants a
// sign-in), so the names Orcha knows are tried one at a time. A request names its
// deployment in the `model` field, and Azure answers 404 when there is none.
//
// To try a name for free, the request is one that can't succeed: it leaves out
// something required (the input, the prompt, the audio file), or asks for an
// output length below the floor, so it is refused as invalid and never billed.
//
// ASSUMPTION, which can't be checked without a live resource: Azure finds the
// deployment before it looks closely at the rest of the request, so an invalid
// request gets 404 for a name that isn't deployed and 400 for one that is. If
// Azure instead rejected the bad request first, every name would answer 400 and
// the free request would call everything deployed. So each kind is checked
// against a name that cannot exist first (a "control"): 404 means the assumption
// holds on this resource. If not, the kind falls back to the smallest real request
// (a few tokens, a fraction of a cent) and is checked against the control again.
// Images have no such request, as even the smallest costs real money, so when the
// free one can't tell, no image deployment is reported; adding one by hand works.
interface Req {
  body: string | FormData
  json: boolean
}

const json = (body: object): Req => ({ body: JSON.stringify(body), json: true })

const form = (model: string, file?: Blob): Req => {
  const body = new FormData()
  body.set('model', model)
  if (file) body.set('file', file, 'probe.wav')
  return { body, json: false }
}

// Tenth of a second of silence: the smallest audio worth sending.
function silence(): Blob {
  const rate = 8000
  const bytes = (rate / 10) * 2 // 16-bit mono
  const head = new DataView(new ArrayBuffer(44))
  const tag = (at: number, text: string): void =>
    [...text].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  head.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVEfmt ')
  head.setUint32(16, 16, true)
  head.setUint16(20, 1, true) // PCM
  head.setUint16(22, 1, true) // mono
  head.setUint32(24, rate, true)
  head.setUint32(28, rate * 2, true)
  head.setUint16(32, 2, true)
  head.setUint16(34, 16, true)
  tag(36, 'data')
  head.setUint32(40, bytes, true)
  return new Blob([head, new Uint8Array(bytes)], { type: 'audio/wav' })
}

const PROBES: Record<
  ProbeKind,
  { path: string; free: (model: string) => Req; real: ((model: string) => Req) | null }
> = {
  chat: {
    path: '/openai/v1/responses',
    // Azure is reported to refuse a max_output_tokens below 16 as invalid ("integer
    // below minimum value"). Where it doesn't, this is a one-token request.
    free: (model) => json({ model, input: 'ping', max_output_tokens: 1, store: false }),
    real: (model) => json({ model, input: 'ping', max_output_tokens: 16, store: false })
  },
  embedding: {
    path: '/openai/v1/embeddings',
    free: (model) => json({ model }), // no input
    real: (model) => json({ model, input: 'ping' })
  },
  image: {
    path: '/openai/v1/images/generations?api-version=preview',
    free: (model) => json({ model }), // no prompt
    real: null
  },
  transcription: {
    path: '/openai/v1/audio/transcriptions?api-version=preview',
    free: (model) => form(model), // no audio file
    real: (model) => form(model, silence())
  }
}

// How many names are tried at once.
const PROBE_PARALLEL = 4

// A name that is not a deployment, to check what a missing one looks like.
const CONTROL = 'orcha-probe-nothing-deployed-here'

// Which of these names are deployed on the resource? Names Orcha doesn't know are
// tried as chat models. A name that couldn't be told (too slow, Azure failing, or
// a kind that can't be checked safely) is left out. Throws if Azure refuses the key.
export async function probeDeployments(
  endpoint: string,
  key: string,
  names: string[],
  fetchFn: typeof fetch = fetch
): Promise<AzureDeployment[]> {
  const base = endpoint.replace(/\/+$/, '')
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))]

  const ask = (kind: ProbeKind, req: Req): Promise<number | null> =>
    statusOf(fetchFn, base + PROBES[kind].path, {
      method: 'POST',
      headers: { 'api-key': key, ...(req.json ? { 'content-type': 'application/json' } : {}) },
      body: req.body
    })

  // For each kind, the request that tells a missing name from a deployed one
  // (null: none does).
  const ways = new Map<ProbeKind, ((model: string) => Req) | null>()
  const refused = new Map<ProbeKind, number>()
  const kinds = [...new Set(unique.map(kindOf))]
  await Promise.all(
    kinds.map(async (kind) => {
      ways.set(kind, null)
      for (const make of [PROBES[kind].free, PROBES[kind].real]) {
        if (!make) continue
        const status = await ask(kind, make(CONTROL))
        if (status === 401 || status === 403) {
          refused.set(kind, status)
          return
        }
        if (status === 404) {
          ways.set(kind, make)
          return
        }
      }
    })
  )
  // One route refusing is that route's business (a preview feature that isn't
  // switched on); the key is refused when none will have it.
  if (kinds.length > 0 && refused.size === kinds.length) {
    throw new ProviderError(
      [...refused.values()].includes(401)
        ? "Azure didn't accept the API key. Check it in Settings, under Connections."
        : 'Azure refused this request. The key may belong to a different resource, or the resource may only allow certain networks.',
      'auth',
      null,
      [...refused.values()][0]
    )
  }

  const deployed = await inParallel(unique, PROBE_PARALLEL, async (name) => {
    const kind = kindOf(name)
    const make = ways.get(kind)
    if (!make) return false
    const status = await ask(kind, make(name))
    // Refused as invalid, or accepted: there is a deployment to answer. Not found
    // is not; anything else (slow, failing, throttled) is no answer, so it's left out.
    return status !== null && ((status >= 200 && status < 300) || status === 400)
  })
  return unique
    .filter((_, i) => deployed[i])
    .map((name): AzureDeployment => {
      const kind = kindOf(name)
      return {
        name,
        model: kind === 'chat' ? (specFor(name)?.id ?? null) : name,
        kind,
        enabled: true,
        source: 'probe'
      }
    })
}

// Runs the work over the items, a few at a time, and gives the answers in order.
async function inParallel<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
