import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import type { LocalModel, ModelPull, OllamaState } from '../../shared/ai'
import type { ProviderErrorCode } from '../chat/provider'
import { findExecutable } from '../platform-core'

// Ollama on this computer, as Orcha's connection to local models: is it
// running (and starting it when it isn't), what is installed, downloading and
// removing models, and how much context each one is loaded with.
//
// Everything goes from the main process to 127.0.0.1. Ollama turns away
// requests from a window's `file://` origin, and the name "localhost" can
// resolve to ::1 first and stall for seconds, because Ollama listens on IPv4
// only.

export const OLLAMA_URL = 'http://127.0.0.1:11434'

// How long a model stays in memory after its last request. Sent with every
// request so a different OLLAMA_KEEP_ALIVE on the server never changes it.
export const KEEP_ALIVE = '5m'

export const OFFLINE = "Ollama isn't running. Start it, then try again."

const GIB = 1024 ** 3

// ---- context size ----

// Windows lets an integrated GPU use 57% of the computer's memory by default,
// which is the 18 GiB Ollama reports on a 32 GB laptop.
const GPU_SHARE = 0.57
// On top of a model's file: compute buffers, the image projector, and room
// for Windows and the other apps that share the same memory.
const RESERVED_BYTES = 1.5 * GIB
// Qwen3.5 keeps 32 KiB per token: 8 attention layers x 4 KV heads x 256 x 2
// (keys and values) x 2 bytes. Used when a model doesn't say.
const DEFAULT_KV_BYTES = 32 * 1024
// What a model is loaded with when it fits. These models re-read the whole
// conversation every turn (no reuse between turns), so a longer window costs
// minutes of waiting long before it costs memory.
export const TARGET_CONTEXT = 32_768
const MIN_CONTEXT = 4_096

const floorPowerOfTwo = (n: number): number => 2 ** Math.floor(Math.log2(n))

// The context a model is loaded with: the target, held back by the model's
// own limit and by what fits next to its weights, as a power of two. It only
// depends on the model and the computer, never on what else is loaded, so a
// model always gets the same number. Ollama restarts a model's runner
// (5-6 s) whenever num_ctx changes, and two clients with different numbers
// would keep restarting each other's.
export function contextSize(
  model: { sizeBytes: number; kvBytesPerToken: number | null; contextMax: number | null },
  gpuBytes: number
): number {
  const perToken = model.kvBytesPerToken ?? DEFAULT_KV_BYTES
  const fits = Math.max(
    MIN_CONTEXT,
    Math.floor((gpuBytes - model.sizeBytes - RESERVED_BYTES) / perToken)
  )
  const limit = model.contextMax && model.contextMax > 0 ? model.contextMax : TARGET_CONTEXT
  return floorPowerOfTwo(Math.min(TARGET_CONTEXT, limit, fits))
}

// A model's own context limit, from /api/show's model_info.
function contextOf(info: Record<string, unknown> | undefined): number | null {
  const arch = info?.['general.architecture']
  const limit = typeof arch === 'string' ? info?.[`${arch}.context_length`] : null
  return typeof limit === 'number' ? limit : null
}

// Bytes of KV cache per token, worked out from /api/show's model_info:
// keys and values (f16) for every attention layer. Hybrid models list KV
// heads per layer, with none for the layers that don't use attention.
export function kvBytesPerToken(info: Record<string, unknown> | undefined): number | null {
  const arch = info?.['general.architecture']
  if (!info || typeof arch !== 'string') return null
  const num = (key: string): number | null => {
    const value = info[`${arch}.${key}`]
    return typeof value === 'number' ? value : null
  }
  const layers = num('block_count')
  const heads = num('attention.head_count')
  if (!layers || !heads) return null
  const embedding = num('embedding_length')
  const keyLength = num('attention.key_length') ?? (embedding ? embedding / heads : null)
  if (!keyLength) return null
  const valueLength = num('attention.value_length') ?? keyLength
  const perLayer = info[`${arch}.attention.head_count_kv`]
  const kvHeads = Array.isArray(perLayer)
    ? perLayer.reduce((sum: number, n) => sum + (typeof n === 'number' ? n : 0), 0)
    : (typeof perLayer === 'number' ? perLayer : heads) * layers
  return kvHeads * (keyLength + valueLength) * 2
}

