import { describe, expect, it } from 'vitest'
import { buildCatalog } from './catalog'
import type { Connections } from '../../shared/ai'

const empty: Connections = {
  plan: { signedIn: false, plan: null },
  keys: [],
  azure: null,
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    status: 'stopped',
    version: null,
    models: [],
    pulls: []
  }
}

describe('catalog', () => {
  it('lists Claude on the Max plan, without a price, ready only when signed in', () => {
    const off = buildCatalog(empty, null).filter((m) => m.route === 'plan')
    expect(off.some((m) => m.id === 'plan:claude-opus-5-5')).toBe(true)
    expect(off.every((m) => !m.ready && m.price === null)).toBe(true)
    const on = buildCatalog({ ...empty, plan: { signedIn: true, plan: 'max' } }, null)
    expect(on.find((m) => m.id === 'plan:claude-opus-5-5')?.ready).toBe(true)
  })

  it('offers API-key Claude only with a key, merging Anthropic’s live list', () => {
    expect(buildCatalog(empty, null).some((m) => m.route === 'api')).toBe(false)
    const withKey: Connections = {
      ...empty,
      keys: [
        {
          id: 'k1',
          label: 'Personal',
          hint: '…1111',
          isDefault: true,
          monthlyBudgetUsd: null,
          health: 'ok',
          detail: null,
          checkedAt: 1,
          createdAt: 1
        }
      ]
    }
    const listed = [
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        maxInput: 1_000_000,
        maxOutput: 128_000
      },
      {
        id: 'claude-zephyr-6',
        displayName: 'Claude Zephyr 6',
        maxInput: 2_000_000,
        maxOutput: 256_000
      }
    ]
    const api = buildCatalog(withKey, listed).filter((m) => m.route === 'api')
    expect(api.map((m) => m.id)).toEqual(['api:claude-opus-5-5', 'api:claude-zephyr-6'])
    expect(api[0].price?.in).toBe(4)
    expect(api[1]).toMatchObject({
      label: 'Claude Zephyr 6',
      spec: null,
      context: 2_000_000,
      price: null
    })
  })

  it('maps enabled Azure chat deployments to their models', () => {
    const c: Connections = {
      ...empty,
      azure: {
        endpoint: 'https://res.openai.azure.com',
        hint: '…abcd',
        monthlyBudgetUsd: null,
        health: 'ok',
        detail: null,
        checkedAt: 1,
        deployments: [
          { name: 'gpt-6-sol', model: 'gpt-6-sol', kind: 'chat', enabled: true, source: 'probe' },
          {
            name: 'prod-astra',
            model: 'gpt-6-astra',
            kind: 'chat',
            enabled: true,
            source: 'manual'
          },
          {
            name: 'gpt-6-luna',
            model: 'gpt-6-luna',
            kind: 'chat',
            enabled: false,
            source: 'probe'
          },
          {
            name: 'gpt-image-2',
            model: 'gpt-image-2',
            kind: 'image',
            enabled: true,
            source: 'probe'
          },
          { name: 'mystery', model: null, kind: 'chat', enabled: true, source: 'manual' }
        ]
      }
    }
    const azure = buildCatalog(c, null).filter((m) => m.route === 'azure')
    expect(azure.map((m) => m.id)).toEqual(['azure:gpt-6-sol', 'azure:prod-astra', 'azure:mystery'])
    expect(azure[1].label).toBe('GPT-6 Astra (prod-astra)')
    expect(azure[1].reasoning.levels).not.toContain('none')
    expect(azure[2]).toMatchObject({ spec: null, price: null, sampling: 'always' })
  })

  it('describes local models by what Ollama says they can do', () => {
    const c: Connections = {
      ...empty,
      ollama: {
        ...empty.ollama,
        status: 'running',
        models: [
          {
            name: 'qwen3.5:9b',
            sizeBytes: 6.6e9,
            family: 'qwen35',
            parameters: '9.7B',
            quantization: 'Q4_K_M',
            capabilities: ['completion', 'vision', 'tools', 'thinking'],
            think: true,
            contextMax: 262_144,
            context: 32_768,
            loaded: false
          },
          {
            name: 'gpt-oss:20b',
            sizeBytes: 14e9,
            family: 'gptoss',
            parameters: '20.9B',
            quantization: 'MXFP4',
            capabilities: ['completion', 'tools', 'thinking'],
            think: ['low', 'medium', 'high'],
            contextMax: 131_072,
            context: 16_384,
            loaded: false
          },
          {
            name: 'qwen3-embedding:0.6b',
            sizeBytes: 6e8,
            family: 'qwen3',
            parameters: '0.6B',
            quantization: 'Q8_0',
            capabilities: ['embedding'],
            think: false,
            contextMax: 32_768,
            context: 8192,
            loaded: false
          }
        ]
      }
    }
    const local = buildCatalog(c, null).filter((m) => m.route === 'ollama')
    expect(local.map((m) => m.apiModel)).toEqual(['qwen3.5:9b', 'gpt-oss:20b'])
    expect(local[0]).toMatchObject({
      vision: true,
      tools: true,
      context: 32_768,
      ready: true,
      price: null
    })
    expect(local[0].reasoning).toMatchObject({ off: 'disabled', offByDefault: true, levels: [] })
    // Models that take levels can't be switched off.
    expect(local[1].reasoning).toMatchObject({ levels: ['low', 'medium', 'high'], off: null })
  })
})
