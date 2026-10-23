import { MODEL_SPECS, type Price } from '../../shared/models'

// What Azure's public price list says about the GPT models Orcha knows: input,
// cached input, cache write and output, for short and long prompts, on the
// Global Standard deployment type. (Data Zone deployments cost 10% to 20%
// more and Flex half as much; those meters are not read.)
//
// Microsoft names its meters by hand and not consistently: '6-sol ShortCo Inp
// Std Gl 1M Tokens', '5.4 longco cd inp Gl 1M Tokens', 'GPT 5 cchd Inpt Glbl
// 1M Tokens', 'gpt 4.1 Outp glbl Tokens' (priced per thousand tokens). So a
// meter only counts when every word in its name is understood; one with a
// word Orcha doesn't know (Flex, Priority, Batch, Data Zone, regional,
// fine-tuning, audio...) is left alone rather than guessed at.

type Kind = 'in' | 'out' | 'cacheRead' | 'cacheWrite'
const KINDS: Kind[] = ['in', 'out', 'cacheRead', 'cacheWrite']

// The part of one row of the Retail Prices list that is read here.
export interface RetailItem {
  meterName: string
  retailPrice: number
  unitOfMeasure: string
  effectiveStartDate?: string
  currencyCode?: string
  tierMinimumUnits?: number
  type?: string
}

// USD per million tokens, and the day Azure says that price began, if it says.
export interface Rate {
  usd: number
  since: number | null
}

export interface ModelRates {
  short: Partial<Record<Kind, Rate>>
  long: Partial<Record<Kind, Rate>>
}

type Word = 'input' | 'output' | 'cached' | 'write' | 'short' | 'long' | 'global' | 'skip'

// How meters spell each idea. Standard is the only tier tracked, so its
// marker says nothing new; the other tiers' markers stay unknown on purpose.
const WORDS = new Map<string, Word>()
const spell = (word: Word, ...spellings: string[]): void => {
  for (const spelling of spellings) WORDS.set(spelling, word)
}
spell('input', 'inp', 'inpt', 'input')
spell('output', 'opt', 'outp', 'outpt', 'out', 'output')
spell('cached', 'cd', 'cchd', 'ccchd', 'cached')
spell('write', 'wr')
spell('short', 'shortco', 'shco')
spell('long', 'longco', 'loco')
spell('global', 'gl', 'glbl', 'glb', 'global')
spell('skip', 'std', 'tokens', '1m', '1k')

// A model's name with the 'gpt' and every dot and dash taken out, which is
// how its meters spell it: 'gpt-5.4-mini' -> '54mini', 'gpt-6.1-sol' -> '61sol'.
const squash = (name: string): string =>
  name
    .toLowerCase()
    .replace(/^gpt-?/, '')
    .replace(/[^a-z0-9]/g, '')

const MODEL_KEYS = new Map(
  MODEL_SPECS.filter((m) => m.family === 'gpt').map((m) => [squash(m.id), m.id])
)

interface Meter {
  model: string // MODEL_SPECS id
  tier: 'short' | 'long'
  kind: Kind
}

function kindOf(words: Set<Word>): Kind | null {
  if (words.has('write')) return words.has('input') || words.has('output') ? null : 'cacheWrite'
  if (words.has('output')) return words.has('input') || words.has('cached') ? null : 'out'
  if (words.has('input')) return words.has('cached') ? 'cacheRead' : 'in'
  return null
}

function readMeterName(name: string): Meter | null {
  const words = new Set<Word>()
  const unknown: string[] = []
  for (const part of name.toLowerCase().split(/[\s_-]+/)) {
    const word = WORDS.get(part)
    if (word) words.add(word)
    // Long digit runs are version dates ('05052026'); they don't name the model.
    else if (part && !/^\d{4,}$/.test(part)) unknown.push(part)
  }
  if (!words.has('global') || (words.has('short') && words.has('long'))) return null
  const model = MODEL_KEYS.get(squash(unknown.join('')))
  const kind = kindOf(words)
  if (!model || !kind) return null
  return { model, tier: words.has('long') ? 'long' : 'short', kind }
}

// Meters are priced per 1M tokens, or per 1K on older models.
const UNIT = /^(\d+(?:\.\d+)?)\s*([KM])(?:\s*tokens?)?$/i

function usdPerMillion(item: RetailItem): number | null {
  const unit = UNIT.exec(item.unitOfMeasure.trim())
  if (!unit || !(item.retailPrice > 0)) return null
  const tokens = Number(unit[1]) * (unit[2].toUpperCase() === 'K' ? 1e3 : 1e6)
  if (!(tokens > 0)) return null
  // 12 digits keep 0.00015 per 1K from turning into 0.15000000000000002.
  return Number(((item.retailPrice * 1e6) / tokens).toPrecision(12))
}

// A plain pay-as-you-go row in dollars; volume tiers and reservations are not prices of a call.
function isListPrice(item: RetailItem): boolean {
  return (
    (item.currencyCode ?? 'USD') === 'USD' &&
    (item.type ?? 'Consumption') === 'Consumption' &&
    (item.tierMinimumUnits ?? 0) === 0
  )
}

// Prices from two sources agree when they match to a billionth of a dollar
// (a per-1K price scaled up can be off in the last decimal places).
export const sameUsd = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < 1e-9

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b)
}

function newest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b)
}

// The rates Azure lists for each model Orcha knows (by MODEL_SPECS id). Two
// meters for one slot (a model's several dated versions) are fine when they
// agree and dropped when they don't: no update beats a guessed one.
export function readMeters(items: readonly RetailItem[]): Map<string, ModelRates> {
  const found = new Map<string, ModelRates>()
  const clashes: Meter[] = []
  for (const item of items) {
    const meter = isListPrice(item) ? readMeterName(item.meterName) : null
    const usd = meter && usdPerMillion(item)
    if (!meter || !usd) continue
    const since = Date.parse(item.effectiveStartDate ?? '')
    const rate: Rate = { usd, since: Number.isNaN(since) ? null : since }
    const rates = found.get(meter.model) ?? { short: {}, long: {} }
    found.set(meter.model, rates)
    const have = rates[meter.tier][meter.kind]
    if (!have) rates[meter.tier][meter.kind] = rate
    else if (sameUsd(have.usd, usd)) have.since = earliest(have.since, rate.since)
    else clashes.push(meter)
  }
  for (const { model, tier, kind } of clashes) delete found.get(model)![tier][kind]
  for (const [model, rates] of found) {
    if (!Object.keys(rates.short).length && !Object.keys(rates.long).length) found.delete(model)
  }
  return found
}

// A price with Azure's rates laid over it. Only the slots Azure listed are
// touched, so a meter Orcha couldn't read leaves that part as it was; a long
// tier is only adjusted where the price already has one. `since` is the day
// the newest changed rate began, per Azure.
export function mergeRates(base: Price, rates: ModelRates): { price: Price; since: number | null } {
  const price: Price = { ...base }
  if (base.long) price.long = { ...base.long }
  let since: number | null = null
  for (const kind of KINDS) {
    const short = rates.short[kind]
    if (short && !sameUsd(base[kind], short.usd)) {
      price[kind] = short.usd
      since = newest(since, short.since)
    }
    const long = rates.long[kind]
    if (long && price.long && !sameUsd(base.long?.[kind], long.usd)) {
      price.long[kind] = long.usd
      since = newest(since, long.since)
    }
  }
  return { price, since }
}
