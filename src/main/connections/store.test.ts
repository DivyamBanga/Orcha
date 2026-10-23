import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createVault, VAULT_SCHEMA } from '../vault'
import {
  CONNECTIONS_SCHEMA,
  createConnections,
  DEFAULT_OLLAMA,
  type ConnectionDeps,
  type ConnectionStore
} from './store'
import type { AzureDeployment } from '../../shared/ai'

const cipher = {
  available: async () => true,
  encrypt: async (plain: string) => Buffer.from(plain).reverse(),
  decrypt: async (blob: Buffer) => ({ plain: Buffer.from(blob).reverse().toString(), stale: false })
}

function setup(overrides: Partial<ConnectionDeps> = {}): {
  db: Database.Database
  store: ConnectionStore
  setProbe: (p: AzureDeployment[]) => void
} {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT)')
  db.exec(VAULT_SCHEMA)
  db.exec(CONNECTIONS_SCHEMA)
  const vault = createVault(db, cipher)
  let probe: AzureDeployment[] = [
    { name: 'gpt-6-sol', model: 'gpt-6-sol', kind: 'chat', enabled: true, source: 'probe' }
  ]
  const store = createConnections({
    db,
    vault,
    testAnthropicKey: async (key) =>
      key.endsWith('bad')
        ? { health: 'invalid', detail: 'Anthropic refused that key.' }
        : { health: 'ok', detail: null },
    normalizeAzureEndpoint: (input) => input.replace(/\/openai\/v1\/?$/, '').replace(/\/$/, ''),
    testAzure: async () => ({ health: 'ok', detail: null }),
    probeAzure: async () => probe,
    plan: () => ({ signedIn: true, plan: 'max' }),
    ollama: () => ({
      baseUrl: DEFAULT_OLLAMA,
      status: 'running',
      version: '0.40.8',
      models: [],
      pulls: []
    }),
    ...overrides
  })
  return {
    db,
    store,
    setProbe: (p: AzureDeployment[]) => {
      probe = p
    }
  }
}

describe('connections', () => {
  it('adds keys, makes the first the default, and never keeps plain text', async () => {
    const { db, store } = setup()
    const a = await store.addKey('Personal', 'sk-ant-api03-aaaaaaaaaaaa1111')
    const b = await store.addKey('Research', 'sk-ant-api03-bbbbbbbbbbbb2222')
    expect(a.isDefault).toBe(true)
    expect(b.isDefault).toBe(false)
    expect(b.hint).toBe('…2222')
    const dump = JSON.stringify(db.prepare('SELECT * FROM api_keys').all())
    expect(dump).not.toContain('bbbbbbbb')
    expect(await store.keyFor(null)).toEqual({ id: a.id, key: 'sk-ant-api03-aaaaaaaaaaaa1111' })
    expect((await store.keyFor(b.id))?.key).toBe('sk-ant-api03-bbbbbbbbbbbb2222')
  })

  it('rejects keys that are malformed or refused', async () => {
    const { store } = setup()
    await expect(store.addKey('x', 'not-a-key')).rejects.toThrow(/doesn't look like/)
    await expect(store.addKey('x', 'sk-ant-api03-whatever-bad')).rejects.toThrow(/refused/)
    expect(store.list().keys).toHaveLength(0)
  })

  it('hands the default on when the default key is removed', async () => {
    const { store } = setup()
    const a = await store.addKey('A', 'sk-ant-api03-aaaaaaaaaaaa1111')
    const b = await store.addKey('B', 'sk-ant-api03-bbbbbbbbbbbb2222')
    store.removeKey(a.id)
    expect(store.list().keys.map((k) => [k.id, k.isDefault])).toEqual([[b.id, true]])
    store.setDefaultKey(b.id)
    expect(store.list().keys[0].isDefault).toBe(true)
  })

  it('connects Azure and keeps choices across a re-probe', async () => {
    const { store, setProbe } = setup()
    const azure = await store.setAzure(
      'https://res.openai.azure.com/openai/v1/',
      'azure-key-123456'
    )
    expect(azure.endpoint).toBe('https://res.openai.azure.com')
    expect(azure.deployments.map((d) => d.name)).toEqual(['gpt-6-sol'])

    store.setDeployment('gpt-6-sol', { enabled: false })
    store.setDeployment('my-astra', { model: 'gpt-6-astra' })
    setProbe([
      { name: 'gpt-6-sol', model: 'gpt-6-sol', kind: 'chat', enabled: true, source: 'probe' },
      { name: 'gpt-6-luna', model: 'gpt-6-luna', kind: 'chat', enabled: true, source: 'probe' }
    ])
    const again = await store.reprobeAzure()
    const byName = Object.fromEntries((again?.deployments ?? []).map((d) => [d.name, d]))
    expect(byName['gpt-6-sol'].enabled).toBe(false) // the owner's choice survives
    expect(byName['gpt-6-luna'].enabled).toBe(true)
    expect(byName['my-astra'].model).toBe('gpt-6-astra') // added by hand, kept
    expect(await store.azureCredentials()).toEqual({
      endpoint: 'https://res.openai.azure.com',
      key: 'azure-key-123456'
    })

    store.removeAzure()
    expect(store.list().azure).toBeNull()
    expect(await store.azureCredentials()).toBeNull()
  })

  it('refuses an Azure connection that does not answer', async () => {
    const { store } = setup({
      testAzure: async () => ({ health: 'unreachable', detail: "Couldn't reach that endpoint." })
    })
    await expect(store.setAzure('https://nope.openai.azure.com', 'k')).rejects.toThrow(/reach/)
    expect(store.list().azure).toBeNull()
  })

  it('remembers a custom Ollama address', () => {
    const { store } = setup()
    expect(store.ollamaUrl()).toBe(DEFAULT_OLLAMA)
    store.setOllamaUrl('http://127.0.0.1:11500')
    expect(store.ollamaUrl()).toBe('http://127.0.0.1:11500')
    store.setOllamaUrl(null)
    expect(store.ollamaUrl()).toBe(DEFAULT_OLLAMA)
  })
})
