import type { RetailItem } from './azureMeters'
import type { FetchLike } from './pricing'

// Rows of Azure's public Retail Prices list, recorded from prices.azure.com on
// 2026-10-22 (Foundry Models, the Azure OpenAI products, eastus2, pay-as-you-go),
// then cut down to the GPT chat models Orcha knows plus a sample of the rows it
// has to skip: Data Zone, Flex, Priority and Batch prices, regional and
// fine-tuning meters, other models, audio and images, and prices per hour.
// (The app asks Azure for Global meters only, but the reader doesn't rely on
// that.) Meter names are exactly as Azure spells them, inconsistencies and all
// ('Inpt', 'cchd', 'LoCo', '56sol'). The whole list is about 1,400 rows.
//
// Each row: [meter name, product, USD price, unit, first day of that price].
type Row = [string, string, number, string, string]

const GPT6 = 'Azure OpenAI GPT6'
const GPT5 = 'Azure OpenAI GPT5'
const OLDER = 'Azure OpenAI'

const ROWS: Row[] = [
  ['6-astra LongCo Cd Inp Std Gl 1M Tokens', GPT6, 2, '1M', '2026-09-01'],
  ['6-astra LongCo Cd Wr Std Gl 1M Tokens', GPT6, 25, '1M', '2026-09-01'],
  ['6-astra LongCo Inp Std Gl 1M Tokens', GPT6, 20, '1M', '2026-09-01'],
  ['6-astra LongCo Opt Std Gl 1M Tokens', GPT6, 75, '1M', '2026-09-01'],
  ['6-astra ShortCo Cd Inp Std Gl 1M Tokens', GPT6, 1, '1M', '2026-09-01'],
  ['6-astra ShortCo Cd Wr Std Gl 1M Tokens', GPT6, 12.5, '1M', '2026-09-01'],
  ['6-astra ShortCo Inp Std Gl 1M Tokens', GPT6, 10, '1M', '2026-09-01'],
  ['6-astra ShortCo Opt Std Gl 1M Tokens', GPT6, 50, '1M', '2026-09-01'],
  ['6-luna LongCo Cd Inp Std Gl 1M Tokens', GPT6, 0.02, '1M', '2026-09-01'],
  ['6-luna LongCo Cd Wr Std Gl 1M Tokens', GPT6, 0.25, '1M', '2026-09-01'],
  ['6-luna LongCo Inp Std Gl 1M Tokens', GPT6, 0.2, '1M', '2026-09-01'],
  ['6-luna LongCo Opt Std Gl 1M Tokens', GPT6, 0.75, '1M', '2026-09-01'],
  ['6-luna ShortCo Cd Inp Std Gl 1M Tokens', GPT6, 0.01, '1M', '2026-09-01'],
  ['6-luna ShortCo Cd Wr Std Gl 1M Tokens', GPT6, 0.125, '1M', '2026-09-01'],
  ['6-luna ShortCo Inp Std Gl 1M Tokens', GPT6, 0.1, '1M', '2026-09-01'],
  ['6-luna ShortCo Opt Std Gl 1M Tokens', GPT6, 0.5, '1M', '2026-09-01'],
  ['6-sol LongCo Cd Inp Std Gl 1M Tokens', GPT6, 0.4, '1M', '2026-09-01'],
  ['6-sol LongCo Cd Wr Std Gl 1M Tokens', GPT6, 5, '1M', '2026-09-01'],
  ['6-sol LongCo Inp Std Gl 1M Tokens', GPT6, 4, '1M', '2026-09-01'],
  ['6-sol LongCo Opt Std Gl 1M Tokens', GPT6, 15, '1M', '2026-09-01'],
  ['6-sol ShortCo Cd Inp Std Gl 1M Tokens', GPT6, 0.2, '1M', '2026-09-01'],
  ['6-sol ShortCo Cd Wr PP Gl 1M Tokens', GPT6, 5, '1M', '2026-09-01'],
  ['6-sol ShortCo Cd Wr Std Gl 1M Tokens', GPT6, 2.5, '1M', '2026-09-01'],
  ['6-sol ShortCo Inp Flex Gl 1M Tokens', GPT6, 1, '1M', '2026-10-01'],
  ['6-sol ShortCo Inp PP Gl 1M Tokens', GPT6, 4, '1M', '2026-09-01'],
  ['6-sol ShortCo Inp Std DZ 1M Tokens', GPT6, 2.2, '1M', '2026-09-01'],
  ['6-sol ShortCo Inp Std Gl 1M Tokens', GPT6, 2, '1M', '2026-09-01'],
  ['6-sol ShortCo Opt Std Gl 1M Tokens', GPT6, 10, '1M', '2026-09-01'],
  ['6.1-sol LongCo Cd Inp Std Gl 1M Tokens', GPT6, 0.2, '1M', '2026-10-01'],
  ['6.1-sol LongCo Cd Wr Std Gl 1M Tokens', GPT6, 5, '1M', '2026-10-01'],
  ['6.1-sol LongCo Inp Std Gl 1M Tokens', GPT6, 4, '1M', '2026-10-01'],
  ['6.1-sol LongCo Opt Std Gl 1M Tokens', GPT6, 15, '1M', '2026-10-01'],
  ['6.1-sol ShortCo Cd Inp Std Gl 1M Tokens', GPT6, 0.1, '1M', '2026-10-01'],
  ['6.1-sol ShortCo Cd Wr Std Gl 1M Tokens', GPT6, 2.5, '1M', '2026-10-01'],
  ['6.1-sol ShortCo Inp Std Gl 1M Tokens', GPT6, 2, '1M', '2026-10-01'],
  ['6.1-sol ShortCo Opt Std Gl 1M Tokens', GPT6, 10, '1M', '2026-10-01'],
  ['chat-latest 10072026 cd inp Gl 1M Tokens', GPT6, 0.5, '1M', '2026-10-01'],
  ['chat-latest 10072026 inp Gl 1M Tokens', GPT6, 5, '1M', '2026-10-01'],
  ['chat-latest 10072026 opt Gl 1M Tokens', GPT6, 30, '1M', '2026-10-01'],
  ['5.4 Batch inp Gl 1M Tokens', GPT5, 1.25, '1M', '2026-03-01'],
  ['5.4 cd inp Gl 1M Tokens', GPT5, 0.25, '1M', '2026-03-01'],
  ['5.4 inp Gl 1M Tokens', GPT5, 2.5, '1M', '2026-03-01'],
  ['5.4 longco cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-03-01'],
  ['5.4 longco inp Gl 1M Tokens', GPT5, 5, '1M', '2026-03-01'],
  ['5.4 longco opt Gl 1M Tokens', GPT5, 22.5, '1M', '2026-03-01'],
  ['5.4 mini cd Inp Gl 1M Tokens', GPT5, 0.075, '1M', '2026-03-01'],
  ['5.4 mini Inp Gl 1M Tokens', GPT5, 0.75, '1M', '2026-03-01'],
  ['5.4 mini Opt Gl 1M Tokens', GPT5, 4.5, '1M', '2026-03-01'],
  ['5.4 nano cd Inp Gl 1M Tokens', GPT5, 0.02, '1M', '2026-03-01'],
  ['5.4 nano Inp Gl 1M Tokens', GPT5, 0.2, '1M', '2026-03-01'],
  ['5.4 nano Opt Gl 1M Tokens', GPT5, 1.25, '1M', '2026-03-01'],
  ['5.4 opt Gl 1M Tokens', GPT5, 15, '1M', '2026-03-01'],
  ['5.4 pp inp Gl 1M Tokens', GPT5, 5, '1M', '2026-03-01'],
  ['5.4 pro inp Gl 1M Tokens', GPT5, 30, '1M', '2026-03-01'],
  ['5.5 LongCo cd inp Gl 1M Tokens', GPT5, 1, '1M', '2026-05-01'],
  ['5.5 LongCo inp Gl 1M Tokens', GPT5, 10, '1M', '2026-05-01'],
  ['5.5 LongCo opt Gl 1M Tokens', GPT5, 45, '1M', '2026-05-01'],
  ['5.5 ShortCo cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-05-01'],
  ['5.5 ShortCo inp Gl 1M Tokens', GPT5, 5, '1M', '2026-05-01'],
  ['5.5 ShortCo opt Gl 1M Tokens', GPT5, 30, '1M', '2026-05-01'],
  ['5.5 ShortCo PP inp Gl 1M Tokens', GPT5, 12.5, '1M', '2026-05-01'],
  ['5.6 luna LongCo Cd Inp Std Gl 1M Tokens', GPT5, 0.04, '1M', '2026-08-01'],
  ['5.6 luna LongCo Cd Wr Std Gl 1M Tokens', GPT5, 0.5, '1M', '2026-08-01'],
  ['5.6 luna LongCo Inp Std Gl 1M Tokens', GPT5, 0.4, '1M', '2026-08-01'],
  ['5.6 luna LongCo Opt Std Gl 1M Tokens', GPT5, 1.8, '1M', '2026-08-01'],
  ['5.6 luna ShortCo Cd Inp Std Gl 1M Tokens', GPT5, 0.02, '1M', '2026-08-01'],
  ['5.6 luna ShortCo Cd Wr Std Gl 1M Tokens', GPT5, 0.25, '1M', '2026-08-01'],
  ['5.6 luna ShortCo Inp Std Gl 1M Tokens', GPT5, 0.2, '1M', '2026-08-01'],
  ['5.6 luna ShortCo Opt Std Gl 1M Tokens', GPT5, 1.2, '1M', '2026-08-01'],
  ['5.6 sol LongCo Cd Inp Std Gl 1M Tokens', GPT5, 0.8, '1M', '2026-09-01'],
  ['5.6 sol LongCo Cd Wr Std Gl 1M Tokens', GPT5, 10, '1M', '2026-09-01'],
  ['5.6 sol LongCo Inp Std Gl 1M Tokens', GPT5, 8, '1M', '2026-09-01'],
  ['5.6 sol LongCo Opt Std Gl 1M Tokens', GPT5, 30, '1M', '2026-09-01'],
  ['5.6 sol ShortCo Cd Inp Std Gl 1M Tokens', GPT5, 0.4, '1M', '2026-09-01'],
  ['5.6 sol ShortCo Cd Wr Std Gl 1M Tokens', GPT5, 5, '1M', '2026-09-01'],
  ['5.6 sol ShortCo Inp Std Gl 1M Tokens', GPT5, 4, '1M', '2026-09-01'],
  ['5.6 sol ShortCo Opt Std Gl 1M Tokens', GPT5, 20, '1M', '2026-09-01'],
  ['5.6 terra LongCo Cd Inp Std Gl 1M Tokens', GPT5, 0.4, '1M', '2026-08-01'],
  ['5.6 terra LongCo Cd Wr Std Gl 1M Tokens', GPT5, 5, '1M', '2026-08-01'],
  ['5.6 terra LongCo Inp Std Gl 1M Tokens', GPT5, 4, '1M', '2026-08-01'],
  ['5.6 terra LongCo Opt Std Gl 1M Tokens', GPT5, 18, '1M', '2026-08-01'],
  ['5.6 terra ShortCo Cd Inp Std Gl 1M Tokens', GPT5, 0.2, '1M', '2026-08-01'],
  ['5.6 terra ShortCo Cd Wr Std Gl 1M Tokens', GPT5, 2.5, '1M', '2026-08-01'],
  ['5.6 terra ShortCo Inp Std Gl 1M Tokens', GPT5, 2, '1M', '2026-08-01'],
  ['5.6 terra ShortCo Opt Std Gl 1M Tokens', GPT5, 12, '1M', '2026-08-01'],
  ['54 inp Flex Gl 1M Tokens', GPT5, 1.25, '1M', '2026-09-01'],
  ['54 longco inp Flex Gl 1M Tokens', GPT5, 2.5, '1M', '2026-09-01'],
  ['56sol ShCo Inp Fl Gl 1M Tokens', GPT5, 2, '1M', '2026-09-01'],
  ['chat-latest 05052026 cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-05-01'],
  ['chat-latest 05052026 inp Gl 1M Tokens', GPT5, 5, '1M', '2026-05-01'],
  ['chat-latest 05052026 opt Gl 1M Tokens', GPT5, 30, '1M', '2026-05-01'],
  ['chat-latest 05282026 cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-06-01'],
  ['chat-latest 05282026 inp Gl 1M Tokens', GPT5, 5, '1M', '2026-06-01'],
  ['chat-latest 05282026 opt Gl 1M Tokens', GPT5, 30, '1M', '2026-06-01'],
  ['chat-latest 07012026 cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-08-01'],
  ['chat-latest 07012026 inp Gl 1M Tokens', GPT5, 5, '1M', '2026-08-01'],
  ['chat-latest 07012026 opt Gl 1M Tokens', GPT5, 30, '1M', '2026-08-01'],
  ['chat-latest 08062026 cd inp Gl 1M Tokens', GPT5, 0.5, '1M', '2026-08-01'],
  ['chat-latest 08062026 inp Gl 1M Tokens', GPT5, 5, '1M', '2026-08-01'],
  ['chat-latest 08062026 opt Gl 1M Tokens', GPT5, 30, '1M', '2026-08-01'],
  ['GPT 5 Batch Inpt Glbl 1M Tokens', GPT5, 0.625, '1M', '2025-08-01'],
  ['GPT 5 cchd Inpt Glbl 1M Tokens', GPT5, 0.125, '1M', '2025-08-01'],
  ['GPT 5 Chat Inpt Glbl 1M Tokens', GPT5, 1.25, '1M', '2025-08-01'],
  ['GPT 5 Inpt Glbl 1M Tokens', GPT5, 1.25, '1M', '2025-08-01'],
  ['GPT 5 Mini cchd Inpt Glbl 1M Tokens', GPT5, 0.025, '1M', '2025-08-01'],
  ['GPT 5 Mini Inpt Glbl 1M Tokens', GPT5, 0.25, '1M', '2025-08-01'],
  ['GPT 5 Mini outpt Glbl 1M Tokens', GPT5, 2, '1M', '2025-08-01'],
  ['GPT 5 Nano cchd Inpt Glbl 1M Tokens', GPT5, 0.005, '1M', '2025-08-01'],
  ['GPT 5 Nano Inpt Glbl 1M Tokens', GPT5, 0.05, '1M', '2025-08-01'],
  ['GPT 5 Nano outpt Glbl 1M Tokens', GPT5, 0.4, '1M', '2025-08-01'],
  ['GPT 5 outpt Glbl 1M Tokens', GPT5, 10, '1M', '2025-08-01'],
  ['gpt 5 pro inp glbl Tokens', GPT5, 0.015, '1K', '2025-10-01'],
  ['GPT 5.1 cd inp Gl 1M Tokens', GPT5, 0.125, '1M', '2025-11-01'],
  ['GPT 5.1 inp Gl 1M Tokens', GPT5, 1.25, '1M', '2025-11-01'],
  ['GPT 5.1 opt Gl 1M Tokens', GPT5, 10, '1M', '2025-11-01'],
  ['GPT 5.2 cd inp Gl 1M Tokens', GPT5, 0.175, '1M', '2025-12-01'],
  ['GPT 5.2 inp Gl 1M Tokens', GPT5, 1.75, '1M', '2025-12-01'],
  ['GPT 5.2 opt Gl 1M Tokens', GPT5, 14, '1M', '2025-12-01'],
  ['gpt-5-codex-inp-glbl Tokens', GPT5, 0.00125, '1K', '2025-09-01'],
  ['gpt 4.1 Batch Inp glbl Tokens', OLDER, 0.001, '1K', '2025-04-01'],
  ['gpt 4.1 cached Inp glbl Tokens', OLDER, 0.0005, '1K', '2025-04-01'],
  ['gpt 4.1 dev ft training glbl Tokens', OLDER, 0.0125, '1K', '2025-12-01'],
  ['gpt 4.1 Inp glbl Tokens', OLDER, 0.002, '1K', '2025-04-01'],
  ['gpt 4.1 mini cached Inp glbl Tokens', OLDER, 0.0001, '1K', '2025-04-01'],
  ['gpt 4.1 mini Inp glbl Tokens', OLDER, 0.0004, '1K', '2025-04-01'],
  ['gpt 4.1 mini Inp regnl Tokens', OLDER, 0.00044, '1K', '2025-11-01'],
  ['gpt 4.1 mini Outp glbl Tokens', OLDER, 0.0016, '1K', '2025-04-01'],
  ['gpt 4.1 nano cached Inp glbl Tokens', OLDER, 0.000025, '1K', '2025-04-01'],
  ['gpt 4.1 nano Inp glbl Tokens', OLDER, 0.0001, '1K', '2025-04-01'],
  ['gpt 4.1 nano Outp glbl Tokens', OLDER, 0.0004, '1K', '2025-04-01'],
  ['gpt 4.1 Outp glbl Tokens', OLDER, 0.008, '1K', '2025-04-01'],
  ['gpt 4o 0513 Input global Tokens', OLDER, 0.005, '1K', '2024-07-01'],
  ['gpt 4o 0513 Output global Tokens', OLDER, 0.015, '1K', '2024-07-01'],
  ['gpt 4o 0806 cached Inp glbl Tokens', OLDER, 0.00125, '1K', '2024-10-01'],
  ['gpt 4o 1120 cached Inp glbl Tokens', OLDER, 0.00125, '1K', '2024-12-01'],
  ['gpt 4o 1120 Inp glbl Tokens', OLDER, 0.0025, '1K', '2024-12-01'],
  ['gpt 4o 1120 Outp glbl Tokens', OLDER, 0.01, '1K', '2024-12-01'],
  ['gpt 4o mini 0718 cached Inp glbl Tokens', OLDER, 0.000075, '1K', '2024-10-01'],
  ['gpt-4.1-ft input global Tokens', OLDER, 0.002, '1K', '2025-04-01'],
  ['gpt-4o-0806-Inp-glbl Tokens', OLDER, 0.0025, '1K', '2024-08-01'],
  ['gpt-4o-0806-Outp-glbl Tokens', OLDER, 0.01, '1K', '2024-08-01'],
  ['gpt-4o-mini-0718-Inp-glbl Tokens', OLDER, 0.00015, '1K', '2024-07-01'],
  ['gpt-4o-mini-0718-Outp-glbl Tokens', OLDER, 0.0006, '1K', '2024-07-01'],
  ['gpt-4o-transcribe-txt-inp-glbl Tokens', OLDER, 0.0025, '1K', '2025-04-01'],
  ['o3 0416 Inp glbl Tokens', OLDER, 0.002, '1K', '2025-06-01'],
  ['gpt img 1.5 in txt gl 1M Tokens', 'Azure OpenAI Media', 5, '1M', '2025-12-01'],
  ['GPT OSS 120b RFT Gl Unit', 'Azure OpenAI OSS Models', 80, '1 Hour', '2026-10-01']
]

