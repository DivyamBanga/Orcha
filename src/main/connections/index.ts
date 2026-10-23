import { safeStorage } from 'electron'
import { database } from '../db'
import { planState } from '../planUsage'
import { createVault, type Cipher } from '../vault'
import { createConnections, type ConnectionStore } from './store'
import { buildCatalog, type ListedModel } from './catalog'
import { listModels, testKey } from './anthropicKeys'
import { KNOWN_DEPLOYMENTS, normalizeEndpoint, probeDeployments, testConnection } from './azure'
import { OllamaManager } from './ollama'
import { e2eEndpoint, e2eFetch } from '../e2e'
import type { ChatModel, Connections, ModelPull, OllamaState } from '../../shared/ai'

// The owner's connections as the running app uses them: keys kept by the OS
// keychain, the Anthropic keys, Azure, Ollama and the Max plan, and the model
// list built from all of them. Settings → Models & keys changes them; the
// chat reads them for every turn.

// Electron's keychain through its async API (the sync one goes in Electron 46).
const keychain: Cipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  async decrypt(blob) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(blob)
    return { plain: result, stale: shouldReEncrypt }
  }
}

let store: ConnectionStore
let ollama: OllamaManager
// Ollama is asked over the network, and the model list is built often, so
// what it last said is kept here and refreshed when something changes.
let local: OllamaState
const pulls = new Map<string, { progress: ModelPull; abort: AbortController }>()
// Anthropic's own list of the models the default key reaches (null until
// fetched, or when it can't be).
let listed: ListedModel[] | null = null
let changed: () => void = () => {}

// Under the end-to-end tests these calls go to a fake server (see e2e.ts).
const ANTHROPIC = 'https://api.anthropic.com'
const anthropicFetch = (): typeof fetch => e2eFetch('anthropic', ANTHROPIC)

// After initDb. `onChange` tells the window the models or connections changed.
export function initConnections(onChange: () => void): void {
  changed = onChange
  ollama = new OllamaManager({ baseURL: e2eEndpoint('ollama') ?? undefined })
  local = { baseUrl: ollama.baseURL, status: 'stopped', version: null, models: [], pulls: [] }
  store = createConnections({
    db: database(),
    vault: createVault(database(), keychain),
    testAnthropicKey: (key) => testKey(key, anthropicFetch()),
    normalizeAzureEndpoint: (input) => {
      const endpoint = normalizeEndpoint(input)
      if (!endpoint)
        throw new Error(
          "That isn't an Azure address. It looks like https://<name>.openai.azure.com."
        )
      return endpoint
    },
    testAzure: (endpoint, key) => testConnection(endpoint, key, e2eFetch('azure', endpoint)),
    probeAzure: (endpoint, key) =>
      probeDeployments(
        endpoint,
        key,
        Object.values(KNOWN_DEPLOYMENTS).flat(),
        e2eFetch('azure', endpoint)
      ),
    plan: planState,
    ollama: () => ({ ...local, pulls: [...pulls.values()].map((p) => p.progress) })
  })
  void refreshOllama()
  void refreshListed()
}

export function connections(): ConnectionStore {
  return store
}

export function ollamaManager(): OllamaManager {
  return ollama
}

export function connectionState(): Connections {
  return store.list()
}

export function models(): ChatModel[] {
  return buildCatalog(store.list(), listed)
}

// Whatever changed a connection calls this, so the picker and Settings follow.
export function connectionsChanged(): void {
  changed()
}

// What Ollama has and whether it's up. Cheap when it isn't running (one
// request that fails fast).
export async function refreshOllama(): Promise<OllamaState> {
  const { status, version } = await ollama.status()
  const models = status === 'running' ? await ollama.listModels().catch(() => local.models) : []
  local = { ...local, status, version, models }
  changed()
  return store.list().ollama
}

// Anthropic's model list, with the default key, so a model newer than this
// build shows up too. Without a key, or when the list can't be had, the
// models Orcha knows stand in.
export async function refreshListed(): Promise<void> {
  const key = await store.keyFor(null).catch(() => null)
  listed = key ? await listModels(key.key, anthropicFetch()).catch(() => null) : null
  changed()
}

// Downloads a local model; progress shows in Settings as it goes.
export async function pullModel(name: string): Promise<void> {
  if (pulls.has(name)) return
  const abort = new AbortController()
  const entry = {
    progress: { name, status: 'starting', completed: 0, total: 0, error: null } as ModelPull,
    abort
  }
  pulls.set(name, entry)
  changed()
  // Progress arrives many times a second; the window hears about it at most
  // a few times a second.
  let last = 0
  try {
    await ollama.pull(
      name,
      (progress) => {
        entry.progress = progress
        if (Date.now() - last > 250) {
          last = Date.now()
          changed()
        }
      },
      abort.signal
    )
    pulls.delete(name)
  } catch (err) {
    // A cancel just goes away; a failure stays on screen until dismissed.
    if (abort.signal.aborted) pulls.delete(name)
    else
      entry.progress = {
        ...entry.progress,
        error: err instanceof Error ? err.message : String(err)
      }
  }
  await refreshOllama()
}

// Stops a download, or clears one that failed.
export function cancelPull(name: string): void {
  pulls.get(name)?.abort.abort()
  pulls.delete(name)
  changed()
}
