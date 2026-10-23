import { describe, expect, it } from 'vitest'
import { effortLevels, hasThinkingSwitch, MODEL_SPECS, nearestEffort, specFor } from './models'

describe('model specs', () => {
  it('finds a spec by model id, dated deployment name or case', () => {
    expect(specFor('claude-opus-5-5')?.label).toBe('Opus 5.5')
    expect(specFor('gpt-6-sol-2026-09-22')?.label).toBe('GPT-6 Sol')
    expect(specFor('GPT-6-Astra')?.label).toBe('GPT-6 Astra')
    expect(specFor('my-custom-deployment')).toBeNull()
  })

  it('has unique ids and sane limits', () => {
    const ids = MODEL_SPECS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MODEL_SPECS) {
      expect(m.maxOutput).toBeLessThanOrEqual(m.context)
      expect(m.price.out).toBeGreaterThan(0)
      const { defaultLevel, levels } = m.reasoning
      if (defaultLevel) expect(levels).toContain(defaultLevel)
    }
  })

  it('never offers sampling on Claude', () => {
    for (const m of MODEL_SPECS.filter((s) => s.family === 'claude')) {
      expect(m.sampling).toBe('never')
    }
  })

  it('caps effort while Anthropic thinking is off', () => {
    const sonnet = specFor('claude-sonnet-5-5')!
    expect(effortLevels(sonnet.reasoning, false)).toContain('max')
    expect(effortLevels(sonnet.reasoning, true)).toEqual(['low', 'medium', 'high'])
    // Opus 5.5 can't turn thinking off, so the switch never shows.
    expect(hasThinkingSwitch(specFor('claude-opus-5-5')!.reasoning)).toBe(false)
    expect(hasThinkingSwitch(sonnet.reasoning)).toBe(true)
    // OpenAI folds "off" into its 'none' level instead of a switch.
    expect(hasThinkingSwitch(specFor('gpt-6-sol')!.reasoning)).toBe(false)
  })

  it('carries effort to the nearest level another model accepts', () => {
    const astra = specFor('gpt-6-astra')!.reasoning.levels
    expect(nearestEffort(astra, 'none')).toBe('low')
    expect(nearestEffort(astra, 'xhigh')).toBe('xhigh')
    expect(nearestEffort(['low', 'medium', 'high', 'max'], 'xhigh')).toBe('high')
    expect(nearestEffort([], 'high')).toBeNull()
  })
})
