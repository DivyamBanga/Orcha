import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MODEL_SPECS, specFor, type Price } from '../../shared/models'
import { NO_USAGE, type TokenUsage } from '../chat/provider'
import { fakeRetailApi, retailItems } from './azureRetail.fixture'
import {
  addPrice,
  costOf,
  PRICE_SCHEMA,
  priceAt,
  refreshAzurePrices,
  seedPrices,
  type FetchLike
} from './pricing'

const usage = (over: Partial<TokenUsage>): TokenUsage => ({ ...NO_USAGE, ...over })
const price = (id: string): Price => specFor(id)!.price

describe('what a call costs', () => {
  it('charges Opus 5.5 one-hour cache writes at twice input, not 1.25 times', () => {
    // 1,000 fresh + 200,000 cache reads + 10,000 five-minute writes
    // + 50,000 one-hour writes + 8,000 out, at $4 / $0.20 / $5 / $8 / $20 per million
    const call = usage({
      input: 1_000,
      cacheRead: 200_000,
      cacheWrite5m: 10_000,
      cacheWrite1h: 50_000,
      output: 8_000,
      reasoning: 3_000
    })
    expect(costOf(price('claude-opus-5-5'), call)).toBeCloseTo(0.654, 9)
  })

  it('prices the week measured on this machine at $145.70, not the old $264.03', () => {
    // 876 Claude Code calls on Opus 5.5, 100% one-hour cache writes (research, 2026-10-22)
    const week = usage({
      input: 1_758,
      output: 1_479_958,
      cacheRead: 396_572_221,
      cacheWrite1h: 4_597_123
    })
    expect(costOf(price('claude-opus-5-5'), week)).toBeCloseTo(145.6976, 4)
    // the old estimator used Opus 4 rates ($5 / $25 / $0.50 read) and charged
    // every cache write $6.25, though these were all one-hour writes
    const old = { in: 5, out: 25, cacheRead: 0.5, cacheWrite1h: 6.25 }
    expect(costOf(old, week)).toBeCloseTo(264.0259, 4)
  })

  it('reprices a whole Haiku 5.5 call once its prompt is over 100,000 tokens', () => {
    const haiku = price('claude-haiku-5-5')
    // 80,000 prompt tokens: $0.10 in, $0.01 cached, $0.50 out
    const short = usage({ input: 60_000, cacheRead: 20_000, output: 2_000 })
    expect(costOf(haiku, short)).toBeCloseTo(0.0072, 9)
    // 110,000 prompt tokens (cache reads count): $0.50, $0.05, $2.50 on all of it
    const long = usage({ input: 90_000, cacheRead: 20_000, output: 2_000 })
    expect(costOf(haiku, long)).toBeCloseTo(0.051, 9)
  })

  it('moves to the long tier just past 100,000, not at 100,000', () => {
    const haiku = price('claude-haiku-5-5')
    const at = (input: number): number => costOf(haiku, usage({ input }))
    expect(at(100_000)).toBeCloseTo(0.01, 9)
    expect(at(100_001)).toBeCloseTo(100_001 * 0.5e-6, 9)
  })

  it('keeps the same cache-write multiples in the long tier', () => {
    // long input $0.50: 5-minute writes 1.25x ($0.625), one-hour writes 2x ($1)
    const call = usage({ input: 60_000, cacheWrite5m: 30_000, cacheWrite1h: 20_000 })
    expect(costOf(price('claude-haiku-5-5'), call)).toBeCloseTo(0.06875, 9)
  })

  it('reprices GPT-6 Sol long context, cache reads included, all at the long rates', () => {
    const sol = price('gpt-6-sol')
    // over 272,000 prompt tokens: $4 in, $15 out
    expect(costOf(sol, usage({ input: 300_000, output: 10_000 }))).toBeCloseTo(1.35, 9)
    // exactly 272,000 is still short: $2 in, $10 out
    expect(costOf(sol, usage({ input: 272_000, output: 10_000 }))).toBeCloseTo(0.644, 9)
    // cache reads count toward the line, and are $0.40 there
    expect(costOf(sol, usage({ input: 100_000, cacheRead: 180_000 }))).toBeCloseTo(0.472, 9)
  })

  it('uses the long tier when the provider says the call was long', () => {
    const sol = price('gpt-6-sol')
    const call = { input: 1_000, output: 100 }
    expect(costOf(sol, usage(call))).toBeCloseTo(0.003, 9)
    expect(costOf(sol, usage({ ...call, longContext: true }))).toBeCloseTo(0.0055, 9)
    // a model with no long tier has nothing to switch to
    const opus = price('claude-opus-5-5')
    expect(costOf(opus, usage({ ...call, longContext: true }))).toBe(costOf(opus, usage(call)))
  })

  it('charges GPT-6.1 Sol cache writes at 1.25x input and reads at $0.10', () => {
    const call = usage({ input: 10_000, cacheRead: 100_000, cacheWrite: 50_000, output: 2_000 })
    // 10,000 x $2 + 100,000 x $0.10 + 50,000 x $2.50 + 2,000 x $10
    expect(costOf(price('gpt-6.1-sol'), call)).toBeCloseTo(0.175, 9)
    // GPT-6 Sol reads cost $0.20
    expect(costOf(price('gpt-6-sol'), call)).toBeCloseTo(0.185, 9)
    // writes in the long tier: $5
    const long = usage({ input: 100_000, cacheWrite: 200_000 })
    expect(costOf(price('gpt-6.1-sol'), long)).toBeCloseTo(1.4, 9)
  })

  it('does not charge for cache writes on models before GPT-5.6', () => {
    const call = usage({ input: 10_000, cacheWrite: 50_000 })
    expect(costOf(price('gpt-5.5'), call)).toBeCloseTo(0.05, 9)
  })

  it('charges web searches per search: $10 per 1,000 on Claude, $14 on GPT', () => {
    const three = usage({ webSearches: 3 })
    expect(costOf(price('claude-sonnet-5-5'), three)).toBeCloseTo(0.03, 9)
    expect(costOf(price('gpt-6-sol'), three)).toBeCloseTo(0.042, 9)
    // naming the family settles it when the price alone can't
    expect(costOf(price('gpt-6-sol'), three, { family: 'claude' })).toBeCloseTo(0.03, 9)
    // searches come on top of tokens
    const both = usage({ input: 1_000, output: 1_000, webSearches: 2 })
    expect(costOf(price('claude-opus-5-5'), both)).toBeCloseTo(0.044, 9)
  })

  it('doubles every token rate in fast mode, but not the searches', () => {
    const opus = price('claude-opus-5-5')
    // Anthropic's fast-mode price for Opus 5.5 is $8 in, $40 out
    const million = usage({ input: 1_000_000, output: 1_000_000 })
    expect(costOf(opus, million)).toBeCloseTo(24, 9)
    expect(costOf(opus, million, { fast: true })).toBeCloseTo(48, 9)
    const call = usage({ cacheRead: 200_000, cacheWrite1h: 50_000, webSearches: 5 })
    expect(costOf(opus, call, { fast: true })).toBeCloseTo(2 * 0.44 + 0.05, 9)
  })

  it('counts reasoning once, inside output', () => {
    const opus = price('claude-opus-5-5')
    expect(costOf(opus, usage({ output: 8_000, reasoning: 8_000 }))).toBe(
      costOf(opus, usage({ output: 8_000 }))
    )
  })

  it('costs nothing for nothing', () => {
    for (const spec of MODEL_SPECS) expect(costOf(spec.price, usage({}))).toBe(0)
  })
})