// ---- thinking ----

// How a model's thinking is controlled, for LocalModel.think: true for on/off,
// the level names for models that take levels (gpt-oss), false when it can't
// think. /api/show lists the choices from Ollama 0.34.3 on; before that only
// the 'thinking' capability is known, and gpt-oss is the one family with levels.
export function thinkSupport(
  name: string,
  capabilities: string[],
  thinking: { values?: unknown[] } | undefined
): LocalModel['think'] {
  if (!capabilities.includes('thinking')) return false
  const values = thinking?.values
  if (Array.isArray(values)) {
    const levels = values.filter((v): v is string => typeof v === 'string')
    return levels.length > 0 ? levels : values.includes(true)
  }
  return /^gpt-oss/.test(name) ? ['low', 'medium', 'high'] : true
}

// ---- talking to Ollama ----

export const jsonPost = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal
})

// A streamed reply, one JSON object per line. A line can arrive in pieces, so
// the text is held until its newline shows up.
export async function* readNdjson(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (line: string): Record<string, unknown> | null => {
    try {
      return line.trim() ? (JSON.parse(line) as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (line) yield line
    }
  }
  const last = parse(buffer + decoder.decode())
  if (last) yield last
}

// Ollama's error text out of a response body: {"error": "..."}, where a
// runner's own errors arrive as more JSON inside that string.
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | string
    const message = typeof parsed === 'string' ? parsed : parsed.error
    if (typeof message !== 'string') return body.trim()
    if (message.startsWith('{')) {
      try {
        const inner = JSON.parse(message) as { message?: unknown }
        if (typeof inner.message === 'string') return inner.message
      } catch {
        // not JSON after all
      }
    }
    return message
  } catch {
    return body.trim()
  }
}

// A failed request in plain words, and what kind of failure it was. A
// failure that comes mid-stream, after Ollama already said 200, goes through
// here too (pass the status 200).
export function describeFailure(
  status: number,
  body: string,
  model?: string
): { message: string; code: ProviderErrorCode } {
  const text = errorText(body)
  const name = model ? `"${model}"` : 'That model'
  if ((status === 404 && model) || /\bmodel\b.*\bnot found\b/i.test(text)) {
    return {
      code: 'not-found',
      message: `${name} isn't downloaded. Download it from the local models settings, then try again.`
    }
  }
  if (/exceed_context_size|exceeds the available context size/i.test(body)) {
    const window = /n_ctx\W+(\d+)/.exec(body)?.[1]
    return {
      code: 'context-full',
      message: `This conversation is too long for ${name}${window ? ` (it holds ${window} tokens)` : ''}. Start a new chat or shorten it.`
    }
  }
  if (/does not support chat/i.test(text)) {
    return {
      code: 'bad-request',
      message: `${name} can't chat. It was made for something else, like embeddings.`
    }
  }
  if (/does not support tools/i.test(text)) {
    return { code: 'bad-request', message: `${name} can't use tools. Choose a model that can.` }
  }
  if (/does not support thinking/i.test(text)) {
    return {
      code: 'bad-request',
      message: `${name} can't think before answering. Turn Thinking off.`
    }
  }
  if (/more system memory|out of memory|not enough memory|failed to allocate/i.test(text)) {
    return {
      code: 'unknown',
      message: `There isn't enough free memory to load ${name}. Close other apps, or choose a smaller model.`
    }
  }
  if (status === 503) {
    return {
      code: 'overloaded',
      message: 'Ollama is busy with other requests. Try again in a moment.'
    }
  }
  if (status === 401 || status === 403) {
    return {
      code: 'auth',
      message: 'Ollama refused the request. Cloud models need you to sign in to Ollama first.'
    }
  }
  const detail = text || `It answered ${status}.`
  return {
    code: status === 400 ? 'bad-request' : 'unknown',
    message: `Ollama reported a problem: ${detail}`
  }
}

