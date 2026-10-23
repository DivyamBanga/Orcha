// What Orcha knows about each model family it can reach: limits, how its
// reasoning is controlled, which generation knobs it accepts, and its list
// price. Facts checked against Anthropic's and Microsoft's docs on 2026-10-22.
// Live data (Anthropic's Models API, Azure's retail prices, Ollama's
// /api/show) refines this at runtime; this table is the fallback and the
// source of the rules the APIs don't report (defaults, how "off" works).

// One effort scale for every provider. Each model offers a subset, in this
// order; 'none' means no reasoning at all.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

// How a model's thinking is switched off, when it can be.
//  'omit'          Anthropic: leave `thinking` out (models that default to no thinking)
//  'disabled'      Anthropic: thinking {type:'disabled'}, only at effort ≤ maxEffortWhenOff
//  'between_tools' Anthropic Sonnet 5.5: thinking {type:'between_tools'}, effort ≤ high
//  'effort-none'   OpenAI: reasoning.effort 'none'
export type ThinkingOff = 'omit' | 'disabled' | 'between_tools' | 'effort-none'

export interface Reasoning {
  // Effort levels the model accepts, low to high. Empty: no effort control.
  levels: Effort[]
  // Level the provider uses when none is sent.
  defaultLevel: Effort | null
  // How thinking turns off, or null when it can't.
  off: ThinkingOff | null
  // Highest effort allowed while thinking is off (Anthropic 'disabled' and
  // 'between_tools' are rejected above 'high').
  maxEffortWhenOff?: Effort
  // Thinking is off unless asked for (Opus 4.6–4.8, Sonnet 4.6).
  offByDefault?: boolean
  // Thinking is only available as a fixed token budget (Claude 4.5 generation).
  budgetOnly?: boolean
}

// USD per million tokens. Anthropic splits cache writes by lifetime; OpenAI
// bills one cache-write rate (GPT-5.6 and later; earlier models write free).
export interface Price {
  in: number
  out: number
  cacheRead: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  cacheWrite?: number
  // A request whose input exceeds `above` tokens is priced at these rates
  // instead (Haiku 5.5 over 100K; GPT long context over 272K).
  long?: { above: number; in: number; out: number; cacheRead: number; cacheWrite?: number }
}

export type Family = 'claude' | 'gpt'

export interface ModelSpec {
  // The provider's model id ('claude-opus-5-5'), which is also the default
  // Azure deployment name ('gpt-6-sol').
  id: string
  family: Family
  label: string
  description: string
  // Up top in the picker, or under "More models".
  current: boolean
  context: number
  maxOutput: number
  vision: boolean
  pdf: boolean // read as documents natively (else text is extracted)
  reasoning: Reasoning
  // Sampling (temperature, top_p): never on Claude since API 2026-10-21;
  // on reasoning GPT models only while effort is 'none'.
  sampling: 'never' | 'when-no-reasoning' | 'always'
  verbosity: boolean // OpenAI text.verbosity
  // Anthropic server web search tool version, or 'responses' for Azure's
  // web_search tool; null when the model can't search natively.
  webSearch: string | null
  // Covered models keep data 30 days at Anthropic, so incognito avoids them.
  retains30d?: boolean
  price: Price
  deprecated?: boolean
}

const ANTHROPIC_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Anthropic cache writes: 1.25x input for 5 minutes, 2x for an hour.
const claudePrice = (input: number, output: number, cacheRead: number): Price => ({
  in: input,
  out: output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2
})

const claude = (
  m: Omit<ModelSpec, 'family' | 'sampling' | 'verbosity' | 'vision' | 'pdf'>
): ModelSpec => ({
  family: 'claude',
  sampling: 'never',
  verbosity: false,
  vision: true,
  pdf: true,
  ...m
})

