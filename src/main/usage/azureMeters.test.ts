import { describe, expect, it } from 'vitest'
import { MODEL_SPECS, specFor } from '../../shared/models'
import { mergeRates, readMeters, type ModelRates, type RetailItem } from './azureMeters'
import { retailItems } from './azureRetail.fixture'

const GPT_IDS = MODEL_SPECS.filter((m) => m.family === 'gpt').map((m) => m.id)

// The dollars only, to compare with what the price book says.
function plain(rates: ModelRates | undefined): unknown {
  const usd = (slot: ModelRates['short']): Record<string, number> =>
    Object.fromEntries(Object.entries(slot).map(([kind, rate]) => [kind, rate.usd]))
  return rates && { short: usd(rates.short), long: usd(rates.long) }
}

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

describe('reading Azure meters', () => {
  const rates = readMeters(retailItems())

  it('reads each way Azure spells a meter', () => {
    // '6-sol ShortCo Inp Std Gl 1M Tokens', cached input and cache write too
    expect(plain(rates.get('gpt-6-sol'))).toEqual({
      short: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      long: { in: 4, out: 15, cacheRead: 0.4, cacheWrite: 5 }
    })
    // '6.1-sol ...': a different cached-input price than GPT-6 Sol
    expect(plain(rates.get('gpt-6.1-sol'))).toEqual({
      short: { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      long: { in: 4, out: 15, cacheRead: 0.2, cacheWrite: 5 }
    })
    // '5.6 sol ...' with spaces
    expect(plain(rates.get('gpt-5.6-sol'))).toEqual({
      short: { in: 4, out: 20, cacheRead: 0.4, cacheWrite: 5 },
      long: { in: 8, out: 30, cacheRead: 0.8, cacheWrite: 10 }
    })
    // '5.5 ShortCo inp Gl' and '5.5 LongCo cd inp Gl': no cache-write meters at all
    expect(plain(rates.get('gpt-5.5'))).toEqual({
      short: { in: 5, out: 30, cacheRead: 0.5 },
      long: { in: 10, out: 45, cacheRead: 1 }
    })
    // '5.4 inp Gl' is short by default; '5.4 longco inp Gl' is long
    expect(plain(rates.get('gpt-5.4'))).toEqual({
      short: { in: 2.5, out: 15, cacheRead: 0.25 },
      long: { in: 5, out: 22.5, cacheRead: 0.5 }
    })
    // '5.4 mini cd Inp Gl' and 'GPT 5 Mini cchd Inpt Glbl'
    expect(plain(rates.get('gpt-5.4-mini'))).toEqual({
      short: { in: 0.75, out: 4.5, cacheRead: 0.075 },
      long: {}
    })
    expect(plain(rates.get('gpt-5-mini'))).toEqual({
      short: { in: 0.25, out: 2, cacheRead: 0.025 },
      long: {}
    })
  })

  it('scales prices listed per thousand tokens', () => {
    // 'gpt 4.1 Inp glbl Tokens' is 0.002 per 1K
    expect(plain(rates.get('gpt-4.1'))).toEqual({
      short: { in: 2, out: 8, cacheRead: 0.5 },
      long: {}
    })
    expect(plain(rates.get('gpt-4.1-nano'))).toEqual({
      short: { in: 0.1, out: 0.4, cacheRead: 0.025 },
      long: {}
    })
    expect(plain(rates.get('gpt-4o-mini'))).toEqual({
      short: { in: 0.15, out: 0.6, cacheRead: 0.075 },
      long: {}
    })
  })

  it('agrees with every built-in GPT price today', () => {
    for (const id of GPT_IDS) {
      const found = rates.get(id)
      expect(found, id).toBeDefined()
      // (GPT-4o's input and output are left out below: its versions disagree.)
      if (id !== 'gpt-4o') expect(found!.short.in && found!.short.out, id).toBeTruthy()
      const { price } = mergeRates(specFor(id)!.price, found!)
      expect(price, id).toEqual(specFor(id)!.price)
    }
  })

  it('takes agreeing meters for a model and drops the ones that disagree', () => {
    // GPT-4o has meters for several dated versions; 0513 costs more than 0806/1120.
    expect(plain(rates.get('gpt-4o'))).toEqual({ short: { cacheRead: 1.25 }, long: {} })
    // chat-latest has five dated versions, all at the same price.
    expect(plain(rates.get('gpt-chat-latest'))).toEqual({
      short: { in: 5, out: 30, cacheRead: 0.5 },
      long: {}
    })
  })

  it('uses only Global Standard meters of models Orcha knows', () => {
    // Everything Orcha must not use, priced absurdly: nothing should change.
    const skipped = [
      '6-sol ShortCo Inp Std DZ 1M Tokens', // Data Zone
      '6-sol ShortCo Inp Flex Gl 1M Tokens', // Flex
      '56sol ShCo Inp Fl Gl 1M Tokens', // Flex, another spelling
      '6-sol ShortCo Inp PP Gl 1M Tokens', // Priority
      '5.5 ShortCo PP inp Gl 1M Tokens',
      '5.4 Batch inp Gl 1M Tokens', // Batch
      'gpt 4.1 Batch Inp glbl Tokens',
      'gpt 4.1 mini Inp regnl Tokens', // regional
      'gpt 4.1 dev ft training glbl Tokens', // fine-tuning
      'gpt-4.1-ft input global Tokens',
      '5.4 pro inp Gl 1M Tokens', // other models
      'GPT 5 Chat Inpt Glbl 1M Tokens',
      'gpt-5-codex-inp-glbl Tokens',
      'o3 0416 Inp glbl Tokens',
      'gpt-4o-transcribe-txt-inp-glbl Tokens', // audio and images
      'gpt img 1.5 in txt gl 1M Tokens',
      'GPT OSS 120b RFT Gl Unit' // priced per hour
    ]
    const items = retailItems()
    for (const name of skipped) {
      expect(
        items.some((i) => i.meterName === name),
        name
      ).toBe(true)
    }
    const doubled = items.map((i) =>
      skipped.includes(i.meterName) ? { ...i, retailPrice: 999 } : i
    )
    expect(readMeters(doubled)).toEqual(rates)
    expect([...rates.keys()].every((id) => GPT_IDS.includes(id))).toBe(true)
  })

  it('records the day Azure says a price began, the earliest for repeated meters', () => {
    expect(rates.get('gpt-6.1-sol')?.short.in?.since).toBe(day('2026-10-01'))
    expect(rates.get('gpt-6-sol')?.short.in?.since).toBe(day('2026-09-01'))
    expect(rates.get('gpt-chat-latest')?.short.in?.since).toBe(day('2026-05-01'))
  })

  it('only counts plain pay-as-you-go prices in dollars', () => {
    const row = (over: Partial<RetailItem>): RetailItem => ({
      meterName: '6-sol ShortCo Inp Std Gl 1M Tokens',
      retailPrice: 2,
      unitOfMeasure: '1M',
      currencyCode: 'USD',
      type: 'Consumption',
      tierMinimumUnits: 0,
      ...over
    })
    const inputOf = (item: RetailItem): number | undefined =>
      readMeters([item]).get('gpt-6-sol')?.short.in?.usd
    expect(inputOf(row({}))).toBe(2)
    expect(inputOf(row({ currencyCode: 'CAD' }))).toBeUndefined()
    expect(inputOf(row({ type: 'Reservation' }))).toBeUndefined()
    expect(inputOf(row({ tierMinimumUnits: 5000 }))).toBeUndefined()
    expect(inputOf(row({ retailPrice: 0 }))).toBeUndefined()
    expect(inputOf(row({ unitOfMeasure: '1 Hour' }))).toBeUndefined()
    expect(inputOf(row({ unitOfMeasure: '1K', retailPrice: 0.002 }))).toBe(2)
  })

  it('reads a meter only when every word in its name is understood', () => {
    const inputOf = (meterName: string): number | undefined =>
      readMeters([{ meterName, retailPrice: 2, unitOfMeasure: '1M' }]).get('gpt-6-sol')?.short.in
        ?.usd
    expect(inputOf('6-sol ShortCo Inp Std Gl 1M Tokens')).toBe(2)
    expect(inputOf('6-SOL SHORTCO INP STD GL')).toBe(2)
    expect(inputOf('6-sol ShortCo Inp Std Gl Preview 1M Tokens')).toBeUndefined()
    expect(inputOf('6-sol ShortCo Inp Std 1M Tokens')).toBeUndefined() // not marked Global
    expect(inputOf('6-sol ShortCo LongCo Inp Std Gl 1M Tokens')).toBeUndefined()
    expect(inputOf('6-sol ShortCo Cd Std Gl 1M Tokens')).toBeUndefined() // cached what?
    expect(inputOf('6-sol ShortCo Inp Opt Std Gl 1M Tokens')).toBeUndefined()
  })

  it('keeps every model apart: its own name finds only itself', () => {
    for (const id of GPT_IDS) {
      const meter = {
        meterName: `${id.replace(/^gpt-/, '')} Inp Gl`,
        retailPrice: 1,
        unitOfMeasure: '1M'
      }
      expect([...readMeters([meter]).keys()], id).toEqual([id])
    }
  })
})

describe('laying Azure rates over a price', () => {
  const sol = specFor('gpt-6-sol')!.price
  const rate = (
    usd: number,
    since: number | null = null
  ): { usd: number; since: number | null } => ({
    usd,
    since
  })

  it('changes only the slots Azure listed and reports when the newest change began', () => {
    const { price, since } = mergeRates(sol, {
      short: { in: rate(2.5, day('2026-09-01')), out: rate(10, day('2026-10-01')) },
      long: { cacheRead: rate(0.5, day('2026-08-01')) }
    })
    expect(price).toEqual({
      ...sol,
      in: 2.5,
      long: { ...sol.long!, cacheRead: 0.5 }
    })
    // the output rate didn't change, so its date doesn't count
    expect(since).toBe(day('2026-09-01'))
    expect(sol.in).toBe(2) // the price it started from is untouched
  })

  it('leaves a price alone when nothing differs', () => {
    const { price, since } = mergeRates(sol, { short: { in: rate(2) }, long: { in: rate(4) } })
    expect(price).toEqual(sol)
    expect(since).toBeNull()
  })

  it('adds a cache-write rate the price lacked, but never invents a long tier', () => {
    const gpt55 = specFor('gpt-5.5')!.price
    const { price } = mergeRates(gpt55, { short: { cacheWrite: rate(6.25) }, long: {} })
    expect(price.cacheWrite).toBe(6.25)
    const mini = specFor('gpt-5.4-mini')!.price
    expect(mergeRates(mini, { short: {}, long: { in: rate(1.5) } }).price).toEqual(mini)
  })
})