async function failure(res: Response, model?: string): Promise<Error> {
  return new Error(describeFailure(res.status, await res.text().catch(() => ''), model).message)
}

// A download that failed, in plain words.
function pullFailure(text: string, name: string): string {
  if (/file does not exist|manifest.*not found/i.test(text)) {
    return `Ollama has no model called "${name}". Check the name and try again.`
  }
  if (/no space left|not enough .*space|disk is full/i.test(text)) {
    return "There isn't enough free disk space for this model."
  }
  if (/dial tcp|no such host|timeout|connection (refused|reset)|unreachable/i.test(text)) {
    return "Ollama couldn't reach its download server. Check your internet connection and try again."
  }
  return describeFailure(200, text, name).message
}

// Where OLLAMA_HOST points, if it is set, the way Ollama itself reads it
// ("host", "host:port", ":port", "http://host:port"). A listen-everywhere
// address (0.0.0.0, ::) or "localhost" means this computer's 127.0.0.1.
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.OLLAMA_HOST?.trim()
  if (!set) return OLLAMA_URL
  const m = /^(?:(https?):\/\/)?(\[[^\]]*\]|[^:/]*)(?::(\d+))?/i.exec(set)
  if (!m) return OLLAMA_URL
  const scheme = (m[1] ?? 'http').toLowerCase()
  const port = m[3] ?? (m[1] ? (scheme === 'https' ? '443' : '80') : '11434')
  const here = ['', '0.0.0.0', '[::]', 'localhost']
  return `${scheme}://${here.includes(m[2].toLowerCase()) ? '127.0.0.1' : m[2]}:${port}`
}

// ---- finding and starting Ollama ----

export interface Launch {
  file: string
  args: string[]
}

// How to start Ollama, or null when it isn't installed: `ollama serve` from
// the installer's folder in %LOCALAPPDATA%, else from the PATH. The tray app
// (ollama app.exe) is left alone on purpose: its start-up flags are not
// documented and this version's binary doesn't contain the ones that would
// keep it hidden, whereas `serve` has no window of its own to hide.
export function locateOllama(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync
): Launch | null {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  const installed = env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe)
  if (installed && exists(installed)) return { file: installed, args: ['serve'] }
  const cli = findExecutable(exe, env.PATH)
  return cli ? { file: cli, args: ['serve'] } : null
}

// child_process.spawn, as far as starting Ollama needs it.
type Spawn = (
  file: string,
  args: string[],
  options: SpawnOptions
) => { on(event: 'error', listener: (err: Error) => void): unknown; unref(): unknown }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---- what Ollama says about models ----

interface TagModel {
  name: string
  size: number
  digest: string
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
    context_length?: number
  }
  capabilities?: string[]
  // Cloud models run on Ollama's servers, not on this computer.
  remote_model?: string
  remote_host?: string
}

interface ShowResponse {
  capabilities?: string[]
  thinking?: { values?: unknown[] }
  model_info?: Record<string, unknown>
}

interface PsModel {
  name: string
  size: number
  size_vram: number
  context_length?: number
  expires_at?: string
}

// What is remembered about an installed model: enough for the list, and for
// contextFor() to answer without asking Ollama again.
interface ModelFacts {
  digest: string
  shown: boolean // /api/show answered; if not, the next listing asks again
  sizeBytes: number
  capabilities: string[]
  think: LocalModel['think']
  contextMax: number | null
  kvBytesPerToken: number | null
}

const isLocal = (m: TagModel): boolean =>
  !m.remote_host && !m.remote_model && !/[:-]cloud$/i.test(m.name)

export interface OllamaStatus {
  status: OllamaState['status']
  version: string | null
}

export interface LoadedModel {
  name: string
  sizeBytes: number
  vramBytes: number
  context: number // the num_ctx it was loaded with
  expiresAt: number | null // ms epoch; when it will be unloaded
}

export interface OllamaManagerOptions {
  baseURL?: string // default: OLLAMA_HOST, else http://127.0.0.1:11434
  fetch?: typeof fetch
  spawn?: Spawn
  locate?: () => Launch | null
  totalMemory?: () => number
  statusTimeoutMs?: number // 1500
  startTimeoutMs?: number // 20000
  pollMs?: number // 250
}

