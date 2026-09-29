import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, poolForResponsesModel } from '../src/pricing.ts'
import type { MeteredUsage, UsageLine } from '../src/meter.ts'

const line = (model: string, t: Partial<UsageLine> = {}): UsageLine => ({
  model,
  inputTokens: 0,
  cachedTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  ...t
})

const usage = (lines: UsageLine[], extra: Partial<MeteredUsage> = {}): MeteredUsage => ({
  ...lines[0],
  lines,
  reasoningTokens: 0,
  webSearches: 0,
  serviceTier: null,
  speed: null,
  inferenceGeo: null,
  estimated: false,
  ...extra
})

const close = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`)

test('sonnet 5: every token class at its own rate', () => {
  // 1M of each class: 2 + 0.2 + 2.5 + 4 + 10
  const u = usage([
    line('claude-sonnet-5', {
      inputTokens: 1e6,
      cachedTokens: 1e6,
      cacheWrite5mTokens: 1e6,
      cacheWrite1hTokens: 1e6,
      outputTokens: 1e6
    })
  ])
  close(costOf('claude', u), 18.7)
})

test('dated ids, aliases and [1m] resolve to their family', () => {
  const out = (model: string): number =>
    costOf('claude', usage([line(model, { outputTokens: 1e6 })]))
  close(out('claude-haiku-4-5-20251001'), 5)
  close(out('claude-haiku-4-5'), 5)
  close(out('claude-sonnet-5-5-20260928'), 10)
  close(out('claude-opus-5-5[1m]'), 20)
  close(out('claude-opus-4-20250514'), 75)
  close(out('claude-sonnet-4-5-20250929'), 15)
})

test('unknown models are never priced below their family', () => {
  const out = (model: string): number =>
    costOf('claude', usage([line(model, { outputTokens: 1e6 })]))
  close(out('claude-opus-9'), 25)
  close(out('claude-sonnet-9'), 15)
  close(out('something-else'), 50)
})

test('fast mode, US inference, and web search surcharges', () => {
  const fast = usage([line('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6 })], {
    speed: 'fast'
  })
  close(costOf('claude', fast), 48)
  const geo = usage([line('claude-sonnet-5', { outputTokens: 1e6 })], { inferenceGeo: 'us' })
  close(costOf('claude', geo), 11)
  const search = usage([line('claude-sonnet-5')], { webSearches: 3 })
  close(costOf('claude', search), 0.03)
})

test('iterations are priced per line at each line model', () => {
  const u = usage([
    line('claude-opus-5-5', { outputTokens: 1e6 }),
    line('claude-haiku-4-5', { outputTokens: 1e6 })
  ])
  close(costOf('claude', u), 25)
})

test('azure sol/astra short and long context', () => {
  const sol = usage([
    line('gpt-6-sol', { inputTokens: 100_000, cachedTokens: 100_000, cacheWrite5mTokens: 50_000, outputTokens: 10_000 })
  ])
  // 0.1*2 + 0.1*0.2 + 0.05*2.5 + 0.01*10
  close(costOf('sol', sol), 0.445)
  const longAstra = usage([line('gpt-6-astra', { inputTokens: 200_000, cachedTokens: 100_000, outputTokens: 10_000 })])
  // 300K input > 272K: 0.2*20 + 0.1*2 + 0.01*75
  close(costOf('astra', longAstra), 4.95)
  const priority = usage([line('gpt-6-sol', { outputTokens: 1e6 })], { serviceTier: 'priority', webSearches: 2 })
  close(costOf('sol', priority), 20.028)
})

test('responses models map to pools; anything else is refused', () => {
  assert.equal(poolForResponsesModel('gpt-6-sol'), 'sol')
  assert.equal(poolForResponsesModel('gpt-6-astra'), 'astra')
  assert.equal(poolForResponsesModel('gpt-5-codex'), null)
})
