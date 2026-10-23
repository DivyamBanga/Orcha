import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { keyHint, type Vault } from '../vault'
import type {
  ApiKey,
  AzureConnection,
  AzureDeployment,
  Connections,
  Health,
  OllamaState,
  PlanState
} from '../../shared/ai'

// The owner's connections: Anthropic API keys (several, one the default),
// one Azure AI Foundry resource and its deployments, and where Ollama
// listens. Secrets live in the vault; this keeps everything else. The checks
// that talk to providers are passed in, so this runs without Electron.

export const CONNECTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS api_keys (
    id                 TEXT PRIMARY KEY,
    label              TEXT NOT NULL,
    hint               TEXT NOT NULL,
    is_default         INTEGER NOT NULL DEFAULT 0,
    monthly_budget_usd REAL,
    health             TEXT NOT NULL DEFAULT 'unchecked',
    detail             TEXT,
    checked_at         INTEGER,
    created_at         INTEGER NOT NULL
  );
`

const AZURE_KEY = 'connections:azure'
const OLLAMA_KEY = 'connections:ollama'
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434'

export interface Checked {
  health: Health
  detail: string | null
}

export interface ConnectionDeps {
  db: Database.Database
  vault: Vault
  testAnthropicKey: (key: string) => Promise<Checked>
  normalizeAzureEndpoint: (input: string) => string
  testAzure: (endpoint: string, key: string) => Promise<Checked>
  probeAzure: (endpoint: string, key: string) => Promise<AzureDeployment[]>
  plan: () => PlanState
  ollama: () => OllamaState
}

interface KeyRow {
  id: string
  label: string
  hint: string
  is_default: number
  monthly_budget_usd: number | null
  health: string
  detail: string | null
  checked_at: number | null
  created_at: number
}

const toKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  label: r.label,
  hint: r.hint,
  isDefault: r.is_default === 1,
  monthlyBudgetUsd: r.monthly_budget_usd,
  health: r.health as Health,
  detail: r.detail,
  checkedAt: r.checked_at,
  createdAt: r.created_at
})

const secretOf = (keyId: string): string => `anthropic:${keyId}`

export interface ConnectionStore {
  list(): Connections
  addKey(label: string, key: string): Promise<ApiKey>
  removeKey(id: string): void
  setDefaultKey(id: string): void
  updateKey(id: string, fields: { label?: string; monthlyBudgetUsd?: number | null }): void
  checkKey(id: string): Promise<ApiKey | null>
  noteKeyHealth(id: string, checked: Checked): void
  keyFor(keyId: string | null): Promise<{ id: string; key: string } | null>
  setAzure(endpoint: string, key: string): Promise<AzureConnection>
  reprobeAzure(): Promise<AzureConnection | null>
  removeAzure(): void
  setDeployment(name: string, patch: Partial<Omit<AzureDeployment, 'name'>>): void
  removeDeployment(name: string): void
  setAzureBudget(monthlyBudgetUsd: number | null): void
  noteAzureHealth(checked: Checked): void
  azureCredentials(): Promise<{ endpoint: string; key: string } | null>
  ollamaUrl(): string
  setOllamaUrl(url: string | null): void
}

export function createConnections(deps: ConnectionDeps): ConnectionStore {
  const { db, vault } = deps

  const state = (key: string): string | undefined =>
    (
      db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value
  const setState = (key: string, value: string | null): void => {
    if (value === null) db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
    else
      db.prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value)
  }

  const keys = (): ApiKey[] =>
    (db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as KeyRow[]).map(toKey)

  const azure = (): AzureConnection | null => {
    const raw = state(AZURE_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as AzureConnection
    } catch {
      return null
    }
  }
  const saveAzure = (next: AzureConnection | null): void =>
    setState(AZURE_KEY, next ? JSON.stringify(next) : null)

  const markKey = (id: string, checked: Checked): void => {
    db.prepare('UPDATE api_keys SET health = ?, detail = ?, checked_at = ? WHERE id = ?').run(
      checked.health,
      checked.detail,
      Date.now(),
      id
    )
  }

  const setAzure = async (endpointInput: string, key: string): Promise<AzureConnection> => {
    const endpoint = deps.normalizeAzureEndpoint(endpointInput)
    const value = key.trim()
    const checked = await deps.testAzure(endpoint, value)
    if (checked.health === 'invalid' || checked.health === 'unreachable') {
      throw new Error(checked.detail ?? "Azure didn't accept that endpoint and key.")
    }
    await vault.put('azure', value)
    const previous = azure()
    const before = new Map((previous?.deployments ?? []).map((d) => [d.name, d]))
    // A re-probe keeps what the owner chose for deployments it finds again
    // (hidden from the picker, mapped to a model), and keeps ones added by hand.
    const found = (await deps.probeAzure(endpoint, value)).map((d) => {
      const old = before.get(d.name)
      return old ? { ...d, enabled: old.enabled, model: old.model ?? d.model } : d
    })
    const manual = (previous?.deployments ?? []).filter(
      (d) => d.source === 'manual' && !found.some((f) => f.name === d.name)
    )
    const next: AzureConnection = {
      endpoint,
      hint: keyHint(value),
      deployments: [...found, ...manual],
      monthlyBudgetUsd: previous?.monthlyBudgetUsd ?? null,
      health: checked.health,
      detail: checked.detail,
      checkedAt: Date.now()
    }
    saveAzure(next)
    return next
  }

  return {
    list(): Connections {
      return { plan: deps.plan(), keys: keys(), azure: azure(), ollama: deps.ollama() }
    },

    // ---- Anthropic API keys ----

    // Checks a pasted key before keeping it; the first key becomes the default.
    async addKey(label: string, key: string): Promise<ApiKey> {
      const value = key.trim()
      if (!/^sk-ant-/.test(value)) throw new Error("That doesn't look like an Anthropic API key.")
      const checked = await deps.testAnthropicKey(value)
      if (checked.health === 'invalid') {
        throw new Error(checked.detail ?? 'Anthropic refused that key.')
      }
      const id = randomUUID()
      await vault.put(secretOf(id), value)
      const first = keys().length === 0
      db.prepare(
        `INSERT INTO api_keys (id, label, hint, is_default, health, detail, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        label.trim().slice(0, 40) || 'API key',
        keyHint(value),
        first ? 1 : 0,
        checked.health,
        checked.detail,
        Date.now(),
        Date.now()
      )
      return keys().find((k) => k.id === id)!
    },

    removeKey(id: string): void {
      const wasDefault = keys().find((k) => k.id === id)?.isDefault
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
      vault.remove(secretOf(id))
      // Someone has to be the default while any key is left.
      const next = keys()[0]
      if (wasDefault && next) {
        db.prepare('UPDATE api_keys SET is_default = 1 WHERE id = ?').run(next.id)
      }
    },

    setDefaultKey(id: string): void {
      db.transaction(() => {
        db.prepare('UPDATE api_keys SET is_default = 0').run()
        db.prepare('UPDATE api_keys SET is_default = 1 WHERE id = ?').run(id)
      })()
    },

    updateKey(id: string, fields: { label?: string; monthlyBudgetUsd?: number | null }): void {
      if (fields.label !== undefined) {
        db.prepare('UPDATE api_keys SET label = ? WHERE id = ?').run(
          fields.label.trim().slice(0, 40) || 'API key',
          id
        )
      }
      if (fields.monthlyBudgetUsd !== undefined) {
        db.prepare('UPDATE api_keys SET monthly_budget_usd = ? WHERE id = ?').run(
          fields.monthlyBudgetUsd,
          id
        )
      }
    },

    async checkKey(id: string): Promise<ApiKey | null> {
      const value = await vault.get(secretOf(id))
      if (!value) return null
      markKey(id, await deps.testAnthropicKey(value))
      return keys().find((k) => k.id === id) ?? null
    },

    // Records what a real request just learned (out of credit, rate limited,
    // working again), so the picker and failover prompt show it.
    noteKeyHealth(id: string, checked: Checked): void {
      markKey(id, checked)
    },

    // The key a chat should use: the one it names, else the default.
    async keyFor(keyId: string | null): Promise<{ id: string; key: string } | null> {
      const list = keys()
      const chosen = (keyId && list.find((k) => k.id === keyId)) || list.find((k) => k.isDefault)
      if (!chosen) return null
      const key = await vault.get(secretOf(chosen.id))
      return key ? { id: chosen.id, key } : null
    },

    // ---- Azure AI Foundry ----

    setAzure,

    async reprobeAzure(): Promise<AzureConnection | null> {
      const current = azure()
      const key = await vault.get('azure')
      if (!current || !key) return current
      return setAzure(current.endpoint, key)
    },

    removeAzure(): void {
      saveAzure(null)
      vault.remove('azure')
    },

    // Adds a deployment the probe couldn't find (a custom name), or changes
    // one: which model it serves, whether the picker offers it.
    setDeployment(name: string, patch: Partial<Omit<AzureDeployment, 'name'>>): void {
      const current = azure()
      if (!current) throw new Error('Connect Azure first.')
      const existing = current.deployments.find((d) => d.name === name)
      const deployments = existing
        ? current.deployments.map((d) => (d.name === name ? { ...d, ...patch } : d))
        : [
            ...current.deployments,
            {
              name,
              model: null,
              kind: 'chat' as const,
              enabled: true,
              source: 'manual' as const,
              ...patch
            }
          ]
      saveAzure({ ...current, deployments })
    },

    removeDeployment(name: string): void {
      const current = azure()
      if (!current) return
      saveAzure({ ...current, deployments: current.deployments.filter((d) => d.name !== name) })
    },

    setAzureBudget(monthlyBudgetUsd: number | null): void {
      const current = azure()
      if (current) saveAzure({ ...current, monthlyBudgetUsd })
    },

    noteAzureHealth(checked: Checked): void {
      const current = azure()
      if (current) saveAzure({ ...current, ...checked, checkedAt: Date.now() })
    },

    async azureCredentials(): Promise<{ endpoint: string; key: string } | null> {
      const current = azure()
      const key = current ? await vault.get('azure') : null
      return current && key ? { endpoint: current.endpoint, key } : null
    },

    // ---- Ollama ----

    ollamaUrl(): string {
      return state(OLLAMA_KEY) ?? DEFAULT_OLLAMA
    },

    setOllamaUrl(url: string | null): void {
      setState(OLLAMA_KEY, url && url.trim() !== DEFAULT_OLLAMA ? url.trim() : null)
    }
  }
}
