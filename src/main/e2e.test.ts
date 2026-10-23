import { afterEach, describe, expect, it, vi } from 'vitest'

// isE2e is read once at import, so each case loads a fresh copy of the module.
async function load(flag: boolean): Promise<typeof import('./e2e')> {
  vi.resetModules()
  const argv = process.argv.filter((a) => a !== '--orcha-e2e')
  vi.spyOn(process, 'argv', 'get').mockReturnValue(flag ? [...argv, '--orcha-e2e'] : argv)
  return import('./e2e')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('e2eEndpoint', () => {
  it('is null without the flag', async () => {
    vi.stubEnv('ORCHA_E2E_OLLAMA_URL', 'http://127.0.0.1:1234')
    const m = await load(false)
    expect(m.e2eEndpoint('ollama')).toBeNull()
  })

  it('returns a loopback address under the flag, without a trailing slash', async () => {
    vi.stubEnv('ORCHA_E2E_ANTHROPIC_URL', 'http://127.0.0.1:4000/')
    const m = await load(true)
    expect(m.e2eEndpoint('anthropic')).toBe('http://127.0.0.1:4000')
    expect(m.e2eEndpoint('azure')).toBeNull()
  })

  it('rejects other hosts, schemes and garbage', async () => {
    const m = await load(true)
    for (const bad of ['http://example.com', 'https://127.0.0.1:1', 'http://localhost:1', 'nope']) {
      vi.stubEnv('ORCHA_E2E_AZURE_URL', bad)
      expect(m.e2eEndpoint('azure')).toBeNull()
    }
  })
})
