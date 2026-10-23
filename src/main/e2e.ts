// Hooks for the end-to-end tests (e2e/). Everything here does nothing unless
// Orcha was started with --orcha-e2e, which only the test fixture passes.

export const isE2e: boolean = process.argv.includes('--orcha-e2e')

export type E2eEndpointKind = 'anthropic' | 'azure' | 'ollama'

const ENV: Record<E2eEndpointKind, string> = {
  anthropic: 'ORCHA_E2E_ANTHROPIC_URL',
  azure: 'ORCHA_E2E_AZURE_URL',
  ollama: 'ORCHA_E2E_OLLAMA_URL'
}

// Where a provider should send its requests instead of the real service, or
// null to use the real one. Only honoured under --orcha-e2e and only for a
// loopback http address, so a stray variable can never redirect real traffic
// (or a real key) to another machine.
export function e2eEndpoint(kind: E2eEndpointKind): string | null {
  if (!isE2e) return null
  const raw = process.env[ENV[kind]]
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

// A fetch that sends what was meant for `real` (an origin, like the owner's
// Azure endpoint) to the test's fake server instead; plain fetch otherwise.
export function e2eFetch(kind: E2eEndpointKind, real: string): typeof fetch {
  const fake = e2eEndpoint(kind)
  if (!fake) return fetch
  const from = real.replace(/\/+$/, '')
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const to = url.startsWith(from) ? fake + url.slice(from.length) : url
    return fetch(input instanceof Request ? new Request(to, input) : to, init)
  }
}