// GPT cache writes are billed at 1.25x input from GPT-5.6 on.
const gptPrice = (
  input: number,
  cached: number,
  output: number,
  long?: [number, number, number],
  writes = true
): Price => ({
  in: input,
  out: output,
  cacheRead: cached,
  ...(writes ? { cacheWrite: input * 1.25 } : {}),
  ...(long
    ? {
        long: {
          above: 272_000,
          in: long[0],
          cacheRead: long[1],
          out: long[2],
          ...(writes ? { cacheWrite: long[0] * 1.25 } : {})
        }
      }
    : {})
})

const gpt = (
  m: Omit<ModelSpec, 'family' | 'sampling' | 'verbosity' | 'vision' | 'pdf' | 'webSearch'> &
    Partial<Pick<ModelSpec, 'sampling' | 'verbosity' | 'webSearch'>>
): ModelSpec => ({
  family: 'gpt',
  vision: true,
  pdf: true,
  verbosity: true,
  webSearch: 'responses',
  sampling: m.reasoning.levels.includes('none') ? 'when-no-reasoning' : 'never',
  ...m
})

export const MODEL_SPECS: ModelSpec[] = [
  // ---- Claude: current generation (1M context, 128K output) ----
  claude({
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    description: "Anthropic's most capable model, for the hardest work",
    current: true,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: { levels: ANTHROPIC_EFFORTS, defaultLevel: 'high', off: null },
    webSearch: 'web_search_20250305',
    retains30d: true,
    price: claudePrice(10, 50, 0.25)
  }),
  claude({
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'Deep reasoning for complex work',
    current: true,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: { levels: ANTHROPIC_EFFORTS, defaultLevel: 'medium', off: null },
    webSearch: 'web_search_20260209',
    price: claudePrice(4, 20, 0.2)
  }),
  claude({
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    description: 'Fast and capable, for everyday work',
    current: true,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ANTHROPIC_EFFORTS,
      defaultLevel: 'high',
      off: 'between_tools',
      maxEffortWhenOff: 'high'
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(2, 10, 0.1)
  }),
  claude({
    id: 'claude-haiku-5-5',
    label: 'Haiku 5.5',
    description: 'Fastest and cheapest, for quick questions',
    current: true,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ANTHROPIC_EFFORTS,
      defaultLevel: 'medium',
      off: 'disabled',
      maxEffortWhenOff: 'high'
    },
    webSearch: 'web_search_20250305',
    price: {
      in: 0.1,
      out: 0.5,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      long: { above: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05 }
    }
  }),

  // ---- Claude: earlier models ----
  claude({
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: 'Previous Fable',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: { levels: ANTHROPIC_EFFORTS, defaultLevel: 'high', off: null },
    webSearch: 'web_search_20250305',
    retains30d: true,
    price: claudePrice(10, 50, 1)
  }),
  claude({
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: 'Previous Opus',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ANTHROPIC_EFFORTS,
      defaultLevel: 'high',
      off: 'disabled',
      maxEffortWhenOff: 'high'
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(5, 25, 0.5)
  }),
  claude({
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Previous Sonnet',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: { levels: ANTHROPIC_EFFORTS, defaultLevel: 'high', off: 'disabled' },
    webSearch: 'web_search_20260209',
    price: claudePrice(2, 10, 0.2)
  }),
  claude({
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    description: 'Earlier Opus',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ANTHROPIC_EFFORTS,
      defaultLevel: 'high',
      off: 'omit',
      offByDefault: true
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(5, 25, 0.5)
  }),
  claude({
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    description: 'Earlier Opus',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ANTHROPIC_EFFORTS,
      defaultLevel: 'high',
      off: 'omit',
      offByDefault: true
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(5, 25, 0.5)
  }),
  claude({
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    description: 'Earlier Opus',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['low', 'medium', 'high', 'max'],
      defaultLevel: 'high',
      off: 'omit',
      offByDefault: true
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(5, 25, 0.5)
  }),
  claude({
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Earlier Sonnet',
    current: false,
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['low', 'medium', 'high', 'max'],
      defaultLevel: 'high',
      off: 'omit',
      offByDefault: true
    },
    webSearch: 'web_search_20260209',
    price: claudePrice(3, 15, 0.3)
  }),
  claude({
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Earlier Haiku (200K context)',
    current: false,
    context: 200_000,
    maxOutput: 64_000,
    reasoning: {
      levels: [],
      defaultLevel: null,
      off: 'omit',
      offByDefault: true,
      budgetOnly: true
    },
    webSearch: 'web_search_20250305',
    price: claudePrice(1, 5, 0.1)
  }),

  // ---- GPT on Azure: GPT-6 (1.05M context: 922K in, 128K out) ----
  gpt({
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: "OpenAI's newest everyday model",
    current: true,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      off: null
    },
    price: gptPrice(2, 0.1, 10, [4, 0.2, 15])
  }),
  gpt({
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: "OpenAI's most capable model",
    current: true,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      off: null
    },
    price: gptPrice(10, 1, 50, [20, 2, 75])
  }),
  gpt({
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'Fast and capable',
    current: true,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      off: 'effort-none'
    },
    price: gptPrice(2, 0.2, 10, [4, 0.4, 15])
  }),
  gpt({
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'Fastest and cheapest GPT-6',
    current: true,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      off: 'effort-none'
    },
    price: gptPrice(0.1, 0.01, 0.5, [0.2, 0.02, 0.75])
  }),

  // ---- GPT on Azure: earlier models ----
  ...(
    [
      ['gpt-5.6-sol', 'GPT-5.6 Sol', 4, 0.4, 20, [8, 0.8, 30]],
      ['gpt-5.6-terra', 'GPT-5.6 Terra', 2, 0.2, 12, [4, 0.4, 18]],
      ['gpt-5.6-luna', 'GPT-5.6 Luna', 0.2, 0.02, 1.2, [0.4, 0.04, 1.8]]
    ] as const
  ).map(([id, label, input, cached, output, long]) =>
    gpt({
      id,
      label,
      description: 'GPT-5.6',
      current: false,
      context: 1_050_000,
      maxOutput: 128_000,
      reasoning: {
        levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
        off: 'effort-none'
      },
      price: gptPrice(input, cached, output, [long[0], long[1], long[2]])
    })
  ),
  gpt({
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'GPT-5.5',
    current: false,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'medium',
      off: 'effort-none'
    },
    price: gptPrice(5, 0.5, 30, [10, 1, 45], false)
  }),
  gpt({
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'GPT-5.4',
    current: false,
    context: 1_050_000,
    maxOutput: 128_000,
    reasoning: {
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'medium',
      off: 'effort-none'
    },
    price: gptPrice(2.5, 0.25, 15, [5, 0.5, 22.5], false)
  }),
  ...(
    [
      ['gpt-5.4-mini', 'GPT-5.4 mini', 0.75, 0.075, 4.5],
      ['gpt-5.4-nano', 'GPT-5.4 nano', 0.2, 0.02, 1.25]
    ] as const
  ).map(([id, label, input, cached, output]) =>
    gpt({
      id,
      label,
      description: 'Small GPT-5.4 (400K context)',
      current: false,
      context: 400_000,
      maxOutput: 128_000,
      reasoning: {
        levels: ['none', 'low', 'medium', 'high'],
        defaultLevel: 'medium',
        off: 'effort-none'
      },
      price: gptPrice(input, cached, output, undefined, false)
    })
  ),
  gpt({
    id: 'gpt-chat-latest',
    label: 'GPT Chat (preview)',
    description: 'ChatGPT’s chat model, fixed reasoning',
    current: false,
    context: 128_000,
    maxOutput: 16_384,
    reasoning: { levels: [], defaultLevel: null, off: null },
    price: gptPrice(5, 0.5, 30, undefined, false)
  }),
  ...(
    [
      ['gpt-5.2', 'GPT-5.2', 1.75, 0.175, 14],
      ['gpt-5.1', 'GPT-5.1', 1.25, 0.125, 10]
    ] as const
  ).map(([id, label, input, cached, output]) =>
    gpt({
      id,
      label,
      description: 'Earlier GPT-5 (400K context)',
      current: false,
      context: 400_000,
      maxOutput: 128_000,
      reasoning: {
        levels: ['none', 'low', 'medium', 'high'],
        defaultLevel: id === 'gpt-5.1' ? 'none' : 'medium',
        off: 'effort-none'
      },
      price: gptPrice(input, cached, output, undefined, false)
    })
  ),
  ...(
    [
      ['gpt-5', 'GPT-5', 1.25, 0.125, 10],
      ['gpt-5-mini', 'GPT-5 mini', 0.25, 0.025, 2],
      ['gpt-5-nano', 'GPT-5 nano', 0.05, 0.005, 0.4]
    ] as const
  ).map(([id, label, input, cached, output]) =>
    gpt({
      id,
      label,
      description: 'Original GPT-5 (400K context)',
      current: false,
      context: 400_000,
      maxOutput: 128_000,
      reasoning: {
        levels: ['minimal', 'low', 'medium', 'high'],
        defaultLevel: 'medium',
        off: null
      },
      price: gptPrice(input, cached, output, undefined, false)
    })
  ),
  ...(
    [
      ['gpt-4.1', 'GPT-4.1', 2, 0.5, 8],
      ['gpt-4.1-mini', 'GPT-4.1 mini', 0.4, 0.1, 1.6],
      ['gpt-4.1-nano', 'GPT-4.1 nano', 0.1, 0.025, 0.4],
      ['gpt-4o', 'GPT-4o', 2.5, 1.25, 10],
      ['gpt-4o-mini', 'GPT-4o mini', 0.15, 0.075, 0.6]
    ] as const
  ).map(([id, label, input, cached, output]) =>
    gpt({
      id,
      label,
      description: 'No reasoning',
      current: false,
      context: id.startsWith('gpt-4.1') ? 1_047_576 : 128_000,
      maxOutput: id.startsWith('gpt-4.1') ? 32_768 : 16_384,
      reasoning: { levels: [], defaultLevel: null, off: null },
      sampling: 'always',
      verbosity: false,
      price: gptPrice(input, cached, output, undefined, false)
    })
  )
]