export class OllamaManager {
  readonly baseURL: string
  private fetchFn: typeof fetch
  private spawnFn: Spawn
  private locate: () => Launch | null
  private totalMemory: () => number
  private statusTimeoutMs: number
  private startTimeoutMs: number
  private pollMs: number
  private starting: Promise<void> | null = null
  private facts = new Map<string, ModelFacts>()

  constructor(opts: OllamaManagerOptions = {}) {
    this.baseURL = opts.baseURL ?? ollamaBaseUrl()
    this.fetchFn = opts.fetch ?? fetch
    this.spawnFn = opts.spawn ?? spawn
    this.locate = opts.locate ?? locateOllama
    this.totalMemory = opts.totalMemory ?? totalmem
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 1500
    this.startTimeoutMs = opts.startTimeoutMs ?? 20_000
    this.pollMs = opts.pollMs ?? 250
  }

  // Whether Ollama answers, and if it doesn't, whether it is being started or
  // is installed at all.
  async status(): Promise<OllamaStatus> {
    const version = await this.version()
    if (version) return { status: 'running', version }
    if (this.starting) return { status: 'starting', version: null }
    return { status: this.locate() ? 'stopped' : 'missing', version: null }
  }

  // Starts Ollama, out of sight, if it is installed but not running, and
  // waits until it answers. Asking again while it starts joins the same wait.
  ensureRunning(): Promise<void> {
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  // Everything installed on this computer (cloud models aside), with what each
  // can do. Asking Ollama about a model's details is done once per version of
  // it; the rest is one /api/tags and one /api/ps.
  async listModels(): Promise<LocalModel[]> {
    const [tags, running] = await Promise.all([
      this.json<{ models?: TagModel[] }>('/api/tags'),
      this.loaded().catch((): LoadedModel[] => [])
    ])
    const installed = (tags.models ?? []).filter(isLocal)
    const facts = await Promise.all(installed.map((m) => this.learn(m)))
    return installed.map((m, i) => ({
      name: m.name,
      sizeBytes: m.size,
      family: m.details?.family ?? null,
      parameters: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      capabilities: facts[i].capabilities,
      think: facts[i].think,
      contextMax: facts[i].contextMax,
      context: this.contextFor(m.name),
      loaded: running.some((r) => r.name === m.name)
    }))
  }

  // The models in memory right now, whoever loaded them.
  async loaded(): Promise<LoadedModel[]> {
    const body = await this.json<{ models?: PsModel[] }>('/api/ps')
    return (body.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      vramBytes: m.size_vram,
      context: m.context_length ?? 0,
      expiresAt: (m.expires_at && Date.parse(m.expires_at)) || null
    }))
  }

  // Loads a model ahead of its first message, with the same context a chat
  // would use (a different one would make that chat load it all over again).
  async load(name: string): Promise<void> {
    await this.json(
      '/api/chat',
      jsonPost({
        model: name,
        messages: [],
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: this.contextFor(name) }
      }),
      name
    )
  }

  // Takes a model out of memory now instead of at the end of its keep-alive.
  async unload(name: string): Promise<void> {
    await this.json('/api/generate', jsonPost({ model: name, stream: false, keep_alive: 0 }), name)
  }

  // Deletes a model from disk. One that is already gone counts as deleted.
  async remove(name: string): Promise<void> {
    const res = await this.call('/api/delete', { ...jsonPost({ model: name }), method: 'DELETE' })
    this.facts.delete(name)
    if (!res.ok && res.status !== 404) throw await failure(res, name)
  }

  // Downloads a model, reporting progress as one bar across all the layers
  // Ollama fetches in parallel. Cancelling with `signal` throws its abort
  // error and keeps the partial download, which the next pull picks up. Any
  // other failure is reported once more with `error` set, then thrown.
  async pull(
    name: string,
    onProgress: (progress: ModelPull) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const layers = new Map<string, { total: number; completed: number }>()
    const report = (status: string, error: string | null = null): void => {
      let total = 0
      let completed = 0
      for (const layer of layers.values()) {
        total += layer.total
        completed += layer.completed
      }
      onProgress({ name, status, completed, total, error })
    }
    try {
      const res = await this.call('/api/pull', jsonPost({ model: name, stream: true }, signal))
      if (!res.ok || !res.body) throw await failure(res, name)
      let finished = false
      for await (const line of readNdjson(res.body)) {
        // A download that fails says so in a line of its own, after the 200.
        if (typeof line.error === 'string') throw new Error(pullFailure(line.error, name))
        const status = String(line.status ?? '')
        if (typeof line.digest === 'string') {
          const layer = layers.get(line.digest) ?? { total: 0, completed: 0 }
          if (typeof line.total === 'number') layer.total = line.total
          if (typeof line.completed === 'number') layer.completed = line.completed
          layers.set(line.digest, layer)
          report('downloading')
        } else {
          report(status)
          if (status === 'success') finished = true
        }
      }
      if (!finished) {
        throw new Error('The download stopped early. Start it again to carry on where it left off.')
      }
    } catch (err) {
      if (signal?.aborted) throw err
      report('failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // The context to load a model with (see contextSize). It is sized from what
  // listModels() learned, so call that once at startup, before the first
  // chat; a model it hasn't seen gets the target.
  contextFor = (model: string): number => {
    const known = this.facts.get(model)
    return known ? contextSize(known, this.totalMemory() * GPU_SHARE) : TARGET_CONTEXT
  }

  private async version(): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseURL}/api/version`, {
        signal: AbortSignal.timeout(this.statusTimeoutMs)
      })
      const body = (await res.json()) as { version?: unknown }
      return res.ok && typeof body.version === 'string' ? body.version : null
    } catch {
      return null
    }
  }

  private async start(): Promise<void> {
    if (await this.version()) return
    const launch = this.locate()
    if (!launch) {
      throw new Error(
        "Ollama isn't installed on this computer. Install it from ollama.com, then try again."
      )
    }
    // Detached and with no window or console, so it lives on after Orcha
    // closes and never flashes a terminal.
    const launched: { error: Error | null } = { error: null }
    try {
      const child = this.spawnFn(launch.file, launch.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.on('error', (err) => (launched.error = err))
      child.unref()
    } catch (err) {
      launched.error = err instanceof Error ? err : new Error(String(err))
    }
    const deadline = Date.now() + this.startTimeoutMs
    while (!launched.error && Date.now() < deadline) {
      await sleep(this.pollMs)
      if (await this.version()) return
    }
    throw new Error(
      launched.error
        ? `Ollama couldn't be started: ${launched.error.message}`
        : `Ollama didn't start within ${Math.round(this.startTimeoutMs / 1000)} seconds. Open it from the Start menu, then try again.`
    )
  }

  // What a model can do, asking Ollama only when it is new or has changed.
  private async learn(model: TagModel): Promise<ModelFacts> {
    const known = this.facts.get(model.name)
    if (known?.shown && known.digest === model.digest) return known
    let show: ShowResponse | null = null
    try {
      show = await this.json<ShowResponse>('/api/show', jsonPost({ model: model.name }))
    } catch {
      // The list still works from /api/tags alone.
    }
    const capabilities = show?.capabilities ?? model.capabilities ?? []
    const facts: ModelFacts = {
      digest: model.digest,
      shown: show !== null,
      sizeBytes: model.size,
      capabilities,
      think: thinkSupport(model.name, capabilities, show?.thinking),
      contextMax: model.details?.context_length ?? contextOf(show?.model_info),
      kvBytesPerToken: kvBytesPerToken(show?.model_info)
    }
    this.facts.set(model.name, facts)
    return facts
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(this.baseURL + path, init)
    } catch (err) {
      if (init?.signal?.aborted) throw err
      throw new Error(OFFLINE)
    }
  }

  private async json<T>(path: string, init?: RequestInit, model?: string): Promise<T> {
    const res = await this.call(path, init)
    if (!res.ok) throw await failure(res, model)
    return (await res.json()) as T
  }
}