function freshBook(): Database.Database {
  const db = new Database(':memory:')
  db.exec(PRICE_SCHEMA)
  return db
}

const rowCount = (db: Database.Database, model?: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM prices${model ? ' WHERE model = ?' : ''}`)
      .get(...(model ? [model] : [])) as { n: number }
  ).n

describe('the price book', () => {
  const NOW = Date.UTC(2026, 9, 22, 18)

  it('can be created twice', () => {
    const db = freshBook()
    db.exec(PRICE_SCHEMA)
    expect(rowCount(db)).toBe(0)
  })

  it('seeds every model once, from the beginning of time', () => {
    const db = freshBook()
    expect(seedPrices(db, NOW)).toBe(MODEL_SPECS.length)
    const row = priceAt(db, 'claude-opus-5-5', 0)!
    expect(row).toMatchObject({ effectiveFrom: 0, source: 'built-in', note: null })
    expect(row.price).toEqual(price('claude-opus-5-5'))
    // a second time adds nothing
    expect(seedPrices(db, NOW + 1000)).toBe(0)
    expect(rowCount(db)).toBe(MODEL_SPECS.length)
  })

  it('starts a new row now when a release changes a price, and keeps the old one', () => {
    const db = freshBook()
    const sol = price('gpt-6-sol')
    // what the previous release shipped
    addPrice(db, {
      model: 'gpt-6-sol',
      effectiveFrom: 0,
      price: { ...sol, out: 12 },
      source: 'built-in',
      note: null
    })
    seedPrices(db, NOW)
    expect(rowCount(db, 'gpt-6-sol')).toBe(2)
    expect(priceAt(db, 'gpt-6-sol', NOW - 1)?.price.out).toBe(12)
    const now = priceAt(db, 'gpt-6-sol', NOW)!
    expect(now.price.out).toBe(10)
    expect(now.effectiveFrom).toBe(NOW)
    expect(now.note).toBe('Built-in price updated: output $12 → $10')
  })

  it('does not overwrite a newer Azure price with an unchanged built-in one', () => {
    const db = freshBook()
    seedPrices(db, NOW)
    const sol = price('gpt-6-sol')
    addPrice(db, {
      model: 'gpt-6-sol',
      effectiveFrom: NOW + 5,
      price: { ...sol, out: 11 },
      source: 'azure-retail',
      note: 'test'
    })
    expect(seedPrices(db, NOW + 10)).toBe(0)
    expect(priceAt(db, 'gpt-6-sol', NOW + 10)?.price.out).toBe(11)
  })

  it('finds the row in force at a moment, the later one on a tie', () => {
    const db = freshBook()
    const base = price('gpt-6-sol')
    const add = (effectiveFrom: number, out: number): number =>
      addPrice(db, {
        model: 'gpt-6-sol',
        effectiveFrom,
        price: { ...base, out },
        source: 'manual',
        note: null
      })
    const first = add(100, 1)
    add(200, 2)
    const last = add(200, 3)
    expect(priceAt(db, 'gpt-6-sol', 99)).toBeNull()
    expect(priceAt(db, 'gpt-6-sol', 100)?.id).toBe(first)
    expect(priceAt(db, 'gpt-6-sol', 199)?.price.out).toBe(1)
    expect(priceAt(db, 'gpt-6-sol', 200)?.id).toBe(last)
    expect(priceAt(db, 'gpt-6-sol', 1e15)?.price.out).toBe(3)
    expect(priceAt(db, 'someone-elses-model', 1e15)).toBeNull()
  })
})

describe('checking Azure for new prices', () => {
  const NOW = Date.UTC(2026, 9, 22, 18)
  const noWait = async (): Promise<void> => {}

  function seeded(): Database.Database {
    const db = freshBook()
    seedPrices(db, NOW - 1000)
    return db
  }

  // Azure's list with a few prices changed.
  function repriced(changes: Record<string, number>): ReturnType<typeof retailItems> {
    const items = retailItems()
    for (const [meter, usd] of Object.entries(changes)) {
      const item = items.find((i) => i.meterName === meter)
      if (!item) throw new Error(`no such meter in the fixture: ${meter}`)
      item.retailPrice = usd
    }
    return items
  }

  it('adds nothing when Azure agrees with the book', async () => {
    const db = seeded()
    const before = rowCount(db)
    const api = fakeRetailApi(retailItems())
    const changes = await refreshAzurePrices(db, api.fetch, { now: NOW, sleep: noWait })
    expect(changes).toEqual([])
    expect(rowCount(db)).toBe(before)
    expect(api.urls).toHaveLength(1) // the whole list is one page
  })

  it('adds a row for each model Azure now prices differently, and reports it', async () => {
    const db = seeded()
    const before = rowCount(db)
    const items = repriced({
      '6-sol ShortCo Inp Std Gl 1M Tokens': 2.5,
      '6-sol LongCo Inp Std Gl 1M Tokens': 5,
      '6.1-sol ShortCo Cd Inp Std Gl 1M Tokens': 0.05
    })
    const changes = await refreshAzurePrices(db, fakeRetailApi(items).fetch, {
      now: NOW,
      sleep: noWait
    })
    expect(changes.map((c) => c.model).sort()).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
    expect(rowCount(db)).toBe(before + 2)

    const sol = changes.find((c) => c.model === 'gpt-6-sol')!
    expect(sol.before).toEqual(price('gpt-6-sol'))
    expect(sol.after).toEqual({
      ...price('gpt-6-sol'),
      in: 2.5,
      long: { ...price('gpt-6-sol').long!, in: 5 }
    })
    // Azure's list has these prices from 2026-09-01
    expect(sol.effectiveFrom).toBe(Date.UTC(2026, 8, 1))
    expect(sol.note).toBe(
      'Azure retail price, per million tokens: input $2 → $2.5, ' +
        'long-context input $4 → $5 (listed from 2026-09-01)'
    )

    const row = priceAt(db, 'gpt-6-sol', NOW)!
    expect(row).toMatchObject({
      source: 'azure-retail',
      note: sol.note,
      effectiveFrom: sol.effectiveFrom
    })
    expect(row.price).toEqual(sol.after)
    // before the new price began, the old one still answers
    expect(priceAt(db, 'gpt-6-sol', Date.UTC(2026, 7, 31))?.source).toBe('built-in')
    expect(priceAt(db, 'gpt-6.1-sol', NOW)?.price.cacheRead).toBe(0.05)
  })

  it('reports a change once', async () => {
    const db = seeded()
    const api = fakeRetailApi(repriced({ '6-sol ShortCo Opt Std Gl 1M Tokens': 11 }))
    const first = await refreshAzurePrices(db, api.fetch, { now: NOW, sleep: noWait })
    const again = await refreshAzurePrices(db, api.fetch, { now: NOW, sleep: noWait, force: true })
    expect(first).toHaveLength(1)
    expect(again).toEqual([])
    expect(rowCount(db, 'gpt-6-sol')).toBe(2)
  })

  it('lets a change win over a newer built-in row, and never begins in the future', async () => {
    const db = seeded()
    const sol = price('gpt-6-sol')
    // this release's built-in output price ($11) came after Azure's listing date
    addPrice(db, {
      model: 'gpt-6-sol',
      effectiveFrom: NOW - 500,
      price: { ...sol, out: 11 },
      source: 'built-in',
      note: 'test'
    })
    const [change] = await refreshAzurePrices(db, fakeRetailApi(retailItems()).fetch, {
      now: NOW,
      sleep: noWait
    })
    expect(change.effectiveFrom).toBe(NOW - 500)
    expect(priceAt(db, 'gpt-6-sol', NOW)?.price.out).toBe(10)

    // a date Azure lists in the future counts from now instead
    const db2 = seeded()
    const items = repriced({ '6-sol ShortCo Opt Std Gl 1M Tokens': 12 })
    for (const item of items) item.effectiveStartDate = '2099-01-01T00:00:00Z'
    const [soon] = await refreshAzurePrices(db2, fakeRetailApi(items).fetch, {
      now: NOW,
      sleep: noWait
    })
    expect(soon.effectiveFrom).toBe(NOW)
  })

  it('works on a book that was never seeded, and seeding later changes nothing', async () => {
    const db = freshBook()
    const items = repriced({ '6-sol ShortCo Opt Std Gl 1M Tokens': 12 })
    const changes = await refreshAzurePrices(db, fakeRetailApi(items).fetch, {
      now: NOW,
      sleep: noWait
    })
    expect(changes).toHaveLength(1)
    expect(changes[0].before).toBeNull()
    seedPrices(db, NOW + 1)
    expect(priceAt(db, 'gpt-6-sol', NOW + 2)?.price.out).toBe(12)
    expect(priceAt(db, 'gpt-6-sol', 0)?.source).toBe('built-in')
  })

  it('asks Azure with one query and follows its links to later pages, pausing between', async () => {
    const db = seeded()
    const items = retailItems()
    const api = fakeRetailApi(items, 60) // short pages, so there is something to follow
    const waits: number[] = []
    await refreshAzurePrices(db, api.fetch, {
      now: NOW,
      sleep: async (ms) => void waits.push(ms)
    })
    const pages = Math.ceil(items.length / 60)
    expect(api.urls).toHaveLength(pages)
    expect(pages).toBeGreaterThan(2)
    expect(waits).toEqual(new Array(pages - 1).fill(2000))

    const first = new URL(api.urls[0])
    expect(first.origin + first.pathname).toBe('https://prices.azure.com/api/retail/prices')
    expect(first.searchParams.get('api-version')).toBe('2023-01-01-preview')
    const filter = first.searchParams.get('$filter')
    expect(filter).toBe(
      "serviceName eq 'Foundry Models' and contains(productName, 'Azure OpenAI') " +
        "and armRegionName eq 'eastus2' and priceType eq 'Consumption' " +
        "and (contains(meterName, 'Gl') or contains(meterName, 'gl'))"
    )
    // later pages are the links Azure gave: the same query, further down the list
    api.urls.slice(1).forEach((url, i) => {
      const page = new URL(url)
      expect(page.origin + page.pathname).toBe('https://prices.azure.com/api/retail/prices')
      expect(page.searchParams.get('$filter')).toBe(filter)
      expect(page.searchParams.get('$skip')).toBe(String((i + 1) * 60))
    })
  })

  it('backs off when Azure says to slow down', async () => {
    const throttled = (headers?: Record<string, string>): Response =>
      new Response('Too many requests at this point. Please retry after some time.', {
        status: 429,
        headers
      })
    const api = fakeRetailApi(retailItems())
    let calls = 0
    const flaky: FetchLike = async (url, init) => {
      calls++
      if (calls === 1) return throttled({ 'retry-after': '60' })
      if (calls === 2) return throttled()
      if (calls === 3) return throttled()
      return api.fetch(url, init)
    }
    const waits: number[] = []
    await refreshAzurePrices(seeded(), flaky, {
      now: NOW,
      sleep: async (ms) => void waits.push(ms)
    })
    // The first time Azure asked for 60 seconds. With no instruction the wait starts
    // at 8 seconds and doubles with each try, so it is 16 s on the second try, 32 s on the third.
    expect(waits).toEqual([60_000, 16_000, 32_000])
    expect(calls).toBe(4)
  })

  it('gives up after repeated throttling, with the book untouched', async () => {
    const db = seeded()
    const before = rowCount(db)
    let calls = 0
    const always: FetchLike = async () => {
      calls++
      return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } })
    }
    await expect(refreshAzurePrices(db, always, { now: NOW, sleep: noWait })).rejects.toThrow(
      'Azure is limiting price checks right now. Try again in a few minutes.'
    )
    expect(calls).toBe(5)
    expect(rowCount(db)).toBe(before)
  })

  it('reuses its last answer for a day unless told to ask again', async () => {
    const db = seeded()
    const api = fakeRetailApi(retailItems())
    const ask = (over: { now?: number; force?: boolean }): ReturnType<typeof refreshAzurePrices> =>
      refreshAzurePrices(db, api.fetch, { sleep: noWait, now: NOW, ...over })
    await ask({})
    expect(api.urls).toHaveLength(1)
    await ask({ now: NOW + 23 * 3_600_000 })
    expect(api.urls).toHaveLength(1)
    await ask({ now: NOW + 1000, force: true })
    expect(api.urls).toHaveLength(2)
    await ask({ now: NOW + 25 * 3_600_000 })
    expect(api.urls).toHaveLength(3)
  })

  it('refuses a next page that is not on Azure', async () => {
    const db = seeded()
    const before = rowCount(db)
    const stray: FetchLike = async () =>
      new Response(
        JSON.stringify({ Items: retailItems(), NextPageLink: 'https://example.com/prices?$skip=1' })
      )
    await expect(refreshAzurePrices(db, stray, { now: NOW, sleep: noWait })).rejects.toThrow(
      "Azure's price list came back in a form Orcha couldn't read."
    )
    expect(rowCount(db)).toBe(before)
  })

  it('says what went wrong in plain words and changes nothing', async () => {
    const attempt = async (fetchFn: FetchLike): Promise<string> => {
      const db = seeded()
      const before = rowCount(db)
      const error = await refreshAzurePrices(db, fetchFn, { now: NOW, sleep: noWait }).then(
        () => 'it worked',
        (e: Error) => e.message
      )
      expect(rowCount(db)).toBe(before)
      return error
    }
    expect(
      await attempt(async () => {
        throw new TypeError('fetch failed')
      })
    ).toBe("Couldn't reach Azure's price list. Check the connection and try again.")
    expect(await attempt(async () => new Response('', { status: 503 }))).toBe(
      "Azure's price list isn't answering right now (error 503)."
    )
    const unreadable = "Azure's price list came back in a form Orcha couldn't read."
    expect(await attempt(async () => new Response('<html>maintenance</html>'))).toBe(unreadable)
    expect(await attempt(async () => new Response(JSON.stringify({ Items: 'none' })))).toBe(
      unreadable
    )
    // a list with nothing Orcha can read in it
    const nothing = fakeRetailApi([
      { meterName: 'Live 1 Gl', retailPrice: 3, unitOfMeasure: '1 Hour' }
    ])
    expect(await attempt(nothing.fetch)).toBe(
      "Azure's price list had no GPT prices Orcha could read, so nothing changed."
    )
  })
})