const BY_ID = new Map(MODEL_SPECS.map((m) => [m.id, m]))

// The spec for a provider model id or Azure deployment name. Deployments are
// usually named after their model; a dated suffix ('gpt-6-sol-2026-09-22') or
// a short alias still finds it.
export function specFor(model: string): ModelSpec | null {
  const id = model.toLowerCase()
  if (BY_ID.has(id)) return BY_ID.get(id)!
  const dateless = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')
  return BY_ID.get(dateless) ?? null
}

// The effort levels to offer, given whether thinking is switched off.
export function effortLevels(reasoning: Reasoning, thinkingOff: boolean): Effort[] {
  if (!thinkingOff || !reasoning.maxEffortWhenOff) return reasoning.levels
  const cap = EFFORTS.indexOf(reasoning.maxEffortWhenOff)
  return reasoning.levels.filter((level) => EFFORTS.indexOf(level) <= cap)
}

// Whether a separate Thinking switch makes sense: Anthropic models whose
// thinking can be turned off (OpenAI folds "off" into the 'none' effort).
export function hasThinkingSwitch(reasoning: Reasoning): boolean {
  return reasoning.off !== null && reasoning.off !== 'effort-none'
}

// The nearest level a model accepts, for carrying an effort across a switch
// between models with different scales.
export function nearestEffort(levels: Effort[], wanted: Effort): Effort | null {
  if (levels.length === 0) return null
  if (levels.includes(wanted)) return wanted
  const target = EFFORTS.indexOf(wanted)
  return [...levels].sort(
    (a, b) => Math.abs(EFFORTS.indexOf(a) - target) - Math.abs(EFFORTS.indexOf(b) - target)
  )[0]
}