// A row as the API returns it: everything but the five recorded values is the
// same on every row of this query.
export interface RecordedItem extends RetailItem {
  productName: string
  serviceName: string
  armRegionName: string
  currencyCode: string
  tierMinimumUnits: number
  type: string
}

export function retailItems(): RecordedItem[] {
  return ROWS.map(([meterName, productName, retailPrice, unitOfMeasure, day]) => ({
    currencyCode: 'USD',
    tierMinimumUnits: 0,
    retailPrice,
    armRegionName: 'eastus2',
    effectiveStartDate: `${day}T00:00:00Z`,
    meterName,
    productName,
    serviceName: 'Foundry Models',
    unitOfMeasure,
    type: 'Consumption'
  }))
}

// How Azure writes the link to the next page: the port spelled out, every quote
// and bracket percent-encoded, and $skip added at the end.
function nextLink(firstUrl: string, skip: number): string {
  const filter = new URL(firstUrl).searchParams.get('$filter') ?? ''
  const encoded = encodeURIComponent(filter).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `https://prices.azure.com:443/api/retail/prices?api-version=2023-01-01-preview&$filter=${encoded}&$skip=${skip}`
}

// Stands in for fetch: serves the items a page at a time the way the API does
// (each page links to the next, the last links to nothing), and remembers
// every URL that was asked for.
export function fakeRetailApi(
  items: readonly RetailItem[],
  pageSize = 1000
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = []
  const serve: FetchLike = async (url) => {
    urls.push(url)
    const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] ?? 0)
    const next = skip + pageSize
    const body = {
      BillingCurrency: 'USD',
      CustomerEntityId: 'Default',
      CustomerEntityType: 'Retail',
      Items: items.slice(skip, next),
      NextPageLink: next < items.length ? nextLink(urls[0], next) : null,
      Count: Math.min(pageSize, items.length - skip)
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  return { fetch: serve, urls }
}
